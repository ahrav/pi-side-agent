import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { launchArgs, piInvocation, SideProcess } from "../extensions/side-agent/process.ts";
import { CHILD_ENV, SIDE_AGENT_PROMPT } from "../extensions/side-agent/protocol.ts";
import { Transcript } from "../extensions/side-agent/transcript.ts";
import { alive, bridgePath, root, scriptedPi, tempDir, until } from "./support/fakes.mjs";

/**
 * Starts pi in RPC mode with the bridge and the scripted provider. `onBridge` answers the bridge's
 * calls; without it every call gets the reply `ok`. Returns the process with what it received.
 */
function start(t, script, onBridge) {
  const home = tempDir(t);
  const pi = scriptedPi(home, script);
  const records = [];
  const calls = [];
  const transcript = new Transcript();
  const state = { exit: undefined };
  const side = new SideProcess({
    invocation: pi.invocation([...launchArgs({ bridgePath, sessionDir: path.join(home, "sessions"), trusted: true, systemPrompt: SIDE_AGENT_PROMPT }), ...pi.extraArgs]),
    cwd: home,
    env: pi.env,
    onRecord: (record) => {
      records.push(record);
      transcript.apply(record);
    },
    onBridge: (message) => {
      calls.push(message);
      if (message.t !== "call") return;
      if (onBridge) onBridge(message, side);
      else side.reply({ t: "reply", id: message.id, ok: true, result: message.method === "snapshot" ? { unchanged: true } : "ok" });
    },
    onExit: (exit) => {
      state.exit = exit;
    },
  });
  side.start();
  t.after(() => side.stop());
  const settled = (count = 1) => until(() => records.filter((record) => record.type === "agent_settled").length >= count, { label: `${count} settled runs` });
  return { side, records, calls, transcript, pi, state, settled };
}

const describe = (transcript) => transcript.blocks.map((block) => (block.kind === "tool" ? `tool:${block.name}:${block.status}:${block.result}` : `${block.kind}:${block.text}`));

test("a scripted turn streams into the transcript and its bridge calls reach the host", { timeout: 60_000 }, async (t) => {
  const script = [
    { thinking: "I should look.", tools: [{ name: "main_agent_read", arguments: { limit: 5 } }] },
    { tools: [{ name: "main_agent_send", arguments: { message: "run the tests", wait_for_reply: true, timeout_seconds: 30 } }] },
    { text: "All done **here**." },
  ];
  const { side, calls, transcript, pi, settled } = start(t, script, (message, process) => {
    if (message.method === "snapshot") process.reply({ t: "reply", id: message.id, ok: true, result: { unchanged: false, leafId: "L1", text: "Main agent: idle" } });
    else if (message.method === "read") process.reply({ t: "reply", id: message.id, ok: true, result: "STATUS and transcript" });
    else setTimeout(() => process.reply({ t: "reply", id: message.id, ok: true, result: "Main agent replied:\n\ngreen" }), 100);
  });
  const state = await side.request({ type: "get_state" });
  assert.equal(`${state.model.provider}/${state.model.id}`, "scripted/script");
  assert.deepEqual(await side.request({ type: "prompt", message: "do it", streamingBehavior: "steer" }), { disposition: "started" }, "a streaming behavior is accepted while idle");
  await settled();

  assert.deepEqual(describe(transcript), [
    "user:do it",
    "thinking:I should look.",
    "tool:main_agent_read:ok:STATUS and transcript",
    "tool:main_agent_send:ok:Main agent replied:\n\ngreen",
    "text:All done **here**.",
  ]);
  assert.deepEqual(calls.map((call) => [call.method, call.params]), [
    ["snapshot", {}],
    ["read", { limit: 5 }],
    ["send", { message: "run the tests", wait_for_reply: true, timeout_seconds: 30 }],
  ]);

  const requests = pi.requests();
  assert.equal(requests.length, 3);
  assert.ok(JSON.stringify(requests[0].messages[0]).includes("<side_agent>"), "the system prompt carries the side agent's role");
  assert.ok(JSON.stringify(requests[0].messages[0]).includes("Use main_agent_read before answering"), "the bridge tools add their guidance");
  const snapshot = requests[0].messages.slice(1).find((message) => JSON.stringify(message).includes("<main_agent_snapshot>"));
  assert.ok(snapshot && JSON.stringify(snapshot).includes("Main agent: idle"), "the first run carries the main agent snapshot");

  await side.request({ type: "prompt", message: "again", streamingBehavior: "steer" });
  await settled(2);
  assert.deepEqual(calls.at(-1), { t: "call", id: calls.at(-1).id, method: "snapshot", params: { since: "L1" } }, "a later run asks only for a newer snapshot");
});

