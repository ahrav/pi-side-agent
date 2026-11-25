import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { matchesKey } from "@earendil-works/pi-tui";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const cli = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
export const bridgePath = path.join(root, "extensions/side-agent/child.ts");
export const providerPath = path.join(root, "tests/support/scripted-provider.mjs");

export const KEY = {
  enter: "\r",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  ctrlHome: "\x1b[1;5H",
  ctrlEnd: "\x1b[1;5F",
  ctrlC: "\x03",
  ctrlL: "\x0c",
  ctrlO: "\x0f",
  ctrlP: "\x10",
  ctrlT: "\x14",
  shiftTab: "\x1b[Z",
  altEnter: "\x1b\r",
  altA: "\x1ba",
  altM: "\x1bm",
  altPlus: "\x1b=",
  altMinus: "\x1b-",
};

const KEY_TABLE = {
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "tui.select.pageUp": ["pageUp"],
  "tui.select.pageDown": ["pageDown"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.altScreen.top": ["ctrl+home"],
  "tui.altScreen.bottom": ["ctrl+end"],
  "app.model.select": ["ctrl+l"],
  "app.model.cycleForward": ["ctrl+p"],
  "app.thinking.cycle": ["shift+tab"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.tools.expand": ["ctrl+o"],
  "app.message.followUp": ["alt+enter"],
  "app.interrupt": ["escape"],
  "app.clear": ["ctrl+c"],
};

/** pi's default key assignments for the actions the side window reads. */
export const keys = { matches: (data, id) => (KEY_TABLE[id] ?? []).some((key) => matchesKey(data, key)) };

const plain = (text) => text;
export const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: plain, italic: plain };
export const markdownTheme = {
  heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain, codeBlockBorder: plain, quote: plain, quoteBorder: plain,
  hr: plain, listBullet: plain, bold: plain, italic: plain, strikethrough: plain, underline: plain,
};
export const editorTheme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };

export function fakeTui(rows = 40, columns = 120) {
  return { renders: 0, requestRender() { this.renders += 1; }, terminal: { rows, columns } };
}

export function tempDir(t, prefix = "side-agent-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Arguments and environment that run the repository's pi with only the bridge and the scripted provider loaded. */
export function scriptedPi(home, script, extraEnv = {}) {
  const { SIDE_SCRIPT, SIDE_REQUEST_LOG, PI_SIDE_AGENT_CHILD, ...inherited } = process.env;
  return {
    invocation: (args) => ({ command: process.execPath, args: [cli, ...args] }),
    extraArgs: ["-ne", "-ns", "-np", "--no-themes", "-e", providerPath, "--model", "scripted/script", "--models", "scripted/script,scripted/script-2"],
    env: { ...inherited, HOME: home, PI_OFFLINE: "1", SIDE_SCRIPT: JSON.stringify(script), SIDE_REQUEST_LOG: path.join(home, "requests.jsonl"), ...extraEnv },
    requests: () => fs.readFileSync(path.join(home, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

export async function until(condition, { timeoutMs = 20_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A stand-in for pi's ExtensionAPI that records what the extension registers and sends. */
export function fakePi() {
  const pi = {
    handlers: new Map(),
    commands: new Map(),
    shortcuts: new Map(),
    renderers: new Map(),
    tools: new Map(),
    messages: [],
    entries: [],
    thinking: "off",
    on(event, handler) {
      const list = pi.handlers.get(event) ?? [];
      list.push(handler);
      pi.handlers.set(event, list);
      return () => list.splice(list.indexOf(handler), 1);
    },
    emit(event, payload, ctx) {
      for (const handler of [...(pi.handlers.get(event) ?? [])]) handler(payload, ctx);
    },
    listeners: (event) => (pi.handlers.get(event) ?? []).length,
    registerCommand: (name, options) => pi.commands.set(name, options),
    registerShortcut: (key, options) => pi.shortcuts.set(key, options),
    registerMessageRenderer: (type, renderer) => pi.renderers.set(type, renderer),
    registerTool: (tool) => pi.tools.set(tool.name, tool),
    sendMessage: (message, options) => pi.messages.push({ message, options }),
    appendEntry: (customType, data) => pi.entries.push({ type: "custom", customType, data }),
    getThinkingLevel: () => pi.thinking,
  };
  return pi;
}

/** A stand-in for an interactive ExtensionContext. `ui.custom` shows one overlay at a time through a fake handle. */
export function fakeContext({ cwd, branch = [], idle = true, rows = 40, columns = 120 } = {}) {
  const tui = fakeTui(rows, columns);
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    idle,
    branch,
    model: undefined,
    scopedModels: [],
    tui,
    overlays: [],
    notes: [],
    dialogs: [],
    answers: { select: undefined, confirm: false, input: undefined, editor: undefined },
    isIdle: () => ctx.idle,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
    sessionManager: { getBranch: () => ctx.branch, getLeafId: () => ctx.branch.at(-1)?.id ?? null, getSessionName: () => undefined },
    ui: {
      notify: (message, level) => ctx.notes.push([level, message]),
      select: async (title, options) => { ctx.dialogs.push(["select", title, options]); return ctx.answers.select; },
      confirm: async (title, message) => { ctx.dialogs.push(["confirm", title, message]); return ctx.answers.confirm; },
      input: async (title) => { ctx.dialogs.push(["input", title]); return ctx.answers.input; },
      editor: async (title) => { ctx.dialogs.push(["editor", title]); return ctx.answers.editor; },
      custom: (factory, options) => new Promise((resolve) => {
        const entry = { options, focused: false, hidden: false, closed: false };
        const done = (value) => {
          if (entry.closed) return;
          entry.closed = true;
          ctx.overlays.splice(ctx.overlays.indexOf(entry), 1);
          entry.component?.dispose?.();
          resolve(value);
        };
        entry.handle = {
          focus() { entry.focused = true; if (entry.component) entry.component.focused = true; },
          unfocus() { entry.focused = false; if (entry.component) entry.component.focused = false; },
          isFocused: () => entry.focused,
          setHidden(hidden) { entry.hidden = hidden; },
          isHidden: () => entry.hidden,
        };
        entry.component = factory(tui, theme, keys, done);
        if (entry.closed) return;
        ctx.overlays.push(entry);
        options.onHandle?.(entry.handle);
      }),
    },
  };
  return ctx;
}
