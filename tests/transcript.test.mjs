import assert from "node:assert/strict";
import test from "node:test";
import { argsPreview, Transcript } from "../extensions/side-agent/transcript.ts";

const update = (event) => ({ type: "message_update", assistantMessageEvent: event });
const describe = (transcript) => transcript.blocks.map((block) => (block.kind === "tool" ? `tool:${block.name}(${block.args}):${block.status}` : `${block.kind}:${block.text}`));

/** A turn as pi streams it: thinking, text, and one tool call, then the tool's execution. */
function streamedTurn() {
  return [
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "list files" }] } },
    { type: "message_start", message: { role: "assistant", content: [] } },
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "I should " }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "look." }),
    update({ type: "text_start", contentIndex: 1 }),
    update({ type: "text_delta", contentIndex: 1, delta: "Listing " }),
    update({ type: "text_delta", contentIndex: 1, delta: "now" }),
    update({ type: "toolcall_start", contentIndex: 2, id: "call-1", toolName: "bash" }),
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "I should look." },
          { type: "text", text: "Listing now." },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } },
        ],
      },
    },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls -la" } },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "README.md\n" }] }, isError: false, durationMs: 12 },
    { type: "message_start", message: { role: "assistant", content: [] } },
    update({ type: "text_start", contentIndex: 0 }),
    update({ type: "text_delta", contentIndex: 0, delta: "One file." }),
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "One file." }] } },
    { type: "agent_settled", aborted: false },
  ];
}

test("a streamed turn becomes user, thinking, text, tool, and text blocks in order", () => {
  const transcript = new Transcript();
  const records = streamedTurn();
  for (const record of records.slice(0, 9)) transcript.apply(record);
  assert.equal(transcript.busy, true);
  assert.deepEqual(describe(transcript), ["user:list files", "thinking:I should look.", "text:Listing now"]);
  assert.equal(transcript.blocks[2].streaming, true);

  for (const record of records.slice(9)) transcript.apply(record);
  assert.equal(transcript.busy, false);
  assert.deepEqual(describe(transcript), ["user:list files", "thinking:I should look.", "text:Listing now.", "tool:bash(ls -la):ok", "text:One file."]);
  assert.ok(transcript.blocks.every((block) => block.kind === "tool" || block.kind === "user" || block.streaming === false));
  const tool = transcript.blocks[3];
  assert.equal(tool.result, "README.md");
  assert.equal(tool.durationMs, 12);
  assert.equal(transcript.lastAnswer(), "Listing now.\n\nOne file.");
});

/** A run whose first request fails and is retried, followed by a compaction. */
function retriedTurn() {
  return [
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: "try" } },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "overloaded", content: [] } },
    { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } },
    { type: "auto_retry_end", success: true, attempt: 2 },
    { type: "agent_settled", aborted: false },
    { type: "compaction_start", reason: "manual" },
    { type: "compaction_end", reason: "manual", aborted: false },
  ];
}

test("every visible change advances the transcript version", () => {
  const transcript = new Transcript();
  let last = transcript.version;
  for (const record of [...streamedTurn(), ...retriedTurn()]) {
    const before = JSON.stringify(describe(transcript)) + transcript.busy + transcript.activity();
    transcript.apply(record);
    const after = JSON.stringify(describe(transcript)) + transcript.busy + transcript.activity();
    if (before !== after) assert.ok(transcript.version > last, `${record.type} changed the transcript without a new version`);
    last = transcript.version;
  }
});

test("activity names each step of a run and is empty between runs", () => {
  const transcript = new Transcript();
  assert.equal(transcript.activity(), "");
  const steps = [];
  for (const record of streamedTurn()) {
    transcript.apply(record);
    if (steps.at(-1) !== transcript.activity()) steps.push(transcript.activity());
    assert.equal(transcript.active, transcript.activity() !== "", record.type);
  }
  assert.deepEqual(steps, [
    "Waiting for the model…",
    "Thinking…",
    "Responding…",
    "Calling bash…",
    "Waiting for the model…",
    "Running bash…",
    "Waiting for the model…",
    "Responding…",
    "Finishing…",
    "",
  ]);
});

