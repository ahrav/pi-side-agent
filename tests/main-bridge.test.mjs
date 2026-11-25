import assert from "node:assert/strict";
import test from "node:test";
import { MainBridge, mainMessageContent, renderTranscript, snapshotText, statusText } from "../extensions/side-agent/main-bridge.ts";
import { MAIN_MESSAGE_TYPE } from "../extensions/side-agent/protocol.ts";
import { fakeContext, fakePi } from "./support/fakes.mjs";

const message = (id, body) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: body });
const user = (id, text) => message(id, { role: "user", content: [{ type: "text", text }] });
const assistant = (id, content, stopReason = "stop") => message(id, { role: "assistant", content, stopReason });
const text = (value) => ({ type: "text", text: value });

/** A main session: a system message, a tool-using turn, a compaction, and bookkeeping entries. */
function session() {
  return [
    message("e0", { role: "system", content: "", sections: { preamble: "SYSTEM PROMPT" } }),
    user("e1", "Migrate auth to JWT."),
    assistant("e2", [text("Reading the module."), { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/auth.ts" } }], "toolUse"),
    message("e3", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [text(`export function login() {}\n${"x".repeat(900)}`)], isError: false }),
    { type: "model_change", id: "e4", provider: "p", modelId: "m" },
    { type: "custom", id: "e5", customType: "some-state", data: { n: 1 } },
    { type: "compaction", id: "e6", summary: "Earlier: chose RS256.", firstKeptEntryId: "e1", tokensBefore: 1 },
    { type: "custom_message", id: "e7", customType: "note", content: "Remember the deadline.", display: true },
    assistant("e8", [text("JWT signing is done. Tests next.")]),
  ];
}

/** A bridge over a fake pi and context. `replies` collects what the bridge sends to the side agent. */
function bridge(options = {}) {
  const pi = fakePi();
  const ctx = fakeContext({ cwd: "/work/app", branch: session(), ...options });
  const replies = [];
  const main = new MainBridge({ pi, context: () => ctx, touch: () => {}, reply: (reply) => replies.push(reply) });
  main.attach();
  const call = (id, method, params = {}) => main.handle({ t: "call", id, method, params });
  const mainSays = (body) => pi.emit("message_end", { message: { role: "assistant", ...body } }, ctx);
  const delivered = (index = 0) => pi.emit("message_end", { message: { role: "custom", ...pi.messages[index].message } }, ctx);
  return { pi, ctx, main, replies, call, mainSays, delivered };
}

test("renderTranscript shows the newest messages oldest first, each with its entry id", () => {
  const out = renderTranscript(session(), {});
  assert.deepEqual(
    out.split("\n\n").map((item) => item.split("\n")[0].slice(0, 44)),
    ["[e1] user: Migrate auth to JWT.", "[e2] assistant: Reading the module.", "[e3] tool result (read): export function log", "[e6] compaction summary: Earlier: chose RS25", "[e7] note: Remember the deadline.", "[e8] assistant: JWT signing is done. Tests n"],
  );
  assert.match(out, /→ read\(src\/auth\.ts\)/);
  assert.doesNotMatch(out, /SYSTEM PROMPT|some-state|model_change/, "prompt, state, and bookkeeping entries stay out");
  assert.ok(out.length < 1200, "tool output is clipped to 400 characters by default");
});

test("renderTranscript pages backwards with limit and before", () => {
  const entries = session();
  const newest = renderTranscript(entries, { limit: 2 });
  assert.match(newest, /^\[e7\] note: .*\n\n\[e8\] assistant: .*\n\nEarlier messages exist\. Call main_agent_read with before="e7" to read them\.$/s);
  const older = renderTranscript(entries, { limit: 2, before: "e7" });
  assert.match(older, /^\[e3\] tool result .*\n\n\[e6\] compaction summary: .*before="e3"/s);
  const oldest = renderTranscript(entries, { limit: 50, before: "e3" });
  assert.match(oldest, /^\[e1\] user: .*\n\n\[e2\] assistant: /s);
  assert.doesNotMatch(oldest, /Earlier messages exist/);
  assert.equal(renderTranscript(entries, { before: "e1" }), "The main agent's session has no earlier messages.");
  assert.equal(renderTranscript(entries, { before: "nope" }), 'No entry with id "nope" is on the main agent\'s active branch.');
});

test("renderTranscript filters by query and honors the size limits", () => {
  const entries = session();
  assert.match(renderTranscript(entries, { query: "rs256" }), /^\[e6\] compaction summary: Earlier: chose RS256\.$/);
  assert.equal(renderTranscript(entries, { query: "kubernetes" }), 'No message in the main agent\'s session matches "kubernetes".');
  const full = renderTranscript(entries, { tool_output_chars: 8000 });
  assert.ok(full.includes("x".repeat(900)), "a raised tool_output_chars keeps the whole result");
  const many = Array.from({ length: 300 }, (_, index) => user(`u${index}`, `message ${index} ${"y".repeat(200)}`));
  const capped = renderTranscript(many, { limit: 200, max_chars: 2000 });
  assert.ok(capped.length < 2300, `output of ${capped.length} characters stays near max_chars`);
  assert.match(capped, /\[u299\]/);
  assert.match(capped, /Earlier messages exist/);
  const single = renderTranscript([user("big", "z".repeat(50_000))], { max_chars: 1000 });
  assert.ok(single.length <= 1000, "one oversized message is clipped to the budget");
});

test("statusText and snapshotText describe the main agent", () => {
  const status = { idle: false, pending: true, runningTools: ["bash", "read"], model: "p/m", thinking: "high", cwd: "/work/app", sessionName: "auth", contextPercent: 41.6 };
  assert.equal(statusText(status), "Main agent: working (running: bash, read)\nModel: p/m, thinking high\nWorking directory: /work/app\nSession name: auth\nContext used: 42%\nQueued messages: yes");
  assert.equal(statusText({ idle: true, pending: false, runningTools: [], cwd: "/w" }), "Main agent: idle\nWorking directory: /w");
  const snapshot = snapshotText({ idle: true, pending: false, runningTools: [], cwd: "/w" }, session());
  assert.equal(snapshot, "Main agent: idle\nWorking directory: /w\n\nLatest user message to the main agent:\nMigrate auth to JWT.\n\nLatest main agent text:\nJWT signing is done. Tests next.");
  assert.ok(snapshotText({ idle: true, pending: false, runningTools: [], cwd: "/w" }, [user("a", "q".repeat(5000))]).length < 800);
});

test("read and snapshot answer from the main session", () => {
  const { call, replies, pi, ctx } = bridge({ idle: false });
  pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash" }, ctx);
  call(1, "read", { limit: 1 });
  assert.equal(replies[0].ok, true);
  assert.match(replies[0].result, /^Main agent: working \(running: bash\)\nWorking directory: \/work\/app\nContext used: 1%\n\n\[e8\] assistant: JWT signing is done/);
  pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash" }, ctx);

  call(2, "snapshot", {});
  assert.equal(replies[1].result.unchanged, false);
  assert.equal(replies[1].result.leafId, "e8");
  assert.match(replies[1].result.text, /^Main agent: working\n/);
  call(3, "snapshot", { since: "e8" });
  assert.deepEqual(replies[2].result, { unchanged: true });
  ctx.branch.push(user("e9", "Also add refresh tokens."));
  call(4, "snapshot", { since: "e8" });
  assert.match(replies[3].result.text, /Also add refresh tokens\./);
});

test("send delivers a custom message in the mode the side agent asked for", () => {
  const { call, replies, pi, ctx } = bridge();
  call(1, "send", { message: "  Run the tests.  " });
  assert.deepEqual(pi.messages[0].options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(pi.messages[0].message.customType, MAIN_MESSAGE_TYPE);
  assert.equal(pi.messages[0].message.display, true);
  assert.equal(pi.messages[0].message.content, mainMessageContent("Run the tests.", false));
  assert.equal(pi.messages[0].message.details.text, "Run the tests.");
  assert.equal(replies[0].result, "Delivered. The main agent was idle and started a turn for the message.");

  ctx.idle = false;
  call(2, "send", { message: "steer" });
  call(3, "send", { message: "after", delivery: "follow_up" });
  call(4, "send", { message: "fyi", delivery: "next_turn" });
  assert.deepEqual(pi.messages.slice(1).map((entry) => entry.options), [{ deliverAs: "steer", triggerTurn: true }, { deliverAs: "followUp", triggerTurn: true }, { deliverAs: "nextTurn" }]);
  assert.deepEqual(replies.slice(1).map((reply) => reply.result), [
    "Queued. The main agent is working and reads the message after its current tool calls.",
    "Queued. The main agent is working and reads the message after it finishes.",
    "Queued. The main agent reads the message with its next turn.",
  ]);
});

test("send rejects an empty message, a next_turn wait, and a missing main session", () => {
  const { call, replies, pi } = bridge();
  call(1, "send", { message: "   " });
  call(2, "send", { message: "hi", delivery: "next_turn", wait_for_reply: true });
  assert.deepEqual(replies.map((reply) => [reply.ok, reply.error]), [[false, "message is empty."], [false, "wait_for_reply needs delivery steer or follow_up: a next_turn message starts no turn."]]);
  assert.equal(pi.messages.length, 0);

  const orphanReplies = [];
  const orphan = new MainBridge({ pi: fakePi(), context: () => undefined, touch: () => {}, reply: (reply) => orphanReplies.push(reply) });
  orphan.handle({ t: "call", id: 9, method: "read", params: {} });
  assert.deepEqual(orphanReplies, [{ t: "reply", id: 9, ok: false, error: "The main session is not available." }]);
});

test("a wait on an idle main agent resolves with the text of the message that ends its turn", () => {
  const { call, replies, mainSays, delivered, pi } = bridge();
  call(1, "send", { message: "Which branch?", wait_for_reply: true });
  assert.match(pi.messages[0].message.content, /The side agent is waiting for your reply\./);
  mainSays({ content: [text("an unrelated earlier message")], stopReason: "stop" });
  assert.equal(replies.length, 0, "messages before delivery are not the reply");
  delivered();
  mainSays({ content: [text("Let me check."), { type: "toolCall", id: "c", name: "bash", arguments: {} }], stopReason: "toolUse" });
  assert.equal(replies.length, 0, "a message that calls tools does not end the turn");
  mainSays({ content: [text("It is feature/jwt.")], stopReason: "stop" });
  assert.deepEqual(replies, [{ t: "reply", id: 1, ok: true, result: "Main agent replied:\n\nIt is feature/jwt." }]);
  mainSays({ content: [text("later")], stopReason: "stop" });
  assert.equal(replies.length, 1, "a wait resolves once");
});

test("a steered wait on a working main agent resolves with its first text", () => {
  const { call, replies, mainSays, delivered } = bridge({ idle: false });
  call(1, "send", { message: "Status?", wait_for_reply: true });
  delivered();
  mainSays({ content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }], stopReason: "toolUse" });
  assert.equal(replies.length, 0, "a message without text is not a reply");
  mainSays({ content: [text("Half done."), { type: "toolCall", id: "d", name: "edit", arguments: {} }], stopReason: "toolUse" });
  assert.deepEqual(replies, [{ t: "reply", id: 1, ok: true, result: "Main agent replied:\n\nHalf done." }]);
});

test("a follow-up wait on a working main agent waits for the turn that answers it", () => {
  const { call, replies, mainSays, delivered } = bridge({ idle: false });
  call(1, "send", { message: "When done, summarize.", delivery: "follow_up", wait_for_reply: true });
  mainSays({ content: [text("Finishing the current task.")], stopReason: "stop" });
  assert.equal(replies.length, 0, "the turn before delivery is not the reply");
  delivered();
  mainSays({ content: [text("Summary: all green.")], stopReason: "stop" });
  assert.equal(replies[0].result, "Main agent replied:\n\nSummary: all green.");
});

test("a wait ends when the main agent settles, fails, or runs out of time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, replies, mainSays, delivered, pi, ctx } = bridge();
  call(1, "send", { message: "a", wait_for_reply: true });
  delivered(0);
  pi.emit("agent_settled", { aborted: true }, ctx);
  assert.equal(replies[0].result, "The main agent finished its turn without a text reply. Call main_agent_read to see what it did.");

  call(2, "send", { message: "b", wait_for_reply: true });
  delivered(1);
  mainSays({ content: [], stopReason: "error", errorMessage: "529 overloaded" });
  assert.equal(replies[1].result, "Main agent replied:\n\nThe main agent's turn failed: 529 overloaded");

  call(3, "send", { message: "c", wait_for_reply: true, timeout_seconds: 30 });
  delivered(2);
  mainSays({ content: [text("Working on it."), { type: "toolCall", id: "c", name: "bash", arguments: {} }], stopReason: "toolUse" });
  t.mock.timers.tick(29_999);
  assert.equal(replies.length, 2);
  t.mock.timers.tick(1);
  assert.equal(replies[2].result, "The main agent has not finished replying after 30 seconds. Its latest text so far:\n\nWorking on it.\n\nCall main_agent_read later to see its reply.");

  call(4, "send", { message: "d", wait_for_reply: true, timeout_seconds: 1 });
  t.mock.timers.tick(5000);
  assert.equal(replies[3].result, "The main agent has not finished replying after 5 seconds. Call main_agent_read later to see its reply.", "the wait is at least 5 seconds");
});

