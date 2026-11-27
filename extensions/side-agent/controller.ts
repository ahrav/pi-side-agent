import { existsSync } from "node:fs";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext, getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type OverlayHandle, type SlashCommand } from "@earendil-works/pi-tui";
import { isMaximized, type ModelRef, overlayOptionsFor, parseDock, parseSize, RESIZE_STEP, resizeLayout, type SideAgentConfig, type WindowLayout, windowRows, writeConfig } from "./layout.ts";
import { MainBridge } from "./main-bridge.ts";
import { type Invocation, launchArgs, piInvocation, type SideExit, SideProcess } from "./process.ts";
import { SESSION_ENTRY_TYPE, SIDE_AGENT_PROMPT } from "./protocol.ts";
import { Transcript } from "./transcript.ts";
import { type Activity, type Keys, type PickerItem, SideWindow, type WindowActions } from "./view.ts";

type Json = Record<string, any>;
type Phase = "stopped" | "starting" | "ready";

export interface ControllerOptions {
  pi: ExtensionAPI;
  config: SideAgentConfig;
  configPath: string;
  sessionDir: string;
  bridgePath: string;
  invocation?(args: string[]): Invocation;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

interface OverlayState {
  handle?: OverlayHandle;
  window?: SideWindow;
  done?: () => void;
  closed?: boolean;
}

export const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Select the side agent's model. Optional search text." },
  { name: "thinking", description: "Show or set the side agent's thinking level." },
  { name: "new", description: "Start a new side session." },
  { name: "size", description: "Resize the window: /size <width%> [height%] | full." },
  { name: "dock", description: "Move the window: /dock center | left | right | top | bottom." },
  { name: "send", description: "Send the side agent's last answer to the main agent. Optional note." },
  { name: "copy", description: "Copy the side agent's last answer to the clipboard." },
  { name: "compact", description: "Compact the side session's context. Optional instructions." },
  { name: "quit", description: "Stop the side agent process and close the window." },
  { name: "help", description: "List side window commands and keys." },
];

const HELP = [
  "Side window commands: /model [search] · /thinking [level] · /new · /size <w%> [h%] | full · /dock <place> · /send [note] · /copy · /compact · /quit.",
  "Any other /command runs in the side agent, including skills and prompt templates.",
  "Keys: enter sends · alt+enter queues a follow-up · esc stops a running turn, then closes · pgup/pgdn scroll · ctrl+end follows output.",
  "Model: the model-select key opens the picker · the model-cycle key cycles · the thinking-cycle key cycles thinking. Tool output: the tool-expand key.",
  "Window: alt+m maximizes or restores · alt+= and alt+- resize.",
].join("\n");

