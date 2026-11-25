import assert from "node:assert/strict";
import test from "node:test";
import { HEAD_BYTES, JsonlReader, wantsRecord } from "../extensions/side-agent/jsonl.ts";

const usage = '{"input":123456,"output":7890,"cacheRead":123456,"cacheWrite":123456,"totalTokens":1234567,"cost":{"input":0.123456,"output":0.0123456,"cacheRead":0.0123456,"cacheWrite":0.0123456,"total":0.1234567}}';
const update = (event) => `{"type":"message_update","usage":${usage},"assistantMessageEvent":${JSON.stringify(event)}}`;

/** Feeds `bytes` to a new reader in chunks whose sizes `nextSize` returns, and collects what it delivers. */
function read(bytes, nextSize, wants = wantsRecord) {
  const lines = [];
  const reader = new JsonlReader(wants, (line) => lines.push(line));
  for (let offset = 0; offset < bytes.length; ) {
    const size = Math.max(1, nextSize());
    reader.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return { lines, stats: reader.stats };
}

/** Deterministic pseudo-random sizes, so a failure reproduces. */
function sizes(seed, max) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return 1 + (state % max);
  };
}

test("wantsRecord keeps the records the window shows and drops the ones it ignores", () => {
  const wanted = [
    '{"type":"agent_start"}',
    '{"type":"agent_settled","aborted":false}',
    '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"message_start","message":{"role":"custom","customType":"x","content":"c","display":true}}',
    '{"type":"message_start","message":{"role":"assistant","content":[]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    update({ type: "text_start", contentIndex: 0 }),
    update({ type: "text_delta", contentIndex: 0, delta: "Hello" }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "hm" }),
    update({ type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "bash" }),
    '{"type":"tool_execution_start","toolCallId":"c","toolName":"bash","args":{"command":"ls"}}',
    '{"type":"tool_execution_end","toolCallId":"c","toolName":"bash","result":{"content":[]},"isError":false}',
    '{"type":"queue_update","steering":[],"followUp":[]}',
    '{"type":"extension_ui_request","id":"7b112172-1f0d-4a1b-b482-724bb5fdf056","method":"confirm","title":"Proceed?"}',
    '{"type":"extension_ui_request","id":"7b112172-1f0d-4a1b-b482-724bb5fdf056","method":"notify","message":"m"}',
    '{"id":"r1","type":"response","command":"get_state","success":true,"data":{}}',
    '{"type":"some_future_event","data":1}',
    "not json at all",
  ];
  const unwanted = [
    "",
    '{"type":"agent_end","messages":[]}',
    '{"type":"turn_start"}',
    '{"type":"turn_end","message":{"role":"assistant"}}',
    '{"type":"tool_execution_update","toolCallId":"c","toolName":"bash","args":{},"partialResult":{}}',
    '{"type":"entry_appended","entry":{}}',
    '{"type":"message_start","message":{"role":"system","content":"","sections":{}}}',
    '{"type":"message_end","message":{"role":"system","content":"","sections":{}}}',
    '{"type":"message_start","message":{"role":"toolResult","toolCallId":"c"}}',
    '{"type":"message_end","message":{"role":"toolResult","toolCallId":"c"}}',
    '{"type":"message_end","message":{"role":"user","content":[]}}',
    '{"type":"message_end","message":{"role":"custom","customType":"x"}}',
    update({ type: "text_end", contentIndex: 0, content: "Hello" }),
    update({ type: "thinking_end", contentIndex: 0, content: "hm" }),
    update({ type: "toolcall_delta", contentIndex: 1, delta: '{"command"' }),
    update({ type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "c", name: "bash", arguments: {} } }),
    '{"type":"extension_ui_request","id":"7b112172-1f0d-4a1b-b482-724bb5fdf056","method":"setStatus","statusKey":"k"}',
    '{"type":"extension_ui_request","id":"7b112172-1f0d-4a1b-b482-724bb5fdf056","method":"setWidget","widgetKey":"k"}',
  ];
  for (const line of wanted) assert.equal(wantsRecord(line.slice(0, HEAD_BYTES)), true, line.slice(0, 80));
  for (const line of unwanted) assert.equal(wantsRecord(line.slice(0, HEAD_BYTES)), false, line.slice(0, 80));
});

