import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  fuzzyFilter,
  Input,
  type KeyId,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  type SlashCommand,
  truncateToWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Block, Transcript } from "./transcript.ts";

export type Paint = Pick<Theme, "fg" | "bg" | "bold" | "italic">;

export interface Keys {
  matches(data: string, id: string): boolean;
}

export interface RenderStyle {
  theme: Paint;
  markdown: MarkdownTheme;
  expandTools: boolean;
  showThinking: boolean;
  epoch: number;
}

export interface PickerItem {
  value: string;
  label: string;
  description?: string;
  /** Pinned items sort ahead of the other matches. */
  pinned?: boolean;
}

export interface WindowActions {
  submit(text: string, behavior: "steer" | "followUp"): void;
  abort(): void;
  close(): void;
  unfocus(): void;
  resize(step: number): void;
  toggleMaximize(): void;
  cycleModel(): void;
  cycleThinking(): void;
  pickModel(): void;
}

export interface WindowDeps {
  tui: TUI;
  theme: Paint;
  keys: Keys;
  markdownTheme: MarkdownTheme;
  editorTheme: EditorTheme;
  transcript: Transcript;
  cwd: string;
  toggleKey: string;
  rows(): number;
  busy(): boolean;
  title(): string;
  state(): string;
  note(): string;
  actions: WindowActions;
}

interface Position {
  index: number;
  offset: number;
}

interface Picker {
  input: Input;
  items: PickerItem[];
  filtered: PickerItem[];
  index: number;
  title: string;
  onPick(item: PickerItem): void;
}