test("records the window ignores are dropped before they are parsed", { timeout: 60_000 }, async (t) => {
  const { side, records, settled } = start(t, [{ tools: [{ name: "bash", arguments: { command: "echo hi" } }] }, { text: "ok" }]);
  await side.request({ type: "prompt", message: "run", streamingBehavior: "steer" });
  await settled();
  const seen = new Set(records.map((record) => (record.message?.role ? `${record.type}:${record.message.role}` : record.type)));
  for (const dropped of ["agent_end", "turn_start", "turn_end", "tool_execution_update", "message_start:system", "message_end:system", "message_start:toolResult", "message_end:toolResult", "message_end:user"]) {
    assert.equal(seen.has(dropped), false, `${dropped} reached the host`);
  }
  for (const kept of ["agent_start", "message_start:user", "message_start:assistant", "message_end:assistant", "tool_execution_start", "tool_execution_end", "agent_settled"]) {
    assert.equal(seen.has(kept), true, `${kept} is missing`);
  }
  const { bytes, deliveredBytes, skipped } = side.stats;
  assert.ok(skipped >= 8, `${skipped} records skipped`);
  assert.ok(deliveredBytes < bytes / 3, `parsed ${deliveredBytes} of ${bytes} bytes`);
});

test("the model and thinking level change over RPC", { timeout: 60_000 }, async (t) => {
  const { side, pi, settled } = start(t, [{ text: "one" }, { text: "two" }]);
  const { models } = await side.request({ type: "get_available_models" });
  assert.ok(models.some((model) => model.provider === "scripted" && model.id === "script-2"));

  const selected = await side.request({ type: "set_model", provider: "scripted", modelId: "script-2" });
  assert.equal(selected.id, "script-2");
  await side.request({ type: "prompt", message: "hi", streamingBehavior: "steer" });
  await settled();
  assert.equal(pi.requests().at(-1).model, "script-2", "the next request uses the selected model");

  const cycled = await side.request({ type: "cycle_model" });
  assert.equal(cycled.model.id, "script", "cycling moves through the scoped models");
  await side.request({ type: "set_thinking_level", level: "high" });
  assert.equal((await side.request({ type: "get_state" })).thinkingLevel, "high");
  await assert.rejects(side.request({ type: "set_model", provider: "nope", modelId: "missing" }), /Model not found: nope\/missing/);
});

test("abort ends a running turn and leaves the process ready for the next prompt", { timeout: 60_000 }, async (t) => {
  const { side, transcript, settled } = start(t, [{ delayMs: 60_000, text: "never" }, { text: "after abort" }]);
  await side.request({ type: "prompt", message: "wait", streamingBehavior: "steer" });
  await until(() => transcript.busy, { label: "the run to start" });
  await side.request({ type: "abort" });
  await settled();
  assert.equal(transcript.busy, false);
  assert.deepEqual(describe(transcript), ["user:wait", "notice:Aborted."]);
  assert.equal(side.running, true);
});

test("a prompt sent during a run is queued and answered after it", { timeout: 60_000 }, async (t) => {
  const { side, transcript, settled } = start(t, [{ delayMs: 400, text: "first answer" }, { text: "second answer" }]);
  assert.deepEqual(await side.request({ type: "prompt", message: "one", streamingBehavior: "steer" }), { disposition: "started" });
  await until(() => transcript.busy, { label: "the run to start" });
  assert.deepEqual(await side.request({ type: "prompt", message: "two", streamingBehavior: "followUp" }), { disposition: "queued" });
  await until(() => transcript.queued.length === 1, { label: "the queue update" });
  await settled();
  assert.deepEqual(describe(transcript), ["user:one", "text:first answer", "user:two", "text:second answer"]);
  assert.deepEqual(transcript.queued, []);
});

test("a bridge call the host rejects fails the tool, not the session", { timeout: 60_000 }, async (t) => {
  const { side, transcript, settled } = start(t, [{ tools: [{ name: "main_agent_send", arguments: { message: "x" } }] }, { text: "handled" }], (message, process) => {
    if (message.method === "snapshot") process.reply({ t: "reply", id: message.id, ok: true, result: { unchanged: true } });
    else process.reply({ t: "reply", id: message.id, ok: false, error: "The main session is not available." });
  });
  await side.request({ type: "prompt", message: "send", streamingBehavior: "steer" });
  await settled();
  assert.deepEqual(describe(transcript), ["user:send", "tool:main_agent_send:error:The main session is not available.", "text:handled"]);
});