test("cancel and detach drop pending waits without a reply", () => {
  const { call, replies, mainSays, delivered, main, pi } = bridge();
  call(1, "send", { message: "a", wait_for_reply: true });
  call(2, "send", { message: "b", wait_for_reply: true });
  main.handle({ t: "cancel", id: 1 });
  delivered(0);
  delivered(1);
  main.detach();
  mainSays({ content: [text("too late")], stopReason: "stop" });
  assert.deepEqual(replies, []);
  for (const event of ["message_end", "agent_settled", "tool_execution_start", "tool_execution_end"]) assert.equal(pi.listeners(event), 0, `${event} handler removed`);
});

test("the bridge listens to the main session only between attach and detach", () => {
  const pi = fakePi();
  const main = new MainBridge({ pi, context: () => undefined, touch: () => {}, reply: () => {} });
  assert.equal(pi.handlers.size, 0, "a bridge that is not attached registers nothing");
  main.attach();
  main.attach();
  assert.deepEqual([...pi.handlers.keys()].map((event) => [event, pi.listeners(event)]), [["message_end", 1], ["agent_settled", 1], ["tool_execution_start", 1], ["tool_execution_end", 1]]);
  main.detach();
  assert.ok([...pi.handlers.keys()].every((event) => pi.listeners(event) === 0));
});
