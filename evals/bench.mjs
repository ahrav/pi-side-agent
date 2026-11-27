// Measures what the side agent costs the main pi process: loading the extension, reading the side agent's
// RPC stream, drawing the window, and the event-loop delay while a side agent streams.
//
//   node evals/bench.mjs          synthetic and scripted-provider measurements
//   node evals/bench.mjs --real   also start `pi` from PATH with your configuration and report startup and memory
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { JsonlReader, wantsRecord } from "../extensions/side-agent/jsonl.ts";
import { launchArgs, SideProcess } from "../extensions/side-agent/process.ts";
import { SIDE_AGENT_PROMPT } from "../extensions/side-agent/protocol.ts";
import { Transcript } from "../extensions/side-agent/transcript.ts";
import { SideWindow } from "../extensions/side-agent/view.ts";
import { bridgePath, editorTheme, fakeTui, keys, markdownTheme, scriptedPi, theme } from "../tests/support/fakes.mjs";

const ms = (value) => `${value.toFixed(value < 10 ? 2 : 1)} ms`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
const report = (section, metric, value) => rows.push({ section, metric, value });

function timed(run, repeats = 7) {
  const samples = [];
  for (let index = 0; index < repeats; index++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const PARAGRAPH = "The side agent reads the main agent's **session** on demand and renders `markdown` as it streams. ";
const markdown = (chars) => {
  const parts = [];
  for (let index = 0, length = 0; length < chars; index++) {
    const part = index % 4 === 3 ? "```ts\nconst value = compute(input);\n```\n\n" : `${index % 6 === 0 ? `## Section ${index}\n\n` : ""}${PARAGRAPH.repeat(3)}\n\n- first point\n- second point\n\n`;
    parts.push(part);
    length += part.length;
  }
  return parts.join("").slice(0, chars);
};

function window(transcript, { rowCount = 54, columns = 200, activity } = {}) {
  const tui = fakeTui(60, columns);
  const actions = new Proxy({}, { get: () => () => {} });
  let since = 0;
  const running = () => {
    const label = transcript.activity();
    since = label ? since || performance.now() : 0;
    return label ? { label, since } : undefined;
  };
  const side = new SideWindow({ tui, theme, keys, markdownTheme, editorTheme, transcript, cwd: process.cwd(), toggleKey: "alt+a", rows: () => rowCount, busy: () => transcript.busy, activity: activity ?? running, outbox: () => [], title: () => "side agent · provider/model", state: () => "working…", note: () => "", actions });
  side.focused = true;
  return { side, tui };
}

// One side agent run as pi writes it, with the record sizes measured on a full configuration: a 630 KB system
// message at its start and end, a 630 KB agent_end, a streamed answer, and a tool call with streamed output.
function syntheticRun({ answerChars = 24_000, toolUpdates = 120, toolOutputChars = 48_000 } = {}) {
  const usage = { input: 81234, output: 1234, cacheRead: 80000, cacheWrite: 1234, totalTokens: 82468, cost: { input: 0.012, output: 0.006, cacheRead: 0.008, cacheWrite: 0.001, total: 0.027 } };
  const update = (event) => JSON.stringify({ type: "message_update", usage, assistantMessageEvent: event });
  const system = { role: "system", content: "", sections: { preamble: "p".repeat(40_000), skills: "s".repeat(180_000) }, toolsAdded: Array.from({ length: 100 }, (_, index) => ({ name: `tool_${index}`, description: "d".repeat(1500), parameters: { type: "object", properties: { a: { type: "string", description: "x".repeat(2400) } } } })) };
  const answer = markdown(answerChars);
  const output = "line of tool output\n".repeat(Math.ceil(toolOutputChars / 20)).slice(0, toolOutputChars);
  const lines = [
    '{"type":"agent_start"}',
    '{"type":"turn_start"}',
    JSON.stringify({ type: "message_start", message: system }),
    JSON.stringify({ type: "message_end", message: system }),
    JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Explain the design." }] } }),
    JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Explain the design." }] } }),
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
    update({ type: "text_start", contentIndex: 0 }),
  ];
  for (let offset = 0; offset < answer.length; offset += 8) lines.push(update({ type: "text_delta", contentIndex: 0, delta: answer.slice(offset, offset + 8) }));
  lines.push(update({ type: "text_end", contentIndex: 0, content: answer }));
  const toolCall = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "npm test" } };
  lines.push(update({ type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "bash" }), update({ type: "toolcall_end", contentIndex: 1, toolCall }));
  const assistant = { role: "assistant", content: [{ type: "text", text: answer }, toolCall], stopReason: "toolUse", usage };
  lines.push(JSON.stringify({ type: "message_end", message: assistant }));
  lines.push(JSON.stringify({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: toolCall.arguments }));
  for (let index = 1; index <= toolUpdates; index++) {
    const partial = output.slice(0, Math.floor((output.length * index) / toolUpdates));
    lines.push(JSON.stringify({ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: toolCall.arguments, partialResult: { content: [{ type: "text", text: partial }], details: {} } }));
  }
  const result = { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: output }], isError: false };
  lines.push(JSON.stringify({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: result.content, details: {} }, isError: false, durationMs: 4200 }));
  lines.push(JSON.stringify({ type: "message_start", message: result }), JSON.stringify({ type: "message_end", message: result }));
  lines.push(JSON.stringify({ type: "turn_end", message: assistant, toolResults: [result] }));
  lines.push(JSON.stringify({ type: "agent_end", messages: [system, assistant, result] }), '{"type":"agent_settled","aborted":false}');
  return Buffer.from(`${lines.join("\n")}\n`);
}

