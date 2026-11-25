export const CHILD_ENV = "PI_SIDE_AGENT_CHILD";

export const MAIN_MESSAGE_TYPE = "side-agent";
export const SNAPSHOT_MESSAGE_TYPE = "side-agent-main-snapshot";
export const SESSION_ENTRY_TYPE = "side-agent-session";

export const SIDE_AGENT_PROMPT = `<side_agent>
You are the side agent: a second pi agent the user opened in a side window next to their main agent. Both agents work in the same directory. The main agent keeps running its own task while you work.

- Answer the user's side questions and do the side tasks they give you. You have the tools, skills, and MCP servers of a full pi agent.
- The main agent's conversation is not in your context. A <main_agent_snapshot> message shows its latest state when that state changed. Call main_agent_read when a question depends on what the main agent said or did.
- Call main_agent_send when the user asks you to tell, ask, or hand something to the main agent. Set wait_for_reply when you need its answer.
- The main agent may be editing files in this directory. Before you change a file, check that the change does not collide with its work. Ask the main agent to make changes that belong to its task.
</side_agent>`;

export type Delivery = "steer" | "follow_up" | "next_turn";

export interface ReadParams {
  limit?: number;
  before?: string;
  query?: string;
  max_chars?: number;
  tool_output_chars?: number;
}

export interface SendParams {
  message: string;
  delivery?: Delivery;
  wait_for_reply?: boolean;
  timeout_seconds?: number;
}

export interface SnapshotParams {
  /** Leaf entry id of the snapshot the caller already holds. */
  since?: string | null;
}

export type SnapshotResult = { unchanged: true } | { unchanged: false; leafId: string | null; text: string };

export type BridgeCall =
  | { t: "call"; id: number; method: "read"; params: ReadParams }
  | { t: "call"; id: number; method: "send"; params: SendParams }
  | { t: "call"; id: number; method: "snapshot"; params: SnapshotParams };

export interface BridgeCancel {
  t: "cancel";
  id: number;
}

export type BridgeReply = { t: "reply"; id: number; ok: true; result: unknown } | { t: "reply"; id: number; ok: false; error: string };

export type BridgeMessage = BridgeCall | BridgeCancel;

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { t?: unknown; id?: unknown; method?: unknown };
  if (typeof message.id !== "number") return false;
  if (message.t === "cancel") return true;
  return message.t === "call" && (message.method === "read" || message.method === "send" || message.method === "snapshot");
}

export function isBridgeReply(value: unknown): value is BridgeReply {
  if (!value || typeof value !== "object") return false;
  const message = value as { t?: unknown; id?: unknown; ok?: unknown };
  return message.t === "reply" && typeof message.id === "number" && typeof message.ok === "boolean";
}