test("activity covers parallel tools, retries, a queued message, and compaction", () => {
  const transcript = new Transcript();
  const step = (record) => {
    transcript.apply(record);
    return transcript.activity();
  };
  const steps = [];
  for (const record of retriedTurn()) if (steps.at(-1) !== step(record)) steps.push(transcript.activity());
  assert.deepEqual(steps, ["Waiting for the model…", "Finishing…", "Retrying (2/3)…", "Waiting for the model…", "Finishing…", "", "Compacting context…", ""]);

  step({ type: "agent_start" });
  step({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
  assert.equal(step({ type: "tool_execution_start", toolCallId: "b", toolName: "grep", args: {} }), "Running 2 tools…");
  assert.equal(step({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [] } }), "Running grep…");
  assert.equal(step({ type: "tool_execution_end", toolCallId: "b", toolName: "grep", result: { content: [] } }), "Waiting for the model…");

  step({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "overloaded", content: [] } });
  assert.equal(step({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded" }), "Retrying (2/3)…");
  assert.equal(step({ type: "message_start", message: { role: "assistant", content: [] } }), "Waiting for the model…");

  assert.equal(step({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }), "Finishing…");
  assert.equal(step({ type: "message_start", message: { role: "user", content: "a queued message" } }), "Waiting for the model…");
  assert.equal(step({ type: "agent_settled" }), "");

  assert.equal(step({ type: "compaction_start", reason: "manual" }), "Compacting context…");
  assert.equal(transcript.busy, false);
  assert.equal(transcript.active, true);
  assert.equal(step({ type: "compaction_end", reason: "manual", aborted: false }), "");

  step({ type: "agent_start" });
  step({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} });
  step({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000 });
  step({ type: "agent_settled" });
  assert.equal(step({ type: "agent_start" }), "Waiting for the model…", "a run that ends mid-step leaves no step for the next run");

  step({ type: "tool_execution_start", toolCallId: "d", toolName: "bash", args: {} });
  transcript.clear();
  assert.equal(transcript.activity(), "");
  assert.equal(step({ type: "agent_start" }), "Waiting for the model…", "a cleared transcript keeps no running tool");
});

test("a delta touches only the block it extends", () => {
  const transcript = new Transcript();
  for (const record of streamedTurn().slice(0, 8)) transcript.apply(record);
  const versions = transcript.blocks.map((block) => block.version);
  transcript.apply(update({ type: "text_delta", contentIndex: 1, delta: "more" }));
  assert.deepEqual(transcript.blocks.map((block) => block.version), [versions[0], versions[1], versions[2] + 1]);
});

test("a message that did not stream creates its blocks when it ends", () => {
  const transcript = new Transcript();
  transcript.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  transcript.apply({
    type: "message_end",
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Checking." }, { type: "toolCall", id: "c9", name: "read", arguments: { path: "a.ts" } }] },
  });
  assert.deepEqual(describe(transcript), ["text:Checking.", "tool:read(a.ts):pending"]);
});

test("a failed or aborted response adds a notice", () => {
  const transcript = new Transcript();
  transcript.apply({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded", content: [] } });
  transcript.apply({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] } });
  assert.deepEqual(describe(transcript), ["notice:529 overloaded", "text:partial", "notice:Aborted."]);
  assert.deepEqual(transcript.blocks.filter((block) => block.kind === "notice").map((block) => block.level), ["error", "warning"]);
});

test("tool errors, retries, compaction, and extension errors are reported", () => {
  const transcript = new Transcript();
  transcript.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "false" } });
  transcript.apply({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "exit 1" }] }, isError: true });
  transcript.apply({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
  transcript.apply({ type: "auto_retry_end", success: false, finalError: "gave up" });
  transcript.apply({ type: "compaction_start", reason: "threshold" });
  transcript.apply({ type: "compaction_end", reason: "threshold", aborted: false });
  transcript.apply({ type: "extension_error", event: "tool_call", error: "boom" });
  assert.deepEqual(describe(transcript), [
    "tool:bash(false):error",
    "notice:Retry 1/3 in 2s: overloaded",
    "notice:gave up",
    "notice:Compacting context (threshold).",
    "notice:Context compacted.",
    "notice:Extension error in tool_call: boom",
  ]);
});

test("queued messages follow queue_update and custom messages show only when displayed", () => {
  const transcript = new Transcript();
  transcript.apply({ type: "queue_update", steering: ["first"], followUp: ["later"] });
  assert.deepEqual(transcript.queued, ["first", "later"]);
  transcript.apply({ type: "queue_update", steering: [], followUp: [] });
  assert.deepEqual(transcript.queued, []);
  transcript.apply({ type: "message_start", message: { role: "custom", customType: "hidden", content: "secret", display: false } });
  transcript.apply({ type: "message_start", message: { role: "custom", customType: "shown", content: "visible", display: true } });
  assert.deepEqual(describe(transcript), ["notice:visible"]);
});

test("load rebuilds blocks from stored messages and clear empties the transcript", () => {
  const transcript = new Transcript();
  transcript.load([
    { role: "system", content: "", sections: {} },
    { role: "user", content: "hi" },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "k1", name: "bash", arguments: { command: "pwd" } }] },
    { role: "toolResult", toolCallId: "k1", toolName: "bash", content: [{ type: "text", text: "/tmp" }], isError: false },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "It is /tmp." }] },
  ]);
  assert.deepEqual(describe(transcript), ["user:hi", "tool:bash(pwd):ok", "text:It is /tmp."]);
  assert.equal(transcript.blocks[1].result, "/tmp");
  transcript.clear();
  assert.deepEqual(describe(transcript), []);
  assert.equal(transcript.lastAnswer(), "");
});

test("argsPreview is one bounded line for any arguments", () => {
  assert.equal(argsPreview(undefined), "");
  assert.equal(argsPreview({}), "");
  assert.equal(argsPreview({ command: "echo  hi\n  there" }), "echo hi there");
  assert.equal(argsPreview({ path: "src/a.ts", content: "x".repeat(100_000) }), "src/a.ts");
  assert.equal(argsPreview({ limit: 5, deep: { a: 1 }, list: [1, 2] }), "limit=5 deep={…} list=[2]");
  const huge = argsPreview({ blob: "y".repeat(1_000_000), other: "z".repeat(1_000_000) });
  assert.ok(huge.length <= 160 && !huge.includes("\n"), huge);
});