function benchLoad() {
  const script = [
    'for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "typebox"]) await import(name);',
    "const started = performance.now();",
    "const { default: extension } = await import(process.argv[1]);",
    "const imported = performance.now();",
    "const handlers = [];",
    "extension({ on: (event) => handlers.push(event), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} });",
    "console.log(JSON.stringify({ imported: imported - started, registered: performance.now() - imported, handlers }));",
  ].join("\n");
  const home = fs.mkdtempSync(path.join(tmpdir(), "side-bench-"));
  const samples = [];
  for (let index = 0; index < 7; index++) {
    samples.push(JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, path.resolve("extensions/side-agent/index.ts")], { env: { ...process.env, PI_CODING_AGENT_DIR: home }, encoding: "utf8" })));
  }
  fs.rmSync(home, { recursive: true, force: true });
  report("load", "import the extension's own modules, pi's modules already loaded", ms(median(samples.map((sample) => sample.imported))));
  report("load", "run the extension factory", ms(median(samples.map((sample) => sample.registered))));
  report("load", "main-session handlers registered before first use", samples[0].handlers.join(", "));
}

function benchStream() {
  const bytes = syntheticRun();
  const feed = (onChunk) => {
    for (let offset = 0; offset < bytes.length; offset += 65_536) onChunk(bytes.subarray(offset, offset + 65_536));
  };
  let stats;
  const reader = timed(() => {
    const transcript = new Transcript();
    const lineReader = new JsonlReader(wantsRecord, (line) => transcript.apply(JSON.parse(line)));
    feed((chunk) => lineReader.push(chunk));
    stats = lineReader.stats;
  });
  const naive = timed(() => {
    const transcript = new Transcript();
    let buffer = "";
    feed((chunk) => {
      buffer += chunk.toString("utf8");
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) transcript.apply(JSON.parse(line));
      }
    });
  });
  report("stream", "one run on the wire (3,000 deltas, 120 tool updates, full prompt three times)", `${mb(bytes.length)}, ${stats.lines} records`);
  report("stream", "bytes parsed after classification", `${mb(stats.deliveredBytes)} (${((stats.deliveredBytes / bytes.length) * 100).toFixed(1)}%), ${stats.delivered} records`);
  report("stream", "host time to read and apply the run", ms(reader));
  report("stream", "same run with every record parsed", `${ms(naive)} (${(naive / reader).toFixed(1)}x)`);
}