test("a user message that quotes a skipped prefix is still delivered", () => {
  const line = JSON.stringify({ type: "message_start", message: { role: "user", content: '{"type":"agent_end" and "role":"system" and "method":"setStatus"' } });
  assert.equal(wantsRecord(line.slice(0, HEAD_BYTES)), true);
});

test("the delta type of a message_update lies inside the head the classifier sees", () => {
  const line = update({ type: "toolcall_delta", contentIndex: 1, delta: "x".repeat(2000) });
  assert.ok(line.indexOf('"toolcall_delta"') < HEAD_BYTES, "a usage object with seven-digit token counts fits in the head");
  assert.equal(wantsRecord(line.slice(0, HEAD_BYTES)), false);
});

test("every chunking of a stream delivers the same lines", () => {
  const big = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "α".repeat(3000) }] } });
  const records = [
    '{"type":"agent_start"}',
    `{"type":"message_start","message":{"role":"system","content":"${"s".repeat(70_000)}"}}`,
    '{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"héllo \u2028 wörld 🎉"}]}}',
    update({ type: "text_delta", contentIndex: 0, delta: "日本語" }),
    update({ type: "toolcall_delta", contentIndex: 1, delta: "{}" }),
    big,
    JSON.stringify({ type: "agent_end", messages: [{ role: "system", content: "x".repeat(90_000) }] }),
    "",
    '{"id":"r1","type":"response","command":"get_state","success":true,"data":{}}\r',
    '{"type":"agent_settled","aborted":false}',
  ];
  const bytes = Buffer.from(`${records.join("\n")}\n`);
  const expected = [records[0], records[2], records[3], big, records[8].slice(0, -1), records[9]];
  const whole = read(bytes, () => bytes.length);
  assert.deepEqual(whole.lines, expected);
  for (const max of [1, 2, 3, 7, 64, HEAD_BYTES - 1, HEAD_BYTES, HEAD_BYTES + 1, 4096, 65_536]) {
    const { lines, stats } = read(bytes, sizes(max, max));
    assert.deepEqual(lines, expected, `random chunks up to ${max} bytes`);
    assert.deepEqual(stats, whole.stats, `stats for chunks up to ${max} bytes`);
  }
  assert.equal(whole.stats.lines, records.length);
  assert.equal(whole.stats.delivered, expected.length);
  assert.equal(whole.stats.deliveredBytes, expected.reduce((sum, line) => sum + Buffer.byteLength(line), 0));
  assert.ok(whole.stats.deliveredBytes < bytes.length / 10, "the skipped records are most of the stream");
});

test("the classifier sees each line once, with at most HEAD_BYTES bytes", () => {
  const heads = [];
  const long = `{"type":"x","data":"${"d".repeat(5000)}"}`;
  const bytes = Buffer.from(`${long}\n{"type":"y"}\n`);
  const { lines } = read(bytes, sizes(5, 300), (head) => {
    heads.push(head);
    return true;
  });
  assert.deepEqual(lines, [long, '{"type":"y"}']);
  assert.deepEqual(heads, [long.slice(0, HEAD_BYTES), '{"type":"y"}']);
});

test("a rejected line holds no memory past its head", () => {
  const reader = new JsonlReader(() => false, () => assert.fail("a rejected line was delivered"));
  const chunk = Buffer.alloc(64 * 1024, "z");
  for (let i = 0; i < 64; i++) reader.push(chunk);
  assert.equal(reader.bufferedBytes, 0, "no byte of the rejected line is retained");
  reader.push(Buffer.from("\n"));
  assert.deepEqual(reader.stats, { bytes: 64 * 64 * 1024 + 1, lines: 1, delivered: 0, skipped: 1, deliveredBytes: 0 });
});

test("a line without a terminator is held until its LF arrives", () => {
  const lines = [];
  const reader = new JsonlReader(() => true, (line) => lines.push(line));
  reader.push(Buffer.from('{"type":"a"}'));
  assert.deepEqual(lines, []);
  reader.push(Buffer.from("\n"));
  assert.deepEqual(lines, ['{"type":"a"}']);
});
