import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BridgeMessage, type BridgeReply, type Delivery, MAIN_MESSAGE_TYPE, type ReadParams, type SendParams, type SnapshotParams, type SnapshotResult } from "./protocol.ts";
import { argsPreview, contentText } from "./transcript.ts";

type Json = Record<string, any>;

export interface MainStatus {
  idle: boolean;
  pending: boolean;
  runningTools: string[];
  model?: string;
  thinking?: string;
  cwd: string;
  sessionName?: string;
  contextPercent?: number | null;
}

export interface MainBridgeHost {
  pi: Pick<ExtensionAPI, "on" | "sendMessage" | "getThinkingLevel">;
  context(): ExtensionContext | undefined;
  touch(ctx: ExtensionContext): void;
  reply(reply: BridgeReply): void;
}

interface Waiter {
  callId: number;
  token: string;
  mode: "first-text" | "run";
  delivered: boolean;
  text: string;
  timer: NodeJS.Timeout;
  seconds: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_CHARS = 12_000;
const MAX_CHARS = 48_000;
const DEFAULT_TOOL_CHARS = 400;
const MAX_TOOL_CHARS = 8000;
const MESSAGE_CHARS = 4000;
const MAX_SCAN = 5000;
const SNAPSHOT_SCAN = 400;
const SNAPSHOT_USER_CHARS = 600;
const SNAPSHOT_ASSISTANT_CHARS = 1500;
const DEFAULT_REPLY_SECONDS = 120;
const MAX_REPLY_SECONDS = 900;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function assistantText(message: Json): string {
  const parts: string[] = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) parts.push(part.text.trim());
  }
  return parts.join("\n\n");
}

export function renderEntry(entry: Json, toolChars: number): string | undefined {
  if (entry.type === "custom_message") return `${entry.customType}: ${clip(contentText(entry.content), MESSAGE_CHARS)}`;
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return `${entry.type === "compaction" ? "compaction summary" : "branch summary"}: ${clip(String(entry.summary ?? ""), MESSAGE_CHARS)}`;
  }
  if (entry.type !== "message") return undefined;
  const message: Json = entry.message ?? {};
  switch (message.role) {
    case "user":
      return `user: ${clip(contentText(message.content), MESSAGE_CHARS)}`;
    case "assistant": {
      const lines: string[] = [];
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) lines.push(clip(part.text.trim(), MESSAGE_CHARS));
        else if (part?.type === "toolCall") lines.push(`→ ${part.name}(${argsPreview(part.arguments)})`);
      }
      if (message.stopReason === "error") lines.push(`[error: ${message.errorMessage ?? "request failed"}]`);
      if (message.stopReason === "aborted") lines.push("[aborted]");
      return lines.length > 0 ? `assistant: ${lines.join("\n")}` : undefined;
    }
    case "toolResult":
      return `tool result (${message.toolName}${message.isError ? ", error" : ""}): ${clip(contentText(message.content).trim(), toolChars)}`;
    case "bashExecution":
      return `user ran \`${clip(String(message.command ?? ""), 300)}\`: ${clip(String(message.output ?? "").trim(), toolChars)}`;
    default:
      return undefined;
  }
}

