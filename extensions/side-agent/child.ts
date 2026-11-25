import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CHILD_ENV, isBridgeReply, SNAPSHOT_MESSAGE_TYPE, type SnapshotResult } from "./protocol.ts";

const CALL_TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 1500;
const DEFAULT_REPLY_SECONDS = 120;
const MAX_REPLY_SECONDS = 900;
const ORPHAN_EXIT_MS = 15_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export default function (pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] !== "1" || typeof process.send !== "function") return;

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let listening = false;
  let snapshotLeaf: string | null | undefined;

  function failAll(reason: string): void {
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
  }

  function call<T>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!process.connected || signal?.aborted) {
        reject(new Error(signal?.aborted ? "Aborted." : "The main pi process is not connected."));
        return;
      }
      const id = nextId++;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
      };
      const abandon = (reason: string) => {
        cleanup();
        if (process.connected) process.send?.({ t: "cancel", id });
        reject(new Error(reason));
      };
      const onAbort = () => abandon("Aborted.");
      const timer = setTimeout(() => abandon("The main pi process did not answer in time."), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      process.send?.({ t: "call", id, method, params });
    });
  }

  pi.on("session_start", () => {
    if (listening) return;
    listening = true;
    process.on("message", (message) => {
      if (!isBridgeReply(message)) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
    });
    process.on("disconnect", () => {
      failAll("The main pi process disconnected.");
      setTimeout(() => process.exit(0), ORPHAN_EXIT_MS).unref();
    });
  });

  pi.on("session_shutdown", () => {
    failAll("The side agent is shutting down.");
    process.channel?.unref();
  });

  pi.on("before_agent_start", async (event) => {
    if (event.messageType !== "user") return;
    let snapshot: SnapshotResult;
    try {
      snapshot = await call<SnapshotResult>("snapshot", snapshotLeaf === undefined ? {} : { since: snapshotLeaf }, SNAPSHOT_TIMEOUT_MS);
    } catch {
      return;
    }
    if (snapshot.unchanged) return;
    snapshotLeaf = snapshot.leafId;
    return {
      message: {
        customType: SNAPSHOT_MESSAGE_TYPE,
        content: `<main_agent_snapshot>\n${snapshot.text}\n</main_agent_snapshot>`,
        display: false,
      },
    };
  });

  pi.registerTool({
    name: "main_agent_read",
    label: "Read main agent",
    description:
      "Read the main agent's session: its current status, then its most recent messages (user prompts, assistant text, tool calls, and clipped tool output), oldest first. Each message starts with its entry id. Pass that id as `before` to page backwards. Output is capped at max_chars.",
    promptSnippet: "Read the main agent's status and recent conversation",
    promptGuidelines: ["Use main_agent_read before answering a question that depends on what the main agent said or did."],
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum messages to return. Default 20." })),
      before: Type.Optional(Type.String({ description: "Entry id. Return only messages older than this entry." })),
      query: Type.Optional(Type.String({ description: "Return only messages that contain this text, ignoring case." })),
      max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 48000, description: "Output cap in characters. Default 12000." })),
      tool_output_chars: Type.Optional(Type.Integer({ minimum: 0, maximum: 8000, description: "Characters kept of each tool result. Default 400." })),
    }),
    async execute(_toolCallId, params, signal) {
      const text = await call<string>("read", params, CALL_TIMEOUT_MS, signal);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "main_agent_send",
    label: "Message main agent",
    description:
      "Send a message to the main agent, the user's primary pi agent in this project. It arrives in the main agent's conversation marked as coming from the side agent. " +
      "delivery: `steer` (default) delivers after the main agent's current tool calls, or starts a turn at once when it is idle; `follow_up` delivers after the main agent finishes its current work; `next_turn` attaches the message to the main agent's next turn and starts nothing. " +
      "Set wait_for_reply to block until the main agent answers and get its reply text as the result.",
    promptSnippet: "Send a message to the main agent, optionally waiting for its reply",
    promptGuidelines: [
      "Use main_agent_send only when the user asks you to tell, ask, or hand something to the main agent. Write a self-contained message: the main agent cannot see this side conversation.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "The message text. Include all context the main agent needs." }),
      delivery: Type.Optional(StringEnum(["steer", "follow_up", "next_turn"] as const, { description: "When the main agent receives the message. Default steer." })),
      wait_for_reply: Type.Optional(Type.Boolean({ description: "Wait for the main agent's reply and return it. Default false." })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: MAX_REPLY_SECONDS, description: `Longest wait for a reply. Default ${DEFAULT_REPLY_SECONDS}.` })),
    }),
    async execute(_toolCallId, params, signal) {
      const waitSeconds = params.wait_for_reply ? Math.min(MAX_REPLY_SECONDS, Math.max(5, params.timeout_seconds ?? DEFAULT_REPLY_SECONDS)) : 0;
      const text = await call<string>("send", params, waitSeconds * 1000 + CALL_TIMEOUT_MS, signal);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