function benchRender() {
  for (const blocks of [10, 1000, 10_000]) {
    const transcript = new Transcript();
    for (let index = 0; index < blocks / 2; index++) {
      transcript.apply({ type: "message_start", message: { role: "user", content: `question ${index}` } });
      transcript.apply({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: markdown(600) }] } });
    }
    const { side } = window(transcript);
    const first = timed(() => {
      for (const block of transcript.blocks) block.cache = undefined;
      side.touch();
      side.render(184);
    }, 5);
    const cached = timed(() => side.render(184), 2001);
    report("render", `${blocks} blocks: frame at the end of the transcript, cold`, ms(first));
    report("render", `${blocks} blocks: unchanged frame`, `${(cached * 1000).toFixed(1)} µs`);
    let since = performance.now();
    const waiting = window(transcript, { activity: () => ({ label: "Thinking…", since }) }).side;
    waiting.render(184);
    const spinner = timed(() => {
      since -= 100;
      waiting.render(184);
    }, 201);
    waiting.dispose();
    report("render", `${blocks} blocks: frame that advances the activity spinner`, `${(spinner * 1000).toFixed(1)} µs, ten a second = ${spinner.toFixed(2)}% of one core`);
  }
  for (const chars of [2000, 20_000, 80_000]) {
    const transcript = new Transcript();
    transcript.apply({ type: "message_start", message: { role: "assistant", content: [] } });
    transcript.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: markdown(chars) } });
    const { side } = window(transcript);
    side.render(184);
    const frame = timed(() => {
      transcript.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " more" } });
      side.render(184);
    }, 15);
    const interval = Math.min(500, Math.max(50, frame * 50));
    report("render", `streaming answer of ${chars} chars: frame after a delta`, `${ms(frame)}, one frame per ${Math.round(interval)} ms = ${((frame / interval) * 100).toFixed(1)}% of one core`);
  }
}

// A real pi process streams a scripted answer into a transcript. With `draw`, a window renders it through a fake
// TUI that draws at most one frame every 16 ms. With `monitor`, the event-loop delay of this process is sampled
// every millisecond. Sampling costs CPU, so the CPU figures come from the runs with `monitor` off.
async function liveRun({ draw, monitor, chars = 0, paceMs = 0, script }) {
  const home = fs.mkdtempSync(path.join(tmpdir(), "side-bench-"));
  script ??= [{ text: markdown(chars * 0.8), paceMs, tools: [{ name: "bash", arguments: { command: 'for i in $(seq 1 400); do echo "output line $i of the tool"; done' } }] }, { text: markdown(chars * 0.2), paceMs }];
  const pi = scriptedPi(home, script);
  const transcript = new Transcript();
  const { side, tui } = window(transcript);
  const result = { frames: 0, renderMs: 0 };
  let scheduled = false;
  tui.requestRender = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const started = performance.now();
      const rebuilds = side.rebuilds;
      side.render(184);
      if (side.rebuilds === rebuilds) return;
      result.frames += 1;
      result.renderMs += performance.now() - started;
    }, 16);
  };
  let finish;
  const settled = new Promise((resolve) => (finish = resolve));
  const child = new SideProcess({
    invocation: pi.invocation([...launchArgs({ bridgePath, sessionDir: path.join(home, "sessions"), trusted: true, systemPrompt: SIDE_AGENT_PROMPT }), ...pi.extraArgs]),
    cwd: home,
    env: pi.env,
    onRecord: (record) => {
      const version = transcript.version;
      transcript.apply(record);
      if (draw && transcript.version !== version) side.contentChanged();
      if (record.type === "agent_settled") finish();
    },
    onBridge: (message) => message.t === "call" && child.reply({ t: "reply", id: message.id, ok: true, result: { unchanged: true } }),
    onExit() {},
  });
  child.start();
  await child.request({ type: "get_state" });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const delay = monitor ? monitorEventLoopDelay({ resolution: 1 }) : undefined;
  const cpu = process.cpuUsage();
  const started = performance.now();
  delay?.enable();
  await child.request({ type: "prompt", message: "go", streamingBehavior: "steer" });
  await settled;
  delay?.disable();
  result.elapsed = performance.now() - started;
  const used = process.cpuUsage(cpu);
  result.cpuMs = (used.user + used.system) / 1000;
  result.stats = child.stats;
  result.delay = delay;
  child.stop();
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

