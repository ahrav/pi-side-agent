import assert from "node:assert/strict";
import test from "node:test";
import bridge from "../extensions/side-agent/child.ts";
import { CHILD_ENV, SNAPSHOT_MESSAGE_TYPE } from "../extensions/side-agent/protocol.ts";
import { fakePi } from "./support/fakes.mjs";

/**
 * Loads the bridge as it loads in a side agent process: the child environment variable set and an IPC
 * channel present. `sent` collects what the bridge sends to the host; `answer` delivers a host reply.
 */
function load(t) {
  const sent = [];
  const listeners = { message: process.listeners("message"), disconnect: process.listeners("disconnect") };
  process.env[CHILD_ENV] = "1";
  process.send = (message) => sent.push(message);
  process.connected = true;
  t.after(() => {
    delete process.env[CHILD_ENV];
    delete process.send;
    delete process.connected;
    for (const event of ["message", "disconnect"]) {
      for (const listener of process.listeners(event)) if (!listeners[event].includes(listener)) process.removeListener(event, listener);
    }
  });
  const pi = fakePi();
  bridge(pi);
  pi.emit("session_start", { reason: "startup" }, {});
  const answer = (reply) => process.emit("message", { t: "reply", ...reply });
  const beforeRun = (event = { messageType: "user", prompt: "hi" }) => pi.handlers.get("before_agent_start")[0](event, {});
  return { pi, sent, answer, beforeRun };
}

test("the bridge registers nothing outside a side agent process", () => {
  const plain = fakePi();
  bridge(plain);
  assert.deepEqual([plain.tools.size, plain.handlers.size], [0, 0], "no child environment variable");

  process.env[CHILD_ENV] = "1";
  try {
    const noChannel = fakePi();
    bridge(noChannel);
    assert.deepEqual([noChannel.tools.size, noChannel.handlers.size], [0, 0], "no IPC channel");
  } finally {
    delete process.env[CHILD_ENV];
  }
});

test("the bridge gives the side agent two tools with guidance for when to use them", (t) => {
  const { pi } = load(t);
  assert.deepEqual([...pi.tools.keys()], ["main_agent_read", "main_agent_send"]);
  const read = pi.tools.get("main_agent_read");
  const send = pi.tools.get("main_agent_send");
  assert.deepEqual(Object.keys(read.parameters.properties), ["limit", "before", "query", "max_chars", "tool_output_chars"]);
  assert.deepEqual(read.parameters.required ?? [], []);
  assert.deepEqual(send.parameters.required, ["message"]);
  assert.deepEqual(send.parameters.properties.delivery.enum, ["steer", "follow_up", "next_turn"]);
  for (const tool of [read, send]) {
    assert.ok(tool.promptSnippet.length > 0);
    assert.ok(tool.promptGuidelines.every((line) => line.includes(tool.name)), "each guideline names its tool");
  }
});

test("a tool call is one request to the host and returns the host's reply", async (t) => {
  const { pi, sent, answer } = load(t);
  const reading = pi.tools.get("main_agent_read").execute("call-1", { limit: 3 }, undefined);
  assert.deepEqual(sent, [{ t: "call", id: 1, method: "read", params: { limit: 3 } }]);
  answer({ id: 1, ok: true, result: "STATUS" });
  assert.deepEqual(await reading, { content: [{ type: "text", text: "STATUS" }], details: {} });

  const sending = pi.tools.get("main_agent_send").execute("call-2", { message: "hi" }, undefined);
  answer({ id: 2, ok: false, error: "message is empty." });
  await assert.rejects(sending, /message is empty\./, "a host error fails the tool call");
  answer({ id: 2, ok: true, result: "late" });
  answer({ id: 99, ok: true, result: "unknown" });
});

test("an aborted or unanswered call tells the host to stop waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pi, sent } = load(t);
  const controller = new AbortController();
  const aborted = pi.tools.get("main_agent_send").execute("c", { message: "q", wait_for_reply: true }, controller.signal);
  controller.abort();
  await assert.rejects(aborted, /Aborted\./);
  assert.deepEqual(sent.at(-1), { t: "cancel", id: 1 });

  const already = new AbortController();
  already.abort();
  await assert.rejects(pi.tools.get("main_agent_read").execute("c", {}, already.signal), /Aborted\./);
  assert.equal(sent.length, 2, "a call aborted before it starts sends nothing");

  const quick = pi.tools.get("main_agent_read").execute("c", {}, undefined);
  t.mock.timers.tick(10_000);
  await assert.rejects(quick, /did not answer in time/);
  assert.deepEqual(sent.at(-1), { t: "cancel", id: 2 });

  const waiting = pi.tools.get("main_agent_send").execute("c", { message: "q", wait_for_reply: true, timeout_seconds: 60 }, undefined);
  let settled = false;
  waiting.catch(() => (settled = true));
  t.mock.timers.tick(69_999);
  await Promise.resolve();
  assert.equal(settled, false, "a waiting send outlasts the host's reply timeout by ten seconds");
  t.mock.timers.tick(1);
  await assert.rejects(waiting, /did not answer in time/);
});

test("each run asks for the main agent's snapshot and injects it when it changed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sent, answer, beforeRun } = load(t);
  const first = beforeRun();
  assert.deepEqual(sent[0], { t: "call", id: 1, method: "snapshot", params: {} });
  answer({ id: 1, ok: true, result: { unchanged: false, leafId: "leaf-1", text: "Main agent: idle" } });
  assert.deepEqual(await first, { message: { customType: SNAPSHOT_MESSAGE_TYPE, content: "<main_agent_snapshot>\nMain agent: idle\n</main_agent_snapshot>", display: false } });

  const second = beforeRun();
  assert.deepEqual(sent[1].params, { since: "leaf-1" });
  answer({ id: 2, ok: true, result: { unchanged: true } });
  assert.equal(await second, undefined);

  const slow = beforeRun();
  t.mock.timers.tick(1500);
  assert.equal(await slow, undefined, "a run starts without the snapshot when the host is slow");
  assert.equal(await beforeRun({ messageType: "custom" }), undefined, "only user prompts get a snapshot");
});

test("losing the host fails pending calls and schedules the process to exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const exits = [];
  t.mock.method(process, "exit", (code) => exits.push(code));
  const { pi } = load(t);
  const pending = pi.tools.get("main_agent_read").execute("c", {}, undefined);
  process.connected = false;
  process.emit("disconnect");
  await assert.rejects(pending, /The main pi process disconnected\./);
  await assert.rejects(pi.tools.get("main_agent_read").execute("c", {}, undefined), /not connected/);
  t.mock.timers.tick(14_999);
  assert.deepEqual(exits, []);
  t.mock.timers.tick(1);
  assert.deepEqual(exits, [0], "the side agent exits 15 seconds after its host is gone");
});
