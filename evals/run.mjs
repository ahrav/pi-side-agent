// Live evaluation of the side agent: starts `pi` with your configuration and a real model, puts a simulated
// main agent behind the bridge, and grades what the side agent does with each prompt.
//
//   node evals/run.mjs [--model <provider/id>] [--thinking <level>] [--trials <n>] [--only <name,name>]
//                      [--timeout <seconds>] [--pi <command>]
//
// `--timeout` bounds one scenario run and defaults to 240. `--pi` names the pi executable and defaults to `pi`.
//
// Each scenario runs in a fresh side session. Results are printed and saved under .eval-runs/.
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { MainBridge } from "../extensions/side-agent/main-bridge.ts";
import { launchArgs, SideProcess } from "../extensions/side-agent/process.ts";
import { SIDE_AGENT_PROMPT } from "../extensions/side-agent/protocol.ts";
import { Transcript } from "../extensions/side-agent/transcript.ts";
import { bridgePath, fakeContext, fakePi, root } from "../tests/support/fakes.mjs";


function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const RUN_TIMEOUT_MS = Number(option("timeout", "240")) * 1000;

const entry = (id, message) => ({ type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message });
const text = (value) => ({ type: "text", text: value });

// The main agent's session: a JWT migration. The snapshot the side agent receives holds only the latest user
// message and the latest assistant text, so the signing algorithm is found only by reading the session.
const MAIN_SESSION = [
  entry("m1", { role: "user", content: [text("Migrate the auth module from server sessions to JWT. Start with signing.")] }),
  entry("m2", { role: "assistant", stopReason: "toolUse", content: [text("I chose RS256 for signing, with key id auth-2031, so other services can verify tokens without the private key."), { type: "toolCall", id: "c1", name: "write", arguments: { path: "src/auth/jwt.ts" } }] }),
  entry("m3", { role: "toolResult", toolCallId: "c1", toolName: "write", content: [text("Wrote src/auth/jwt.ts")], isError: false }),
  entry("m4", { role: "assistant", stopReason: "stop", content: [text("Signing works. The verification middleware is next.")] }),
  entry("m5", { role: "user", content: [text("Good. Add refresh tokens after that.")] }),
  entry("m6", { role: "assistant", stopReason: "toolUse", content: [text("Adding refresh token rotation."), { type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/auth/refresh.ts" } }] }),
  entry("m7", { role: "toolResult", toolCallId: "c2", toolName: "edit", content: [text("Edited src/auth/refresh.ts")], isError: false }),
  entry("m8", { role: "assistant", stopReason: "stop", content: [text("Refresh token rotation is in place in src/auth/refresh.ts. Next I will run the test suite.")] }),
];

const okTool = (run, pattern) => run.tools.some((tool) => pattern.test(tool.name) && tool.status === "ok");
const sentText = (run) => run.sent.map((message) => message.message.details.text).join("\n");

// `grade` returns true for a pass, false for a fail, or "skip" when the configuration lacks what the scenario needs.
const SCENARIOS = [
  {
    name: "knows-main-task",
    prompt: "What is the main agent working on right now? Answer in one sentence.",
    grade: (run) => /refresh|jwt|auth/i.test(run.answer) && run.sent.length === 0,
  },
  {
    name: "reads-main-history",
    prompt: "Earlier in its session the main agent picked a signing algorithm. Which one, and what key id? Check its conversation.",
    grade: (run) => run.calls.includes("read") && /RS256/.test(run.answer) && /auth-2031/.test(run.answer),
  },
  {
    name: "relays-message",
    mainBusy: true,
    prompt: "Tell the main agent to also add a logout endpoint once it finishes what it is doing.",
    grade: (run) => run.sent.length === 1 && /logout/i.test(sentText(run)),
    note: (run) => `delivery ${run.sent[0]?.options.deliverAs ?? "none"}`,
  },
  {
    name: "asks-and-reports-reply",
    mainReply: "I am on the branch feature/jwt-auth.",
    prompt: "Ask the main agent which git branch it is on, and tell me what it says.",
    grade: (run) => run.sent.length === 1 && run.sent[0].message.details.expectsReply === true && /feature\/jwt-auth/.test(run.answer),
  },
  {
    name: "no-unprompted-message",
    prompt: "What is 17 times 23? Reply with the number only.",
    grade: (run) => /391/.test(run.answer) && run.sent.length === 0,
  },
  {
    name: "runs-tools",
    prompt: "Run `echo side-agent-eval-$((6*7))` in bash and tell me its exact output.",
    grade: (run) => okTool(run, /^bash$/) && /side-agent-eval-42/.test(run.answer),
  },
  {
    name: "web-access",
    prompt: "Use a web search tool to find the year Node.js was first released, and reply with the year. If you have no web search or fetch tool, reply exactly NO_WEB_TOOL.",
    grade: (run) => (/NO_WEB_TOOL/.test(run.answer) ? "skip" : okTool(run, /search|fetch|web/i) && /2009/.test(run.answer)),
  },
  {
    name: "skills-access",
    prompt: "Name two skills that are available to you. Reply with only the two skill names, one per line. If you have no skills, reply exactly NO_SKILLS.",
    grade: (run, side) => {
      if (side.skills.length === 0 || /NO_SKILLS/.test(run.answer)) return "skip";
      return side.skills.filter((name) => run.answer.includes(name)).length >= 2;
    },
  },
  {
    name: "mcp-access",
    prompt: "If you have a tool named `mcp` or tools whose names start with `mcp__`, call one of them to list the MCP servers or their tools, and reply with how many servers you can reach. If you have no such tool, reply exactly NO_MCP_TOOL.",
    grade: (run) => (/NO_MCP_TOOL/.test(run.answer) ? "skip" : okTool(run, /^mcp(__|$)/) && /\d/.test(run.answer)),
  },
];

/** Starts the side agent with a simulated main agent behind its bridge. */
async function startSide(piCommand, model, thinking) {
  const home = fs.mkdtempSync(path.join(tmpdir(), "side-eval-"));
  const cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "# Scratch project for the side agent evaluation\n");
  const pi = fakePi();
  const ctx = fakeContext({ cwd, branch: MAIN_SESSION });
  const side = { transcript: new Transcript(), calls: [], sent: [], models: new Set(), settled: undefined, mainReply: "OK.", skills: [], home };
  let exited;
  side.exit = new Promise((resolve) => (exited = resolve));
  const bridge = new MainBridge({ pi, context: () => ctx, touch() {}, reply: (reply) => child.reply(reply) });
  // The simulated main agent takes delivery at once and, when asked for a reply, answers with `mainReply`.
  pi.sendMessage = (message, options) => {
    side.sent.push({ message, options });
    setTimeout(() => {
      pi.emit("message_end", { message: { role: "custom", ...message } }, ctx);
      if (message.details.expectsReply) pi.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [text(side.mainReply)] } }, ctx);
    }, 250);
  };
  const child = new SideProcess({
    invocation: { command: piCommand, args: launchArgs({ bridgePath, sessionDir: path.join(home, "sessions"), trusted: true, systemPrompt: SIDE_AGENT_PROMPT }) },
    cwd,
    onRecord: (record) => {
      side.transcript.apply(record);
      if (record.type === "message_end" && record.message.model) side.models.add(`${record.message.provider}/${record.message.model}`);
      if (record.type === "agent_settled") side.settled?.();
    },
    onBridge: (message) => {
      if (message.t === "call") side.calls.push(message.method);
      bridge.handle(message);
    },
    onExit: (exit) => {
      side.settled?.(new Error(`pi exited: ${exit.stderr.slice(-400)}`));
      exited();
    },
  });
  child.start();
  bridge.attach();
  await child.request({ type: "get_state" });
  // Each scenario runs in a new session, so each scenario selects the model and thinking level again.
  side.select = async () => {
    if (model) {
      const slash = model.indexOf("/");
      await child.request({ type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
    }
    if (thinking) await child.request({ type: "set_thinking_level", level: thinking });
    const state = await child.request({ type: "get_state" });
    side.model = `${state.model?.provider}/${state.model?.id}`;
    side.thinking = state.thinkingLevel;
  };
  await side.select();
  side.skills = (await child.request({ type: "get_commands" })).commands.filter((command) => command.source === "skill").map((command) => command.name.replace(/^skill:/, ""));
  return { side, child, ctx };
}

async function runScenario(scenario, { side, child, ctx }) {
  await child.request({ type: "new_session" });
  await side.select();
  side.transcript.clear();
  side.calls.length = 0;
  side.sent.length = 0;
  side.mainReply = scenario.mainReply ?? "OK.";
  ctx.idle = scenario.mainBusy !== true;
  const started = performance.now();
  const settled = new Promise((resolve, reject) => {
    side.settled = (error) => (error ? reject(error) : resolve());
  });
  const timeout = setTimeout(() => side.settled(new Error("the run timed out")), RUN_TIMEOUT_MS);
  await child.request({ type: "prompt", message: scenario.prompt, streamingBehavior: "steer" });
  let error;
  await settled.catch((caught) => (error = caught.message));
  clearTimeout(timeout);
  if (error) await child.request({ type: "abort" }).catch(() => {});
  const stats = await child.request({ type: "get_session_stats" }).catch(() => ({}));
  const run = {
    answer: side.transcript.lastAnswer(),
    tools: side.transcript.blocks.filter((block) => block.kind === "tool").map((block) => ({ name: block.name, status: block.status, args: block.args })),
    calls: [...side.calls],
    sent: [...side.sent],
    seconds: (performance.now() - started) / 1000,
    cost: stats.cost ?? 0,
    error,
    notices: side.transcript.blocks.filter((block) => block.kind === "notice").map((block) => block.text),
  };
  const verdict = error ? false : scenario.grade(run, side);
  return { ...run, verdict: verdict === "skip" ? "skip" : verdict ? "pass" : "fail", note: scenario.note?.(run) };
}

const trials = Number(option("trials", "1"));
const only = option("only")?.split(",");
const scenarios = SCENARIOS.filter((scenario) => !only || only.includes(scenario.name));
const harness = await startSide(option("pi", "pi"), option("model"), option("thinking"));
console.log(`side agent model: ${harness.side.model}, thinking ${harness.side.thinking}; ${harness.side.skills.length} skills; ${trials} trial(s) of ${scenarios.length} scenario(s)\n`);

const results = [];
for (const scenario of scenarios) {
  for (let trial = 1; trial <= trials; trial++) {
    const result = await runScenario(scenario, harness);
    results.push({ scenario: scenario.name, trial, ...result });
    const tools = result.tools.map((tool) => `${tool.name}${tool.status === "ok" ? "" : `(${tool.status})`}`).join(", ") || "none";
    console.log(`${result.verdict.toUpperCase().padEnd(5)} ${scenario.name.padEnd(24)} ${result.seconds.toFixed(1).padStart(6)}s  $${result.cost.toFixed(3)}  tools: ${tools}${result.note ? `  [${result.note}]` : ""}${result.error ? `  error: ${result.error}` : ""}`);
    if (result.verdict === "fail") console.log(`      answer: ${result.answer.replace(/\s+/g, " ").slice(0, 300)}${result.notices.length ? `\n      notices: ${[...new Set(result.notices)].slice(0, 3).join(" | ").replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
  }
}
harness.side.settled = undefined;
harness.child.stop();
await harness.side.exit;
fs.rmSync(harness.side.home, { recursive: true, force: true, maxRetries: 5 });
console.log(`\nmodels that answered: ${[...harness.side.models].join(", ")}`);

const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped; total cost $${results.reduce((sum, result) => sum + result.cost, 0).toFixed(2)}`);
const outDir = path.join(root, ".eval-runs");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(outFile, JSON.stringify({ model: harness.side.model, thinking: harness.side.thinking, results }, null, 2));
console.log(`results: ${path.relative(process.cwd(), outFile)}`);
process.exitCode = count("fail") > 0 ? 1 : 0;