const SAVE_DELAY_MS = 300;
const STDERR_NOTICE_CHARS = 600;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SideAgentController {
  readonly transcript = new Transcript();
  readonly config: SideAgentConfig;
  private readonly options: ControllerOptions;
  private readonly bridge: MainBridge;
  private readonly actions: WindowActions;
  private ctx: ExtensionContext | undefined;
  private process: SideProcess | undefined;
  private phase: Phase = "stopped";
  private ready: Promise<void> = Promise.resolve();
  private overlay: OverlayState | undefined;
  private waiting: Array<{ text: string; behavior: "steer" | "followUp" }> = [];
  private outbox: string[] = [];
  /** A pending prompt RPC keeps the side agent's status at `working…` even when the transcript is idle. */
  private unanswered = 0;
  private activeSince = 0;
  private dialogs: Promise<void> = Promise.resolve();
  private model: ModelRef | undefined;
  private thinking: string | undefined;
  private usage = "";
  private note = "";
  private draft = "";
  private restore: WindowLayout | undefined;
  private commands: SlashCommand[] | undefined;
  private sessionFile: string | undefined;
  private resumeChecked = false;
  private stopping = false;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(options: ControllerOptions) {
    this.options = options;
    this.config = options.config;
    this.bridge = new MainBridge({
      pi: options.pi,
      context: () => this.ctx,
      reply: (reply) => this.process?.reply(reply),
      touch: (ctx) => {
        this.ctx = ctx;
      },
    });
    this.actions = {
      submit: (text, behavior) => this.submit(text, behavior),
      abort: () => this.run(this.rpc({ type: "abort" })),
      close: () => this.close(),
      unfocus: () => this.overlay?.handle?.unfocus(),
      resize: (step) => this.setLayout(resizeLayout(this.config.window, step * RESIZE_STEP)),
      toggleMaximize: () => this.toggleMaximize(),
      cycleModel: () => this.run(this.cycleModel()),
      cycleThinking: () => this.run(this.cycleThinking()),
      pickModel: () => this.run(this.pickModel("")),
    };
  }

  get running(): boolean {
    return this.process?.running === true;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  toggle(ctx: ExtensionContext): void {
    const handle = this.overlay?.handle;
    if (!this.overlay || !handle) this.open(ctx);
    else if (handle.isFocused()) handle.unfocus();
    else this.focus();
  }

  open(ctx: ExtensionContext, prompt?: string): void {
    this.ctx = ctx;
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("The side agent window needs pi's interactive mode.", "error");
      return;
    }
    if (!this.running) this.start(ctx);
    this.show(ctx);
    if (prompt) this.submit(prompt, "steer");
  }

  shutdown(): void {
    this.stopping = true;
    this.close();
    this.process?.stop();
    this.bridge.detach();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      void writeConfig(this.options.configPath, this.config).catch(() => {});
    }
  }

  submit(text: string, behavior: "steer" | "followUp"): void {
    this.note = "";
    if (text.startsWith("/") && this.localCommand(text)) return;
    if (!this.running && this.ctx) this.start(this.ctx);
    if (this.phase !== "ready") {
      this.waiting.push({ text, behavior });
      this.outbox.push(text);
      this.refresh();
      return;
    }
    this.prompt(text, behavior);
  }

  private start(ctx: ExtensionContext): void {
    const { options } = this;
    const sessionFile = this.resumeFile(ctx);
    const args = launchArgs({ bridgePath: options.bridgePath, sessionDir: options.sessionDir, sessionFile, trusted: ctx.isProjectTrusted(), systemPrompt: SIDE_AGENT_PROMPT });
    const process = new SideProcess({
      invocation: (options.invocation ?? piInvocation)([...args, ...(options.extraArgs ?? [])]),
      cwd: ctx.cwd,
      env: options.env,
      onRecord: (record) => this.onRecord(process, record),
      onBridge: (message) => this.bridge.handle(message),
      onExit: (exit) => this.onExit(process, exit),
    });
    this.process = process;
    this.phase = "starting";
    this.stopping = false;
    this.usage = "";
    process.start();
    this.bridge.attach();
    this.ready = this.initialize(process, ctx, sessionFile !== undefined).catch((error) => {
      if (process === this.process && process.running) this.transcript.notice("error", `The side agent failed to start: ${errorText(error)}`);
      this.refresh();
    });
  }

  private async initialize(process: SideProcess, ctx: ExtensionContext, resumed: boolean): Promise<void> {
    let state: Json = await process.request({ type: "get_state" });
    if (resumed) {
      if (this.transcript.blocks.length === 0) this.transcript.load((await process.request({ type: "get_messages" })).messages ?? []);
    } else {
      await this.selectStartModel(process, ctx, state);
      state = await process.request({ type: "get_state" });
    }
    if (process !== this.process) return;
    this.recordSession(state.sessionFile);
    this.adoptState(state);
    this.phase = "ready";
    for (const { text, behavior } of this.waiting.splice(0)) this.prompt(text, behavior);
    this.refresh();
    this.run(this.loadCommands(process));
  }

  private async loadCommands(process: SideProcess): Promise<void> {
    const result: Json | undefined = await process.request({ type: "get_commands" }).catch(() => undefined);
    if (!result || process !== this.process) return;
    this.commands = [...LOCAL_COMMANDS, ...(result.commands ?? []).map((command: Json) => ({ name: command.name, description: command.description }))];
    this.overlay?.window?.setCommands(this.commands);
  }

  private async selectStartModel(process: SideProcess, ctx: ExtensionContext, state: Json): Promise<void> {
    const wanted = this.config.model ?? (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
    if (wanted && (state.model?.provider !== wanted.provider || state.model?.id !== wanted.id)) {
      await process.request({ type: "set_model", provider: wanted.provider, modelId: wanted.id }).catch((error) => {
        this.transcript.notice("warning", `Could not select ${wanted.provider}/${wanted.id}: ${errorText(error)}`);
      });
    }
    const level = this.config.thinkingLevel ?? this.options.pi.getThinkingLevel();
    if (level) await process.request({ type: "set_thinking_level", level }).catch(() => {});
  }

  private adoptState(state: Json): void {
    if (state.model?.provider && state.model?.id) this.model = { provider: state.model.provider, id: state.model.id };
    if (typeof state.thinkingLevel === "string") this.thinking = state.thinkingLevel;
  }

  private recordSession(file: unknown): void {
    if (typeof file !== "string" || file === this.sessionFile) return;
    this.sessionFile = file;
    this.options.pi.appendEntry(SESSION_ENTRY_TYPE, { file });
  }

  private resumeFile(ctx: ExtensionContext): string | undefined {
    if (!this.resumeChecked) {
      this.resumeChecked = true;
      const branch = ctx.sessionManager.getBranch() as Json[];
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry.type === "custom" && entry.customType === SESSION_ENTRY_TYPE && typeof entry.data?.file === "string") {
          this.sessionFile = entry.data.file;
          break;
        }
      }
    }
    return this.sessionFile && existsSync(this.sessionFile) ? this.sessionFile : undefined;
  }

  private onRecord(process: SideProcess, record: Json): void {
    if (process !== this.process) return;
    if (record.type === "extension_ui_request") {
      this.uiRequest(process, record);
      return;
    }
    if (record.type === "thinking_level_changed" && typeof record.level === "string") this.thinking = record.level;
    if (this.outbox.length > 0) this.settleOutbox(record);
    const version = this.transcript.version;
    this.transcript.apply(record);
    this.stamp();
    if (record.type === "agent_settled") {
      this.run(this.refreshUsage(process));
      if (this.overlay?.handle?.isFocused() !== true && this.ctx?.hasUI) this.ctx.ui.notify(`Side agent finished. ${this.config.toggleKey} opens it.`, "info");
      this.refresh();
    } else if (record.type === "agent_start" || record.type === "thinking_level_changed") this.refresh();
    else if (this.transcript.version !== version) this.overlay?.window?.contentChanged();
  }

  private settleOutbox(record: Json): void {
    if (record.type === "message_start" && record.message?.role === "user") this.outbox.shift();
    else if (record.type === "queue_update") {
      const queued = new Set([...(record.steering ?? []), ...(record.followUp ?? [])]);
      this.outbox = this.outbox.filter((text) => !queued.has(text));
    } else if (record.type === "agent_settled") this.outbox = [];
  }

  private onExit(process: SideProcess, exit: SideExit): void {
    if (process !== this.process) return;
    this.process = undefined;
    this.phase = "stopped";
    this.waiting = [];
    this.outbox = [];
    this.bridge.detach();
    this.transcript.apply({ type: "agent_settled" });
    if (!this.stopping) {
      const reason = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      const detail = exit.stderr.trim().slice(-STDERR_NOTICE_CHARS);
      this.transcript.notice("error", `The side agent process exited (${reason}).${detail ? `\n${detail}` : ""}\nSend a message to restart it.`);
    }
    this.refresh();
  }

  private uiRequest(process: SideProcess, request: Json): void {
    if (request.method === "notify") {
      if (request.notifyType === "warning" || request.notifyType === "error") {
        this.note = String(request.message ?? "").replace(/\s+/g, " ").slice(0, 200);
        this.refresh();
      }
      return;
    }
    this.dialogs = this.dialogs.then(() => this.dialog(process, request)).catch(() => {});
  }

  private async dialog(process: SideProcess, request: Json): Promise<void> {
    const respond = (payload: Json) => process.write({ type: "extension_ui_response", id: request.id, ...payload });
    const ctx = this.ctx;
    if (!ctx?.hasUI || process !== this.process) {
      respond({ cancelled: true });
      return;
    }
    const overlay = this.overlay;
    const handle = overlay?.handle;
    const visible = handle !== undefined && !handle.isHidden();
    if (visible) handle.setHidden(true);
    const title = `[side agent] ${request.title ?? ""}`;
    const options = typeof request.timeout === "number" ? { timeout: request.timeout } : undefined;
    try {
      if (request.method === "confirm") respond({ confirmed: await ctx.ui.confirm(title, String(request.message ?? ""), options) });
      else {
        let value: string | undefined;
        if (request.method === "select") value = await ctx.ui.select(title, Array.isArray(request.options) ? request.options : [], options);
        else if (request.method === "input") value = await ctx.ui.input(title, request.placeholder, options);
        else if (request.method === "editor") value = await ctx.ui.editor(title, request.prefill);
        respond(value === undefined ? { cancelled: true } : { value });
      }
    } catch {
      respond({ cancelled: true });
    } finally {
      if (visible && this.overlay === overlay) {
        handle.setHidden(false);
        handle.focus();
      }
    }
  }

  private prompt(text: string, behavior: "steer" | "followUp"): void {
    this.unanswered += 1;
    this.refresh();
    this.run(
      this.rpc({ type: "prompt", message: text, streamingBehavior: behavior })
        .then((accepted) => {
          if (!accepted) this.outbox = [];
        })
        .finally(() => {
          this.unanswered -= 1;
          this.refresh();
        }),
    );
  }

  private run(task: Promise<unknown>): void {
    task.catch((error) => {
      this.transcript.notice("error", errorText(error));
      this.refresh();
    });
  }

  private busy(): boolean {
    return this.transcript.busy || this.unanswered > 0 || this.waiting.length > 0;
  }

  private async rpc(command: Json): Promise<Json | undefined> {
    try {
      await this.ready;
      if (!this.process) throw new Error("The side agent process is not running.");
      return (await this.process.request(command)) ?? {};
    } catch (error) {
      this.transcript.notice("error", errorText(error));
      this.refresh();
      return undefined;
    }
  }

  private async refreshUsage(process: SideProcess): Promise<void> {
    const stats: Json | undefined = await process.request({ type: "get_session_stats" }).catch(() => undefined);
    if (!stats || process !== this.process) return;
    const percent = stats.contextUsage?.percent;
    const pieces: string[] = [];
    if (typeof percent === "number") pieces.push(`ctx ${Math.round(percent)}%`);
    if (typeof stats.cost === "number" && stats.cost > 0) pieces.push(`$${stats.cost.toFixed(2)}`);
    this.usage = pieces.join(" · ");
    this.refresh();
  }

  private localCommand(text: string): boolean {
    const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match || !LOCAL_COMMANDS.some((command) => command.name === match[1])) return false;
    const args = (match[2] ?? "").trim();
    switch (match[1]) {
      case "help":
        this.transcript.notice("info", HELP);
        break;
      case "model":
        this.run(this.pickModel(args));
        break;
      case "thinking":
        this.run(this.setThinking(args));
        break;
      case "new":
        this.run(this.newSession());
        break;
      case "size":
        this.applyLayout(parseSize(args, this.config.window));
        break;
      case "dock":
        this.applyLayout(parseDock(args));
        break;
      case "send":
        this.sendToMain(args);
        break;
      case "copy":
        this.run(this.copyAnswer());
        break;
      case "compact":
        this.run(this.rpc(args ? { type: "compact", customInstructions: args } : { type: "compact" }));
        break;
      case "quit":
        this.stopping = true;
        this.process?.stop();
        this.close();
        break;
    }
    this.refresh();
    return true;
  }

  private applyLayout(layout: WindowLayout | string): void {
    if (typeof layout === "string") this.transcript.notice("warning", layout);
    else this.setLayout(layout);
  }

  private setLayout(layout: WindowLayout): void {
    const previous = this.config.window;
    this.config.window = layout;
    this.restore = undefined;
    this.saveSoon();
    if (this.overlay && this.ctx && (previous.dock !== layout.dock || previous.width !== layout.width)) this.reopen(this.ctx);
    else this.refresh();
  }

  /** pi resolves an overlay's width and anchor when the overlay is shown, so a change to either needs a new overlay. */
  private reopen(ctx: ExtensionContext): void {
    const focused = this.overlay?.handle?.isFocused() ?? true;
    this.close();
    this.show(ctx, focused);
  }

  private toggleMaximize(): void {
    const current = this.config.window;
    if (isMaximized(current) && this.restore) {
      this.setLayout(this.restore);
      return;
    }
    this.setLayout({ dock: current.dock, width: 100, height: 100 });
    this.restore = current;
  }

  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void writeConfig(this.options.configPath, this.config).catch(() => {});
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private sendToMain(note: string): void {
    const answer = this.transcript.lastAnswer();
    if (!answer) {
      this.transcript.notice("warning", "The side agent has no answer to send yet.");
      return;
    }
    try {
      const { summary } = this.bridge.deliver({ message: note ? `${note}\n\n${answer}` : answer });
      this.transcript.notice("info", `Sent the last answer to the main agent. ${summary}`);
    } catch (error) {
      this.transcript.notice("error", errorText(error));
    }
  }

  private async copyAnswer(): Promise<void> {
    const answer = this.transcript.lastAnswer();
    if (!answer) this.transcript.notice("warning", "The side agent has no answer to copy yet.");
    else {
      await copyToClipboard(answer).then(
        () => this.transcript.notice("info", "Copied the last answer."),
        (error) => this.transcript.notice("error", `Copy failed: ${errorText(error)}`),
      );
    }
    this.refresh();
  }

  /** The side agent preserves its model and thinking level selections across session changes. */
  private async newSession(): Promise<void> {
    const result = await this.rpc({ type: "new_session" });
    if (!result || result.cancelled) return;
    this.transcript.clear();
    this.outbox = [];
    this.usage = "";
    if (this.model) await this.rpc({ type: "set_model", provider: this.model.provider, modelId: this.model.id });
    if (this.thinking) await this.rpc({ type: "set_thinking_level", level: this.thinking });
    const state = await this.rpc({ type: "get_state" });
    if (state) {
      this.adoptState(state);
      this.recordSession(state.sessionFile);
    }
    this.transcript.notice("info", "Started a new side session.");
    this.refresh();
  }

  private async pickModel(query: string): Promise<void> {
    const result = await this.rpc({ type: "get_available_models" });
    const models: Json[] = result?.models ?? [];
    if (models.length === 0) return;
    const scoped = new Set((this.ctx?.scopedModels ?? []).map((entry) => `${entry.model.provider}/${entry.model.id}`));
    const items: PickerItem[] = models.map((model, index) => {
      const label = `${model.provider}/${model.id}`;
      return { value: String(index), label, description: model.name && model.name !== model.id ? model.name : undefined, pinned: scoped.has(label) };
    });
    const choose = (item: PickerItem) => this.run(this.setModel({ provider: models[Number(item.value)].provider, id: models[Number(item.value)].id }));
    const matches = query ? fuzzyFilter(items, query, (item) => item.label) : [];
    const exact = items.find((item) => item.label === query) ?? (matches.length === 1 ? matches[0] : undefined);
    if (exact) choose(exact);
    else if (this.overlay?.window) this.overlay.window.openPicker("Side agent model", items, query, choose);
  }

  private async setModel(model: ModelRef): Promise<void> {
    if (!(await this.rpc({ type: "set_model", provider: model.provider, modelId: model.id }))) return;
    const state = await this.rpc({ type: "get_state" });
    if (state) this.adoptState(state);
    this.rememberModel();
  }

  private async cycleModel(): Promise<void> {
    const result = await this.rpc({ type: "cycle_model" });
    if (!result?.model) {
      if (result) this.note = "Only one model is available to cycle.";
      this.refresh();
      return;
    }
    this.adoptState({ model: result.model, thinkingLevel: result.thinkingLevel });
    this.rememberModel();
  }

  private rememberModel(): void {
    this.config.model = this.model;
    this.config.thinkingLevel = this.thinking;
    this.saveSoon();
    this.refresh();
  }

  private async cycleThinking(): Promise<void> {
    const result = await this.rpc({ type: "cycle_thinking_level" });
    if (typeof result?.level === "string") {
      this.thinking = result.level;
      this.rememberModel();
    } else if (result) {
      this.note = "This model has no thinking levels.";
      this.refresh();
    }
  }

  private async setThinking(level: string): Promise<void> {
    if (!level) {
      const result = await this.rpc({ type: "get_available_thinking_levels" });
      if (result) this.transcript.notice("info", `Thinking level: ${this.thinking ?? "unknown"}. Available: ${(result.levels ?? []).join(", ")}.`);
    } else if (await this.rpc({ type: "set_thinking_level", level })) {
      const state = await this.rpc({ type: "get_state" });
      if (state) this.adoptState(state);
      this.rememberModel();
    }
    this.refresh();
  }

  private title(): string {
    const model = this.model ? `${this.model.provider}/${this.model.id}` : "";
    return ["side agent", model, this.thinking && this.thinking !== "off" ? this.thinking : ""].filter(Boolean).join(" · ");
  }

  private stateText(): string {
    let state = this.busy() || this.transcript.active ? "working…" : "idle";
    if (this.phase === "starting") state = this.waiting.length > 0 ? `starting… ${this.waiting.length} queued` : "starting…";
    else if (this.phase === "stopped") state = "stopped";
    return this.usage ? `${state} · ${this.usage}` : state;
  }

  private activity(): Activity | undefined {
    const label = this.phase === "starting" ? "Starting the side agent…" : this.transcript.activity() || (this.unanswered > 0 ? "Sending…" : "");
    return label ? { label, since: this.activeSince || performance.now() } : undefined;
  }

  /** `activeSince` holds the time the side agent last went from idle to active, and 0 while it is idle. */
  private stamp(): void {
    if (this.phase !== "starting" && this.unanswered === 0 && !this.transcript.active) this.activeSince = 0;
    else if (this.activeSince === 0) this.activeSince = performance.now();
  }

  private refresh(): void {
    this.stamp();
    this.overlay?.window?.touch();
  }

  private focus(): void {
    const handle = this.overlay?.handle;
    if (!handle) return;
    handle.setHidden(false);
    handle.focus();
    this.refresh();
  }

  private close(): void {
    const overlay = this.overlay;
    if (!overlay) return;
    this.overlay = undefined;
    overlay.closed = true;
    if (overlay.window) this.draft = overlay.window.editor.getText();
    overlay.done?.();
  }

  private show(ctx: ExtensionContext, focus = true): void {
    if (this.overlay) {
      this.focus();
      return;
    }
    const overlay: OverlayState = {};
    this.overlay = overlay;
    ctx.ui
      .custom<void>(
        (tui, theme, keybindings, done) => {
          overlay.done = () => done();
          const window = new SideWindow({
            tui,
            theme,
            keys: keybindings as unknown as Keys,
            markdownTheme: getMarkdownTheme(),
            editorTheme: { borderColor: (text) => theme.fg("border", text), selectList: getSelectListTheme() },
            transcript: this.transcript,
            cwd: ctx.cwd,
            toggleKey: this.config.toggleKey,
            rows: () => windowRows(tui.terminal.rows, this.config.window),
            busy: () => this.busy(),
            activity: () => this.activity(),
            outbox: () => this.outbox,
            title: () => this.title(),
            state: () => this.stateText(),
            note: () => this.note,
            actions: this.actions,
          });
          overlay.window = window;
          window.focused = focus;
          window.setCommands(this.commands ?? LOCAL_COMMANDS);
          if (this.draft) window.editor.setText(this.draft);
          if (overlay.closed) done();
          return window;
        },
        {
          overlay: true,
          overlayOptions: overlayOptionsFor(this.config.window),
          onHandle: (handle) => {
            overlay.handle = handle;
            if (overlay.closed) overlay.done?.();
            else if (focus) handle.focus();
          },
        },
      )
      .catch((error) => {
        if (ctx.hasUI) ctx.ui.notify(`Side agent window failed: ${errorText(error)}`, "error");
      })
      .finally(() => {
        if (this.overlay === overlay) this.overlay = undefined;
      });
  }
}
