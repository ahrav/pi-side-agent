export type NoticeLevel = "info" | "warning" | "error";
export type ToolStatus = "pending" | "running" | "ok" | "error";

interface BlockBase {
  id: number;
  /** Content changes must increment `version`. */
  version: number;
  cache?: { key: string; lines: string[] };
}

export interface UserBlock extends BlockBase {
  kind: "user";
  text: string;
}

export interface ProseBlock extends BlockBase {
  kind: "text" | "thinking";
  text: string;
  streaming: boolean;
}

export interface ToolBlock extends BlockBase {
  kind: "tool";
  callId: string;
  name: string;
  args: string;
  status: ToolStatus;
  durationMs?: number;
  result: string;
}

export interface NoticeBlock extends BlockBase {
  kind: "notice";
  level: NoticeLevel;
  text: string;
}

export type Block = UserBlock | ProseBlock | ToolBlock | NoticeBlock;

type Json = Record<string, any>;

const PREVIEW_CHARS = 160;
const RESULT_CHARS = 4000;
const NOTICE_CHARS = 2000;
const PREFERRED_ARG_KEYS = ["command", "path", "file_path", "query", "url", "pattern", "message", "prompt", "task"];

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function oneLine(text: string): string {
  return clip(text.slice(0, PREVIEW_CHARS * 4).replace(/\s+/g, " ").trim(), PREVIEW_CHARS);
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(clip(value, 60));
  if (value === null || typeof value !== "object") return String(value);
  return Array.isArray(value) ? `[${value.length}]` : "{…}";
}

export function argsPreview(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return oneLine(String(args));
  const record = args as Record<string, unknown>;
  for (const key of PREFERRED_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return oneLine(value);
  }
  const pieces: string[] = [];
  let length = 0;
  for (const key in record) {
    const piece = `${key}=${compactValue(record[key])}`;
    pieces.push(piece);
    length += piece.length + 1;
    if (length >= PREVIEW_CHARS) break;
  }
  return oneLine(pieces.join(" "));
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") pieces.push(part.text);
    else if (part?.type === "image") pieces.push("[image]");
  }
  return pieces.join("\n");
}

export class Transcript {
  readonly blocks: Block[] = [];
  version = 0;
  busy = false;
  queued: string[] = [];
  private nextId = 1;
  /** `parts` maps content indices in the streaming assistant message to blocks. */
  private readonly parts = new Map<number, ProseBlock | ToolBlock>();
  private readonly tools = new Map<string, ToolBlock>();
  /** `executing` maps running tool call IDs to tool names. */
  private readonly executing = new Map<string, string>();
  /** `part` labels the content part the model is streaming. */
  private part = "";
  private retrying = "";
  private compacting = false;

  get active(): boolean {
    return this.busy || this.compacting;
  }

  /** `activity` names the step in progress while `active` is true, and is empty otherwise. */
  activity(): string {
    if (this.compacting) return "Compacting context…";
    if (!this.busy) return "";
    if (this.executing.size > 1) return `Running ${this.executing.size} tools…`;
    for (const name of this.executing.values()) return `Running ${name}…`;
    return this.retrying || this.part || "Waiting for the model…";
  }

  apply(record: Json): void {
    switch (record.type) {
      case "agent_start":
        this.busy = true;
        this.part = "";
        this.version += 1;
        return;
      case "agent_settled":
        this.busy = false;
        this.executing.clear();
        this.part = "";
        this.retrying = "";
        this.endStreaming();
        this.version += 1;
        return;
      case "message_start":
        return this.messageStart(record.message ?? {});
      case "message_update":
        return this.messageUpdate(record.assistantMessageEvent ?? {});
      case "message_end":
        if (record.message?.role === "assistant") this.assistantEnd(record.message);
        return;
      case "tool_execution_start": {
        const tool = this.tool(record.toolCallId, record.toolName);
        tool.status = "running";
        if (!tool.args) tool.args = argsPreview(record.args);
        this.executing.set(tool.callId, tool.name);
        return this.bump(tool);
      }
      case "tool_execution_end": {
        const tool = this.tool(record.toolCallId, record.toolName);
        tool.status = record.isError ? "error" : "ok";
        tool.durationMs = typeof record.durationMs === "number" ? record.durationMs : undefined;
        tool.result = clip(contentText(record.result?.content).trimEnd(), RESULT_CHARS);
        this.executing.delete(tool.callId);
        return this.bump(tool);
      }
      case "queue_update":
        this.queued = [...(record.steering ?? []), ...(record.followUp ?? [])].map(String);
        this.version += 1;
        return;
      case "auto_retry_start":
        this.retrying = `Retrying (${record.attempt}/${record.maxAttempts})…`;
        return this.notice("warning", `Retry ${record.attempt}/${record.maxAttempts} in ${Math.round((record.delayMs ?? 0) / 1000)}s: ${record.errorMessage ?? "request failed"}`);
      case "auto_retry_end":
        this.retrying = "";
        if (record.success === false) this.notice("error", record.finalError ?? "Retries failed.");
        return;
      case "compaction_start":
        this.compacting = true;
        return this.notice("info", `Compacting context (${record.reason}).`);
      case "compaction_end":
        this.compacting = false;
        if (record.errorMessage) this.notice("error", `Compaction failed: ${record.errorMessage}`);
        else this.notice("info", record.aborted ? "Compaction aborted." : "Context compacted.");
        return;
      case "extension_error":
        return this.notice("warning", `Extension error in ${record.event ?? "handler"}: ${record.error ?? "unknown"}`);
    }
  }