async function benchLive() {
  const share = (run) => `${ms(run.cpuMs)} = ${((run.cpuMs / run.elapsed) * 100).toFixed(1)}% of one core`;
  const nanos = (value) => ms(value / 1e6);
  // The scripted provider emits five characters per delta. `paceMs` sets the delay between deltas: 10 ms gives
  // the model-rate stream and 1 ms gives the fast stream. Each row reports the record rate it measured.
  for (const [label, chars, paceMs] of [["model-rate stream", 4000, 10], ["fast stream", 30_000, 1]]) {
    const closed = await liveRun({ draw: false, monitor: false, chars, paceMs });
    const open = await liveRun({ draw: true, monitor: false, chars, paceMs });
    const sampled = await liveRun({ draw: true, monitor: true, chars, paceMs });
    const { stats } = open;
    report("live", `${label}: ${chars} chars of answer at ${Math.round(stats.delivered / (open.elapsed / 1000))} records/s, one tool call`, `${(open.elapsed / 1000).toFixed(1)} s, ${mb(stats.bytes)} on the wire, ${stats.delivered} of ${stats.lines} records parsed`);
    report("live", `${label}: host CPU, window closed`, share(closed));
    report("live", `${label}: host CPU, window open`, `${share(open)}; ${open.frames} frames drawn in ${ms(open.renderMs)}`);
    report("live", `${label}: event-loop delay p50 / p99 / max`, `${nanos(sampled.delay.percentile(50))} / ${nanos(sampled.delay.percentile(99))} / ${nanos(sampled.delay.max)}`);
  }
  const wait = [{ delayMs: 6000, text: "done" }];
  const quiet = await liveRun({ draw: false, monitor: false, script: wait });
  const spinning = await liveRun({ draw: true, monitor: false, script: wait });
  report("live", "waiting 6 s for the model: host CPU, window closed", share(quiet));
  report("live", "waiting 6 s for the model: host CPU, window open", `${share(spinning)}; ${spinning.frames} frames drawn in ${ms(spinning.renderMs)}`);
  const idle = monitorEventLoopDelay({ resolution: 1 });
  idle.enable();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  idle.disable();
  report("live", "event-loop delay of the same process when idle: p50 / p99 / max", `${nanos(idle.percentile(50))} / ${nanos(idle.percentile(99))} / ${nanos(idle.max)}`);
}

// Starts `pi` from PATH with the user's configuration and the bridge extension, and reports startup and memory.
async function benchReal() {
  const home = fs.mkdtempSync(path.join(tmpdir(), "side-bench-"));
  const started = performance.now();
  const child = new SideProcess({
    invocation: { command: "pi", args: launchArgs({ bridgePath, sessionDir: path.join(home, "sessions"), trusted: true, systemPrompt: SIDE_AGENT_PROMPT }) },
    cwd: home,
    onRecord() {},
    onBridge() {},
    onExit() {},
  });
  child.start();
  await child.request({ type: "get_state" });
  const ready = performance.now() - started;
  const commands = (await child.request({ type: "get_commands" })).commands;
  const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" }).trim()) * 1024;
  const stopped = performance.now();
  const exited = new Promise((resolve) => spawn("sh", ["-c", `while kill -0 ${child.pid} 2>/dev/null; do sleep 0.05; done`]).on("exit", resolve));
  child.stop();
  await exited;
  fs.rmSync(home, { recursive: true, force: true });
  report("real", "your pi configuration: time until the side agent answers", `${(ready / 1000).toFixed(2)} s`);
  report("real", "resident memory of the side agent process", mb(rss));
  report("real", "commands, templates, and skills the side agent offers", String(commands.length));
  report("real", "time to exit after stop()", ms(performance.now() - stopped));
}

benchLoad();
benchStream();
benchRender();
await benchLive();
if (process.argv.includes("--real")) await benchReal();

let section = "";
for (const row of rows) {
  if (row.section !== section) console.log(`\n${row.section}`);
  section = row.section;
  console.log(`  ${row.metric.padEnd(84)} ${row.value}`);
}