const USER_MAX_LINES = 12;
const TOOL_RESULT_LINES = 12;
const TOOL_ERROR_LINES = 4;
const MIN_FRAME_INTERVAL_MS = 50;
const MAX_FRAME_INTERVAL_MS = 500;
const RENDER_COST_FACTOR = 50;
const ANSI_STYLE = /\x1b\[[0-9;]*m/g;

function fit(line: string, width: number): string {
  const visible = visibleWidth(line);
  if (visible === width) return line;
  if (visible < width) return line + " ".repeat(width - visible);
  const cut = truncateToWidth(line, width, "");
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) lines.push(...(line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
  return lines;
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function renderBlock(block: Block, width: number, style: RenderStyle): string[] {
  const { theme } = style;
  switch (block.kind) {
    case "user": {
      const wrapped = wrapPlain(block.text, width - 2);
      const shown = wrapped.slice(0, USER_MAX_LINES).map((line, index) => `${index === 0 ? theme.fg("accent", "❯ ") : "  "}${theme.bold(line)}`);
      if (wrapped.length > USER_MAX_LINES) shown.push(theme.fg("dim", `  … ${wrapped.length - USER_MAX_LINES} more lines`));
      return shown;
    }
    case "text":
      return block.text.trim() ? [...new Markdown(block.text, 0, 0, style.markdown).render(width)] : [];
    case "thinking": {
      if (!block.text.trim()) return [];
      if (!style.showThinking) return [theme.fg("dim", theme.italic(block.streaming ? "thinking…" : "thought"))];
      return [...new Markdown(block.text, 0, 0, style.markdown, { color: (text) => theme.fg("thinkingText", text), italic: true }).render(width)];
    }
    case "tool": {
      const icon = block.status === "ok" ? theme.fg("success", "✓") : block.status === "error" ? theme.fg("error", "✗") : theme.fg("warning", block.status === "running" ? "◐" : "○");
      const time = duration(block.durationMs);
      const header = `${icon} ${theme.fg("toolTitle", theme.bold(block.name))}${block.args ? ` ${theme.fg("muted", block.args)}` : ""}${time ? theme.fg("dim", `  ${time}`) : ""}`;
      const lines = [truncateToWidth(header, width, "…")];
      const limit = style.expandTools ? TOOL_RESULT_LINES : block.status === "error" ? TOOL_ERROR_LINES : 0;
      if (limit > 0 && block.result) {
        const result = block.result.split("\n").filter((line) => line.trim());
        const color = block.status === "error" ? "error" : "toolOutput";
        for (const line of result.slice(0, limit)) lines.push(truncateToWidth(`  ${theme.fg(color, line)}`, width, "…"));
        if (result.length > limit) lines.push(theme.fg("dim", `  … ${result.length - limit} more lines`));
      }
      return lines;
    }
    case "notice": {
      const color = block.level === "error" ? "error" : block.level === "warning" ? "warning" : "dim";
      return wrapPlain(block.text, width).map((line) => theme.fg(color, line));
    }
  }
}

export function blockLines(block: Block, width: number, style: RenderStyle): string[] {
  const key = `${width}:${block.version}:${style.expandTools ? 1 : 0}${style.showThinking ? 1 : 0}:${style.epoch}`;
  if (block.cache?.key === key) return block.cache.lines;
  const lines = renderBlock(block, width, style);
  block.cache = { key, lines };
  return lines;
}

export class SideWindow implements Component, Focusable {
  readonly capturesViewportInput = true;
  readonly editor: Editor;
  renderCostMs = 0;
  rebuilds = 0;
  private readonly deps: WindowDeps;
  private readonly style: RenderStyle;
  private anchor: { id: number; offset: number } | null = null;
  private picker: Picker | null = null;
  private _focused = false;
  private revision = 0;
  private frame: string[] | undefined;
  private frameKey = "";
  private contentWidth = 40;
  private viewRows = 1;
  private frameTimer: NodeJS.Timeout | undefined;
  private lastFrameAt = 0;

  constructor(deps: WindowDeps) {
    this.deps = deps;
    this.style = { theme: deps.theme, markdown: deps.markdownTheme, expandTools: false, showThinking: true, epoch: 0 };
    this.editor = new Editor(deps.tui, deps.editorTheme, { paddingX: 1 });
    this.editor.onSubmit = (text) => {
      if (text) deps.actions.submit(text, "steer");
    };
    this.setCommands([]);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
    if (this.picker) this.picker.input.focused = value;
    this.revision += 1;
  }

  setCommands(commands: SlashCommand[]): void {
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, this.deps.cwd));
  }

  openPicker(title: string, items: PickerItem[], query: string, onPick: (item: PickerItem) => void): void {
    const input = new Input();
    input.focused = this._focused;
    input.setValue(query);
    this.picker = { input, items, filtered: items, index: 0, title, onPick };
    this.filterPicker();
    this.touch();
  }

  touch(): void {
    this.revision += 1;
    this.deps.tui.requestRender();
  }

  /** Transcript updates within one frame interval share a frame. */
  contentChanged(): void {
    if (this.frameTimer) return;
    const interval = Math.min(MAX_FRAME_INTERVAL_MS, Math.max(MIN_FRAME_INTERVAL_MS, this.renderCostMs * RENDER_COST_FACTOR));
    const wait = this.lastFrameAt + interval - performance.now();
    if (wait <= 0) {
      this.deps.tui.requestRender();
      return;
    }
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      this.deps.tui.requestRender();
    }, wait);
    this.frameTimer.unref();
  }

  dispose(): void {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
  }

  invalidate(): void {
    this.style.epoch += 1;
    this.editor.invalidate();
    this.frame = undefined;
  }

  render(width: number): string[] {
    const { deps } = this;
    const rows = deps.rows();
    const inner = Math.max(10, width - 2);
    const editorLines = this.editor.render(inner);
    const title = deps.title();
    const state = deps.state();
    const note = deps.note();
    const key = `${width}:${rows}:${deps.transcript.version}:${this.revision}:${title}\n${state}\n${note}\n${editorLines.join("\n")}`;
    if (this.frame && key === this.frameKey) return this.frame;

    const started = performance.now();
    const { theme } = deps;
    const border = (text: string) => theme.fg(this._focused ? "borderAccent" : "border", text);
    const side = border("│");
    this.contentWidth = Math.max(8, inner - 2);
    this.viewRows = Math.max(1, rows - editorLines.length - 3);
    const body = this.picker ? this.pickerLines(this.contentWidth, this.viewRows) : this.viewport(this.contentWidth, this.viewRows);

    const lines: string[] = [this.topBorder(inner, title, state, border)];
    for (const line of body) lines.push(`${side} ${fit(line, this.contentWidth)} ${side}`);
    for (const line of editorLines) {
      const rule = line.replace(ANSI_STYLE, "").startsWith("─");
      lines.push(`${rule ? border("├") : side}${fit(line, inner)}${rule ? border("┤") : side}`);
    }
    lines.push(`${side}${fit(` ${this.footer(note)}`, inner)}${side}`);
    lines.push(border(`╰${"─".repeat(inner)}╯`));

    this.frame = lines;
    this.frameKey = key;
    this.rebuilds += 1;
    this.lastFrameAt = performance.now();
    this.renderCostMs = this.lastFrameAt - started;
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      if (!this.picker) this.scroll(event.wheelDelta ?? 0);
      return { handled: true };
    }
    if (event.type === "press" && !this._focused) return { focus: true };
    return undefined;
  }

  handleInput(data: string): void {
    const { keys, actions } = this.deps;
    if (this.picker) {
      this.pickerInput(data);
      this.touch();
      return;
    }
    if (matchesKey(data, this.deps.toggleKey as KeyId)) actions.unfocus();
    else if (matchesKey(data, "alt+m")) actions.toggleMaximize();
    else if (matchesKey(data, "alt+=")) actions.resize(1);
    else if (matchesKey(data, "alt+-")) actions.resize(-1);
    else if (keys.matches(data, "tui.select.pageUp")) this.scroll(-Math.max(1, this.viewRows - 1));
    else if (keys.matches(data, "tui.select.pageDown")) this.scroll(Math.max(1, this.viewRows - 1));
    else if (keys.matches(data, "tui.altScreen.top")) this.scrollToTop();
    else if (keys.matches(data, "tui.altScreen.bottom")) this.anchor = null;
    else if (keys.matches(data, "app.model.select")) actions.pickModel();
    else if (keys.matches(data, "app.model.cycleForward")) actions.cycleModel();
    else if (keys.matches(data, "app.thinking.cycle")) actions.cycleThinking();
    else if (keys.matches(data, "app.tools.expand")) this.style.expandTools = !this.style.expandTools;
    else if (keys.matches(data, "app.thinking.toggle")) this.style.showThinking = !this.style.showThinking;
    else if (keys.matches(data, "app.message.followUp")) this.submitFollowUp();
    else if (keys.matches(data, "app.interrupt") && !this.editor.isShowingAutocomplete()) {
      if (this.deps.busy()) actions.abort();
      else actions.close();
    } else if (keys.matches(data, "app.clear") && !this.editor.isShowingAutocomplete()) {
      if (this.editor.getText()) this.editor.setText("");
      else actions.close();
    } else this.editor.handleInput(data);
    this.touch();
  }

  private submitFollowUp(): void {
    const text = this.editor.getExpandedText().trim();
    if (!text) return;
    this.editor.addToHistory(text);
    this.editor.setText("");
    this.deps.actions.submit(text, "followUp");
  }

  private topBorder(inner: number, title: string, state: string, border: (text: string) => string): string {
    const { theme } = this.deps;
    const right = state ? ` ${state} ` : "";
    const left = truncateToWidth(` ${title} `, Math.max(4, inner - visibleWidth(right) - 2), "…");
    const fill = Math.max(0, inner - 1 - visibleWidth(left) - visibleWidth(right) - 1);
    return `${border("╭─")}${theme.fg("accent", theme.bold(left))}${border("─".repeat(fill))}${theme.fg("muted", right)}${border("─╮")}`;
  }

  private footer(note: string): string {
    const { theme, toggleKey } = this.deps;
    const pieces: string[] = [];
    if (note) pieces.push(theme.fg("warning", note));
    if (this.anchor) pieces.push(theme.fg("accent", "scrolled back · ctrl+end follows"));
    pieces.push(theme.fg("dim", `${toggleKey} main · esc ${this.deps.busy() ? "stop" : "close"} · pgup/pgdn scroll · alt+m max · alt+=/- size · /help`));
    return pieces.join(theme.fg("dim", "  │  "));
  }

  private segment(index: number): string[] {
    return blockLines(this.deps.transcript.blocks[index], this.contentWidth, this.style);
  }

  private gap(index: number, lines: string[]): number {
    if (lines.length === 0) return 0;
    const blocks = this.deps.transcript.blocks;
    return blocks[index].kind === "tool" && blocks[index + 1]?.kind === "tool" ? 0 : 1;
  }

  private span(index: number): number {
    const lines = this.segment(index);
    return lines.length + this.gap(index, lines);
  }

  private tail(width: number): string[] {
    const { theme, transcript } = this.deps;
    return transcript.queued.map((text) => theme.fg("dim", truncateToWidth(`⏳ queued: ${text.replace(/\s+/g, " ")}`, width, "…")));
  }

  private viewport(width: number, rows: number): string[] {
    const blocks = this.deps.transcript.blocks;
    const tail = this.tail(width);
    const out: string[] = [];
    const start = this.anchor ? blocks.findIndex((block) => block.id === this.anchor?.id) : -1;
    if (this.anchor && start !== -1) {
      let skip = this.anchor.offset;
      for (let index = start; index < blocks.length && out.length < rows; index++) {
        const lines = this.segment(index);
        const total = lines.length + this.gap(index, lines);
        for (let line = skip; line < total && out.length < rows; line++) out.push(line < lines.length ? lines[line] : "");
        skip = 0;
      }
      for (const line of tail) if (out.length < rows) out.push(line);
      if (out.length >= rows) return out;
      out.length = 0;
    }
    this.anchor = null;
    const chunks: string[][] = [tail];
    let count = tail.length;
    for (let index = blocks.length - 1; index >= 0 && count < rows; index--) {
      const lines = this.segment(index);
      const chunk = this.gap(index, lines) ? [...lines, ""] : lines;
      chunks.push(chunk);
      count += chunk.length;
    }
    for (let index = chunks.length - 1; index >= 0; index--) for (const line of chunks[index]) out.push(line);
    if (out.length > rows) return out.slice(out.length - rows);
    while (out.length < rows) out.push("");
    return out;
  }

  private followTop(): Position {
    const { blocks, queued } = this.deps.transcript;
    const need = this.viewRows - queued.length;
    let count = 0;
    for (let index = blocks.length - 1; index >= 0; index--) {
      count += this.span(index);
      if (count >= need) return { index, offset: count - need };
    }
    return { index: 0, offset: 0 };
  }

  private linesFrom(position: Position, limit: number): number {
    const { blocks, queued } = this.deps.transcript;
    let count = queued.length - position.offset;
    for (let index = position.index; index < blocks.length && count <= limit; index++) count += this.span(index);
    return count;
  }

  private scroll(delta: number): void {
    const blocks = this.deps.transcript.blocks;
    if (blocks.length === 0 || delta === 0 || (delta > 0 && !this.anchor)) return;
    const anchored = this.anchor ? blocks.findIndex((block) => block.id === this.anchor?.id) : -1;
    let { index, offset } = this.anchor && anchored !== -1 ? { index: anchored, offset: this.anchor.offset } : this.followTop();
    if (delta > 0) offset += delta;
    for (let remaining = -delta; remaining > 0; ) {
      if (offset >= remaining) {
        offset -= remaining;
        break;
      }
      remaining -= offset;
      offset = 0;
      if (index === 0) break;
      index -= 1;
      offset = this.span(index);
    }
    while (index < blocks.length - 1 && offset >= this.span(index)) {
      offset -= this.span(index);
      index += 1;
    }
    this.anchor = this.linesFrom({ index, offset }, this.viewRows) <= this.viewRows ? null : { id: blocks[index].id, offset };
    this.touch();
  }

  private scrollToTop(): void {
    const first = this.deps.transcript.blocks[0];
    if (first) this.anchor = { id: first.id, offset: 0 };
  }

  private filterPicker(): void {
    const picker = this.picker;
    if (!picker) return;
    const query = picker.input.getValue().trim();
    const matches = query ? fuzzyFilter(picker.items, query, (item) => `${item.label} ${item.description ?? ""}`) : picker.items;
    picker.filtered = [...matches.filter((item) => item.pinned), ...matches.filter((item) => !item.pinned)];
    picker.index = Math.min(picker.index, Math.max(0, picker.filtered.length - 1));
  }

  private pickerInput(data: string): void {
    const picker = this.picker;
    if (!picker) return;
    const { keys } = this.deps;
    const page = Math.max(1, this.viewRows - 4);
    const last = Math.max(0, picker.filtered.length - 1);
    if (keys.matches(data, "tui.select.cancel")) this.picker = null;
    else if (keys.matches(data, "tui.select.up")) picker.index = picker.index === 0 ? last : picker.index - 1;
    else if (keys.matches(data, "tui.select.down")) picker.index = picker.index === last ? 0 : picker.index + 1;
    else if (keys.matches(data, "tui.select.pageUp")) picker.index = Math.max(0, picker.index - page);
    else if (keys.matches(data, "tui.select.pageDown")) picker.index = Math.min(last, picker.index + page);
    else if (keys.matches(data, "tui.select.confirm")) {
      const item = picker.filtered[picker.index];
      this.picker = null;
      if (item) picker.onPick(item);
    } else {
      picker.input.handleInput(data);
      picker.index = 0;
      this.filterPicker();
    }
  }

  private pickerLines(width: number, rows: number): string[] {
    const picker = this.picker;
    if (!picker) return [];
    const { theme } = this.deps;
    const visible = Math.max(1, rows - 3);
    const start = Math.max(0, Math.min(picker.index - Math.floor(visible / 2), picker.filtered.length - visible));
    const lines = [theme.fg("accent", theme.bold(picker.title)), picker.input.render(width)[0] ?? ""];
    for (let index = start; index < Math.min(picker.filtered.length, start + visible); index++) {
      const item = picker.filtered[index];
      const selected = index === picker.index;
      const text = `${selected ? "→ " : "  "}${item.label}${item.description ? `  ${theme.fg("dim", item.description)}` : ""}${item.pinned ? theme.fg("dim", "  ★") : ""}`;
      lines.push(truncateToWidth(selected ? theme.fg("accent", text) : text, width, "…"));
    }
    if (picker.filtered.length === 0) lines.push(theme.fg("dim", "  No match"));
    while (lines.length < rows - 1) lines.push("");
    lines.push(theme.fg("dim", `${picker.filtered.length ? picker.index + 1 : 0}/${picker.filtered.length} · enter selects · esc cancels`));
    return lines.slice(0, rows);
  }
}