test("a side agent that also loads the installed package gets the bridge tools once", { timeout: 60_000 }, async (t) => {
  const home = tempDir(t);
  const pi = scriptedPi(home, [{ tools: [{ name: "main_agent_read", arguments: {} }] }, { text: "read it" }]);
  const transcript = new Transcript();
  const side = new SideProcess({
    invocation: pi.invocation([...launchArgs({ bridgePath, sessionDir: path.join(home, "sessions"), trusted: true, systemPrompt: SIDE_AGENT_PROMPT }), ...pi.extraArgs, "-e", root]),
    cwd: home,
    env: pi.env,
    onRecord: (record) => transcript.apply(record),
    onBridge: (message) => message.t === "call" && side.reply({ t: "reply", id: message.id, ok: true, result: message.method === "snapshot" ? { unchanged: true } : "main session text" }),
    onExit() {},
  });
  side.start();
  t.after(() => side.stop());
  const commands = (await side.request({ type: "get_commands" })).commands.map((command) => command.name);
  assert.deepEqual(commands.filter((name) => name === "sa" || name === "side-agent"), [], "the host extension registers no command in the side agent");
  await side.request({ type: "prompt", message: "read", streamingBehavior: "steer" });
  await until(() => transcript.blocks.some((block) => block.kind === "text" && block.text === "read it"), { label: "the answer" });
  assert.deepEqual(describe(transcript), ["user:read", "tool:main_agent_read:ok:main session text", "text:read it"]);
});

test("a handler that throws leaves the stream and later records intact", { timeout: 60_000 }, async (t) => {
  const home = tempDir(t);
  const pi = scriptedPi(home, [{ text: "still here" }]);
  const seen = [];
  const side = new SideProcess({
    invocation: pi.invocation([...launchArgs({ bridgePath, sessionDir: path.join(home, "sessions"), trusted: true, systemPrompt: SIDE_AGENT_PROMPT }), ...pi.extraArgs]),
    cwd: home,
    env: pi.env,
    onRecord: (record) => {
      seen.push(record.type);
      throw new Error("handler failure");
    },
    onBridge: () => {
      throw new Error("bridge failure");
    },
    onExit: () => {
      throw new Error("exit failure");
    },
  });
  side.start();
  t.after(() => side.stop());
  await side.request({ type: "prompt", message: "hi", streamingBehavior: "steer" });
  await until(() => seen.includes("agent_settled"), { label: "the run to settle" });
  assert.ok(seen.includes("message_end"), "records keep arriving after a handler threw");
  assert.equal((await side.request({ type: "get_state" })).isStreaming, false, "requests still resolve");
});

test("stop ends the process and rejects the requests it still owes", { timeout: 60_000 }, async (t) => {
  const { side, state } = start(t, []);
  await side.request({ type: "get_state" });
  const pid = side.pid;
  assert.equal(alive(pid), true);
  const pending = side.request({ type: "bash", command: "sleep 30" });
  side.stop();
  await assert.rejects(pending, /The side agent process exited\./);
  await until(() => state.exit !== undefined, { label: "exit" });
  assert.equal(side.running, false);
  assert.equal(alive(pid), false);
  await assert.rejects(side.request({ type: "get_state" }), /not running/);
  side.stop();
});

test("the side agent exits when its host process dies", { timeout: 60_000 }, async (t) => {
  const home = tempDir(t);
  const parent = spawn(process.execPath, [path.join(root, "tests/support/orphan-parent.mjs"), home], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => parent.kill("SIGKILL"));
  let output = "";
  parent.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await until(() => output.includes("\n"), { label: "the side agent pid" });
  const pid = Number(output.trim());
  t.after(() => alive(pid) && process.kill(pid, "SIGKILL"));
  assert.equal(alive(pid), true);
  parent.kill("SIGKILL");
  await until(() => !alive(pid), { timeoutMs: 30_000, label: "the orphaned side agent to exit" });
});

test("a command that cannot start reports an exit instead of throwing", { timeout: 30_000 }, async (t) => {
  const state = { exit: undefined };
  const side = new SideProcess({ invocation: { command: path.join(tempDir(t), "no-such-pi"), args: [] }, cwd: process.cwd(), onRecord() {}, onBridge() {}, onExit: (exit) => (state.exit = exit) });
  side.start();
  await until(() => state.exit !== undefined, { label: "the spawn failure" });
  assert.match(state.exit.stderr, /ENOENT/);
  assert.equal(side.running, false);
});

test("launchArgs and piInvocation build the side agent's command line", () => {
  const args = launchArgs({ bridgePath: "/x/child.ts", sessionDir: "/s", trusted: false, systemPrompt: "PROMPT", sessionFile: "/s/a.jsonl" });
  assert.deepEqual(args, ["--mode", "rpc", "--session-dir", "/s", "-e", "/x/child.ts", "--append-system-prompt", "PROMPT", "--no-approve", "--session", "/s/a.jsonl"]);
  assert.deepEqual(launchArgs({ bridgePath: "b", sessionDir: "s", trusted: true, systemPrompt: "p" }).slice(-1), ["--approve"]);
  const invocation = piInvocation(["--mode", "rpc"]);
  assert.deepEqual(invocation, { command: process.execPath, args: [process.argv[1], "--mode", "rpc"] }, "a Node host restarts its own entry script");
  assert.equal(CHILD_ENV, "PI_SIDE_AGENT_CHILD");
});