  notice(level: NoticeLevel, text: string): void {
    this.blocks.push({ kind: "notice", id: this.nextId++, version: 0, level, text: clip(text, NOTICE_CHARS) });
    this.version += 1;
  }

  clear(): void {
    this.blocks.length = 0;
    this.parts.clear();
    this.tools.clear();
    this.executing.clear();
    this.part = "";
    this.retrying = "";
    this.compacting = false;
    this.queued = [];
    this.busy = false;
    this.version += 1;
  }

  load(messages: readonly Json[]): void {
    for (const message of messages) {
      if (message.role === "assistant") this.assistantEnd(message);
      else if (message.role === "toolResult") {
        const tool = this.tools.get(message.toolCallId);
        if (!tool) continue;
        tool.status = message.isError ? "error" : "ok";
        tool.result = clip(contentText(message.content).trimEnd(), RESULT_CHARS);
        this.bump(tool);
      } else this.messageStart(message);
    }
  }

  lastAnswer(): string {
    const texts: string[] = [];
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      if (block.kind === "user") break;
      if (block.kind === "text" && block.text.trim()) texts.unshift(block.text.trim());
    }
    return texts.join("\n\n");
  }

  private messageStart(message: Json): void {
    if (message.role === "assistant") {
      this.parts.clear();
      this.retrying = "";
      this.part = "";
      this.version += 1;
    } else if (message.role === "user") {
      this.part = "";
      this.blocks.push({ kind: "user", id: this.nextId++, version: 0, text: contentText(message.content) });
      this.version += 1;
    } else if (message.role === "custom" && message.display === true) {
      this.notice("info", contentText(message.content));
    }
  }

  private messageUpdate(event: Json): void {
    switch (event.type) {
      case "text_start":
      case "thinking_start":
        this.prose(event.contentIndex, event.type === "text_start" ? "text" : "thinking");
        return;
      case "text_delta":
      case "thinking_delta": {
        const block = this.prose(event.contentIndex, event.type === "text_delta" ? "text" : "thinking");
        block.text += event.delta ?? "";
        return this.bump(block);
      }
      case "text_end":
      case "thinking_end": {
        const block = this.prose(event.contentIndex, event.type === "text_end" ? "text" : "thinking");
        block.text = event.content ?? block.text;
        return this.bump(block);
      }
      case "toolcall_start": {
        const tool = this.tool(event.id, event.toolName);
        this.parts.set(event.contentIndex, tool);
        this.part = `Calling ${tool.name}…`;
        this.version += 1;
        return;
      }
      case "toolcall_end": {
        const tool = this.tool(event.toolCall?.id, event.toolCall?.name);
        if (!tool.args) tool.args = argsPreview(event.toolCall?.arguments);
        return this.bump(tool);
      }
    }
  }

  private assistantEnd(message: Json): void {
    const content: Json[] = Array.isArray(message.content) ? message.content : [];
    content.forEach((item, index) => {
      if (item.type === "text" || item.type === "thinking") {
        const block = this.prose(index, item.type);
        block.text = (item.type === "text" ? item.text : item.thinking) ?? "";
        block.streaming = false;
        this.bump(block);
      } else if (item.type === "toolCall") {
        const tool = this.tool(item.id, item.name);
        if (!tool.args) tool.args = argsPreview(item.arguments);
        this.bump(tool);
      }
    });
    this.endStreaming();
    this.parts.clear();
    this.part = message.stopReason === "toolUse" ? "" : "Finishing…";
    this.version += 1;
    if (message.stopReason === "error") this.notice("error", message.errorMessage || "The request failed.");
    else if (message.stopReason === "aborted") this.notice("warning", "Aborted.");
  }

  private endStreaming(): void {
    for (const block of this.parts.values()) {
      if (block.kind !== "tool" && block.streaming) {
        block.streaming = false;
        this.bump(block);
      }
    }
  }

  private prose(index: number, kind: "text" | "thinking"): ProseBlock {
    const existing = this.parts.get(index);
    if (existing && existing.kind === kind) return existing;
    const block: ProseBlock = { kind, id: this.nextId++, version: 0, text: "", streaming: true };
    this.blocks.push(block);
    this.parts.set(index, block);
    this.part = kind === "text" ? "Responding…" : "Thinking…";
    this.version += 1;
    return block;
  }

  private tool(callId: unknown, name: unknown): ToolBlock {
    const key = String(callId);
    const existing = this.tools.get(key);
    if (existing) return existing;
    const block: ToolBlock = { kind: "tool", id: this.nextId++, version: 0, callId: key, name: String(name ?? "tool"), args: "", status: "pending", result: "" };
    this.blocks.push(block);
    this.tools.set(key, block);
    this.version += 1;
    return block;
  }

  private bump(block: Block): void {
    block.version += 1;
    this.version += 1;
  }
}