export function renderTranscript(entries: readonly Json[], params: ReadParams): string {
  const limit = clampInt(params.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const budget = clampInt(params.max_chars, 1000, MAX_CHARS, DEFAULT_CHARS);
  const toolChars = clampInt(params.tool_output_chars, 0, MAX_TOOL_CHARS, DEFAULT_TOOL_CHARS);
  const query = params.query?.trim().toLowerCase();
  let end = entries.length;
  if (params.before) {
    end = entries.findIndex((entry) => entry.id === params.before);
    if (end === -1) return `No entry with id "${params.before}" is on the main agent's active branch.`;
  }
  const items: string[] = [];
  let used = 0;
  let scanned = 0;
  let oldest: string | undefined;
  let more = false;
  for (let index = end - 1; index >= 0; index--) {
    if (items.length >= limit || scanned >= MAX_SCAN) {
      more = true;
      break;
    }
    scanned += 1;
    const entry = entries[index];
    const text = renderEntry(entry, toolChars);
    if (text === undefined || (query && !text.toLowerCase().includes(query))) continue;
    const item = `[${entry.id}] ${text}`;
    if (items.length > 0 && used + item.length > budget) {
      more = true;
      break;
    }
    items.unshift(clip(item, budget));
    used += item.length;
    oldest = entry.id;
  }
  if (items.length === 0) return query ? `No message in the main agent's session matches "${params.query}".` : "The main agent's session has no earlier messages.";
  const footer = more && oldest ? `\n\nEarlier messages exist. Call main_agent_read with before="${oldest}" to read them.` : "";
  return `${items.join("\n\n")}${footer}`;
}

export function statusText(status: MainStatus): string {
  const running = status.runningTools.length > 0 ? ` (running: ${status.runningTools.join(", ")})` : "";
  const lines = [`Main agent: ${status.idle ? "idle" : `working${running}`}`];
  if (status.model) lines.push(`Model: ${status.model}${status.thinking ? `, thinking ${status.thinking}` : ""}`);
  lines.push(`Working directory: ${status.cwd}`);
  if (status.sessionName) lines.push(`Session name: ${status.sessionName}`);
  if (typeof status.contextPercent === "number") lines.push(`Context used: ${Math.round(status.contextPercent)}%`);
  if (status.pending) lines.push("Queued messages: yes");
  return lines.join("\n");
}

export function snapshotText(status: MainStatus, entries: readonly Json[]): string {
  let user: string | undefined;
  let assistant: string | undefined;
  for (let index = entries.length - 1, scanned = 0; index >= 0 && scanned < SNAPSHOT_SCAN && (user === undefined || assistant === undefined); index--, scanned++) {
    const message: Json | undefined = entries[index].type === "message" ? entries[index].message : undefined;
    if (message?.role === "user" && user === undefined) user = contentText(message.content).trim();
    else if (message?.role === "assistant" && assistant === undefined) assistant = assistantText(message) || undefined;
  }
  const sections = [statusText(status)];
  if (user) sections.push(`Latest user message to the main agent:\n${clip(user, SNAPSHOT_USER_CHARS)}`);
  if (assistant) sections.push(`Latest main agent text:\n${clip(assistant, SNAPSHOT_ASSISTANT_CHARS)}`);
  return sections.join("\n\n");
}

export function mainMessageContent(text: string, expectsReply: boolean): string {
  const header = "Message from the side agent, a second pi agent the user is working with in a side window:";
  const footer = expectsReply ? "\n\nThe side agent is waiting for your reply. Put your answer in the text of your next message; that text is relayed to the side agent." : "";
  return `${header}\n\n${text}${footer}`;
}

export class MainBridge {
  private readonly host: MainBridgeHost;
  private readonly waiters = new Map<number, Waiter>();
  private readonly runningTools = new Map<string, string>();
  private unsubscribe: Array<() => void> = [];

  constructor(host: MainBridgeHost) {
    this.host = host;
  }

  attach(): void {
    if (this.unsubscribe.length > 0) return;
    const { pi } = this.host;
    this.unsubscribe = [
      pi.on("message_end", (event, ctx) => {
        this.host.touch(ctx);
        this.onMessageEnd(event.message as Json);
      }),
      pi.on("agent_settled", (_event, ctx) => {
        this.host.touch(ctx);
        this.onSettled();
      }),
      pi.on("tool_execution_start", (event) => {
        this.runningTools.set(event.toolCallId, event.toolName);
      }),
      pi.on("tool_execution_end", (event) => {
        this.runningTools.delete(event.toolCallId);
      }),
    ];
  }

  detach(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.runningTools.clear();
    for (const waiter of [...this.waiters.values()]) this.settle(waiter, undefined);
  }

  handle(message: BridgeMessage): void {
    if (message.t === "cancel") {
      const waiter = this.waiters.get(message.id);
      if (waiter) this.settle(waiter, undefined);
      return;
    }
    try {
      if (message.method === "read") this.ok(message.id, this.read(message.params ?? {}));
      else if (message.method === "snapshot") this.ok(message.id, this.snapshot(message.params ?? {}));
      else this.sendForSide(message.id, message.params ?? ({} as SendParams));
    } catch (error) {
      this.host.reply({ t: "reply", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  status(): MainStatus {
    const ctx = this.context();
    const usage = ctx.getContextUsage();
    return {
      idle: ctx.isIdle(),
      pending: ctx.hasPendingMessages(),
      runningTools: [...new Set(this.runningTools.values())],
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinking: this.host.pi.getThinkingLevel(),
      cwd: ctx.cwd,
      sessionName: ctx.sessionManager.getSessionName(),
      contextPercent: usage?.percent,
    };
  }

  read(params: ReadParams): string {
    const entries = this.context().sessionManager.getBranch() as Json[];
    return `${statusText(this.status())}\n\n${renderTranscript(entries, params)}`;
  }

  snapshot(params: SnapshotParams): SnapshotResult {
    const sessionManager = this.context().sessionManager;
    const leafId = sessionManager.getLeafId();
    if (params.since !== undefined && params.since === leafId) return { unchanged: true };
    return { unchanged: false, leafId, text: snapshotText(this.status(), sessionManager.getBranch() as Json[]) };
  }

  deliver(params: SendParams): { token: string; busy: boolean; delivery: Delivery; summary: string } {
    const ctx = this.context();
    const text = typeof params.message === "string" ? params.message.trim() : "";
    if (!text) throw new Error("message is empty.");
    const delivery = params.delivery ?? "steer";
    const expectsReply = params.wait_for_reply === true;
    if (expectsReply && delivery === "next_turn") throw new Error("wait_for_reply needs delivery steer or follow_up: a next_turn message starts no turn.");
    const busy = !ctx.isIdle();
    const token = randomUUID().slice(0, 8);
    this.host.pi.sendMessage(
      { customType: MAIN_MESSAGE_TYPE, content: mainMessageContent(text, expectsReply), display: true, details: { id: token, text, expectsReply } },
      delivery === "next_turn" ? { deliverAs: "nextTurn" } : { deliverAs: delivery === "follow_up" ? "followUp" : "steer", triggerTurn: true },
    );
    let summary = "Delivered. The main agent was idle and started a turn for the message.";
    if (delivery === "next_turn") summary = "Queued. The main agent reads the message with its next turn.";
    else if (busy) summary = `Queued. The main agent is working and reads the message after ${delivery === "steer" ? "its current tool calls" : "it finishes"}.`;
    return { token, busy, delivery, summary };
  }

  private sendForSide(callId: number, params: SendParams): void {
    const { token, busy, delivery, summary } = this.deliver(params);
    if (params.wait_for_reply !== true) {
      this.ok(callId, summary);
      return;
    }
    const seconds = clampInt(params.timeout_seconds, 5, MAX_REPLY_SECONDS, DEFAULT_REPLY_SECONDS);
    const waiter: Waiter = {
      callId,
      token,
      mode: busy && delivery === "steer" ? "first-text" : "run",
      delivered: false,
      text: "",
      seconds,
      timer: setTimeout(() => this.settle(waiter, "timeout"), seconds * 1000),
    };
    waiter.timer.unref();
    this.waiters.set(callId, waiter);
  }

  private onMessageEnd(message: Json): void {
    if (this.waiters.size === 0) return;
    if (message.role === "custom" && message.customType === MAIN_MESSAGE_TYPE) {
      for (const waiter of this.waiters.values()) if (waiter.token === message.details?.id) waiter.delivered = true;
      return;
    }
    if (message.role !== "assistant") return;
    const text = assistantText(message);
    for (const waiter of [...this.waiters.values()]) {
      if (!waiter.delivered) continue;
      if (text) waiter.text = text;
      if (message.stopReason === "error" && !text) waiter.text = `The main agent's turn failed: ${message.errorMessage ?? "request failed"}`;
      const done = waiter.mode === "first-text" ? text !== "" : message.stopReason !== "toolUse";
      if (done) this.settle(waiter, "reply");
    }
  }

  private onSettled(): void {
    for (const waiter of [...this.waiters.values()]) if (waiter.delivered) this.settle(waiter, "reply");
  }

  private settle(waiter: Waiter, outcome: "reply" | "timeout" | undefined): void {
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter.callId);
    if (outcome === "reply") {
      this.ok(waiter.callId, waiter.text ? `Main agent replied:\n\n${waiter.text}` : "The main agent finished its turn without a text reply. Call main_agent_read to see what it did.");
    } else if (outcome === "timeout") {
      const partial = waiter.text ? ` Its latest text so far:\n\n${waiter.text}\n\n` : " ";
      this.ok(waiter.callId, `The main agent has not finished replying after ${waiter.seconds} seconds.${partial}Call main_agent_read later to see its reply.`);
    }
  }

  private ok(id: number, result: unknown): void {
    this.host.reply({ t: "reply", id, ok: true, result });
  }

  private context(): ExtensionContext {
    const ctx = this.host.context();
    if (!ctx) throw new Error("The main session is not available.");
    return ctx;
  }
}
