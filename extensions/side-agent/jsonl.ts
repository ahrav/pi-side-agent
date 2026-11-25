const LF = 0x0a;
const CR = 0x0d;

export const HEAD_BYTES = 512;

const UNDECIDED = 0;
const KEEP = 1;
const SKIP = 2;

export interface ReaderStats {
  bytes: number;
  lines: number;
  delivered: number;
  skipped: number;
  deliveredBytes: number;
}

/**
 * Splits a byte stream into LF-terminated lines and classifies each line from at most HEAD_BYTES
 * leading bytes. When `wants` rejects a line, `JsonlReader` releases any buffered prefix and skips the
 * remaining bytes through LF.
 */
export class JsonlReader {
  readonly stats: ReaderStats = { bytes: 0, lines: 0, delivered: 0, skipped: 0, deliveredBytes: 0 };
  private readonly wants: (head: string) => boolean;
  private readonly onLine: (line: string) => void;
  private parts: Buffer[] = [];
  private partsLength = 0;
  private mode: typeof UNDECIDED | typeof KEEP | typeof SKIP = UNDECIDED;

  /**
   * `wants` receives up to HEAD_BYTES leading bytes of a line decoded as latin1. Returning `true`
   * selects the line for delivery. `onLine` receives each selected nonempty line decoded as UTF-8,
   * without its LF or CRLF terminator.
   */
  constructor(wants: (head: string) => boolean, onLine: (line: string) => void) {
    this.wants = wants;
    this.onLine = onLine;
  }

  get bufferedBytes(): number {
    return this.partsLength;
  }

  push(chunk: Buffer): void {
    this.stats.bytes += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(LF, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (this.mode !== SKIP) {
        const segment = chunk.subarray(offset, end);
        if (this.mode === UNDECIDED && (newline !== -1 || this.partsLength + segment.length >= HEAD_BYTES)) {
          this.mode = this.wants(this.head(segment)) ? KEEP : SKIP;
          if (this.mode === SKIP) this.dropParts();
        }
        if (this.mode !== SKIP && segment.length > 0) {
          this.parts.push(segment);
          this.partsLength += segment.length;
        }
      }
      if (newline === -1) return;
      this.endLine();
      offset = newline + 1;
    }
  }

  private head(segment: Buffer): string {
    if (this.parts.length === 0) return segment.toString("latin1", 0, Math.min(segment.length, HEAD_BYTES));
    const length = Math.min(this.partsLength + segment.length, HEAD_BYTES);
    return Buffer.concat([...this.parts, segment], length).toString("latin1", 0, length);
  }

  private endLine(): void {
    this.stats.lines += 1;
    const whole = this.mode !== KEEP || this.partsLength === 0 ? undefined : this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partsLength);
    this.dropParts();
    this.mode = UNDECIDED;
    const length = whole === undefined ? 0 : whole[whole.length - 1] === CR ? whole.length - 1 : whole.length;
    if (whole === undefined || length === 0) {
      this.stats.skipped += 1;
      return;
    }
    this.stats.delivered += 1;
    this.stats.deliveredBytes += length;
    this.onLine(whole.toString("utf8", 0, length));
  }

  private dropParts(): void {
    this.parts = [];
    this.partsLength = 0;
  }
}

const TYPE_HEAD = /^\{"type":"([a-z_]+)"/;
const MESSAGE_HEAD = /^\{"type":"message_(start|end)","message":\{"role":"([A-Za-z]+)"/;
const UI_HEAD = /^\{"type":"extension_ui_request","id":"[^"]*","method":"([A-Za-z_]+)"/;
const DELTA_TYPE = /"assistantMessageEvent":\{"type":"([a-z_]+)"/;

const SKIPPED_TYPES = new Set(["agent_end", "turn_start", "turn_end", "tool_execution_update", "entry_appended", "bash_execution_update"]);
const SKIPPED_UI_METHODS = new Set(["setStatus", "setWidget", "setTitle", "set_editor_text"]);
const SKIPPED_DELTAS = new Set(["text_end", "thinking_end", "toolcall_delta", "toolcall_end"]);

/** `wantsRecord` classifies pi RPC records by their line heads. */
export function wantsRecord(head: string): boolean {
  const type = TYPE_HEAD.exec(head)?.[1];
  if (type === undefined) return head.length > 0;
  if (SKIPPED_TYPES.has(type)) return false;
  if (type === "message_update") {
    const delta = DELTA_TYPE.exec(head)?.[1];
    return delta === undefined || !SKIPPED_DELTAS.has(delta);
  }
  if (type === "message_start" || type === "message_end") {
    const message = MESSAGE_HEAD.exec(head);
    if (!message) return true;
    const role = message[2];
    if (role === "assistant") return true;
    if (role === "user" || role === "custom") return message[1] === "start";
    return false;
  }
  if (type === "extension_ui_request") {
    const method = UI_HEAD.exec(head)?.[1];
    return method === undefined || !SKIPPED_UI_METHODS.has(method);
  }
  return true;
}
