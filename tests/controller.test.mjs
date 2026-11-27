import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SideAgentController } from "../extensions/side-agent/controller.ts";
import { defaultConfig, readConfig } from "../extensions/side-agent/layout.ts";
import { MAIN_MESSAGE_TYPE, SESSION_ENTRY_TYPE } from "../extensions/side-agent/protocol.ts";
import { alive, bridgePath, fakeContext, fakePi, KEY, scriptedPi, tempDir, until } from "./support/fakes.mjs";

initTheme();

const WIDTH = 110;
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

/**
 * A controller over a fake pi and interactive context, whose side agent is the repository's pi with
 * the scripted provider. `screen()` renders the open window; `type()` sends it keys.
 */
function setup(t, script, { branch = [], home = tempDir(t), config = defaultConfig() } = {}) {
  const pi = fakePi();
  const ctx = fakeContext({ cwd: home, branch });
  const scripted = scriptedPi(home, script);
  const configPath = path.join(home, "side-agent.json");
  const controller = new SideAgentController({
    pi,
    config,
    configPath,
    sessionDir: path.join(home, "sessions"),
    bridgePath,
    invocation: scripted.invocation,
    extraArgs: scripted.extraArgs,
    env: scripted.env,
  });
  t.after(() => controller.shutdown());
  const overlay = () => ctx.overlays[0];
  const screen = () => overlay().component.render(WIDTH).join("\n");
  const type = (text) => {
    for (const character of text) overlay().component.handleInput(character);
  };
  const enter = (text) => {
    type(text);
    overlay().component.handleInput(KEY.enter);
  };
  const shows = (pattern, label = String(pattern)) => until(() => overlay() && pattern.test(screen()), { label });
  const notices = () => controller.transcript.blocks.filter((block) => block.kind === "notice").map((block) => block.text);
  return { pi, ctx, controller, scripted, configPath, home, overlay, screen, type, enter, shows, notices };
}

test("opening the window starts the side agent and answers a prompt typed before it is ready", { timeout: 60_000 }, async (t) => {
  const { pi, ctx, controller, screen, shows, overlay } = setup(t, [{ text: "Hello from the side." }]);
  assert.equal(controller.running, false, "nothing runs before the window opens");
  assert.equal(pi.handlers.size, 0, "no main-session handler is registered before the window opens");

  controller.open(ctx, "say hello");
  assert.equal(controller.running, true);
  assert.equal(ctx.overlays.length, 1);
  assert.equal(overlay().focused, true);
  assert.deepEqual(overlay().options.overlayOptions, { anchor: "center", width: "92%", minWidth: 40, maxHeight: "100%", margin: 0, nonCapturing: true });
  assert.match(screen(), /starting… 1 queued/);
  assert.match(screen(), new RegExp(`❯ say hello[\\s\\S]*${SPINNER.source} Starting the side agent… 0s · esc stops +│\\n├`), "the held message and the starting line show at once");

  await shows(/Hello from the side\./);
  await shows(/ idle[^\n]*─╮/);
  assert.doesNotMatch(screen(), SPINNER, "an idle window shows no activity line");
  assert.equal(screen().match(/❯ say hello/g).length, 1, "the held message became one user message");
  assert.match(screen(), /╭─ side agent · scripted\/script ─/);
  assert.match(screen(), /❯ say hello/);
  assert.equal(screen().split("\n").length, 36, "the window is 90% of a 40-row terminal");
  assert.equal(pi.entries.length, 1);
  assert.equal(pi.entries[0].customType, SESSION_ENTRY_TYPE);
  assert.ok(fs.existsSync(pi.entries[0].data.file), "the side session file is recorded in the main session");
  assert.equal(ctx.notes.length, 0, "a focused window needs no completion notice");
});

test("the window closes, reopens with its transcript and draft, and reports a run that ends while it is away", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, overlay, enter, type, screen, shows } = setup(t, [{ text: "first answer" }, { delayMs: 300, text: "second answer" }, { delayMs: 150, text: "third answer" }]);
  controller.open(ctx);
  await controller.whenReady();
  enter("one");
  await shows(/first answer/);

  enter("two");
  assert.match(screen(), /working…/, "a sent prompt counts as work before the run starts");
  await until(() => controller.transcript.busy, { label: "the second run to start" });
  type("a draft");
  overlay().component.handleInput(KEY.escape);
  assert.equal(ctx.overlays.length, 1, "escape during a run stops the run and keeps the window");
  await shows(/Aborted\./);
  overlay().component.handleInput(KEY.escape);
  assert.equal(ctx.overlays.length, 0, "escape on an idle window closes it");
  assert.equal(controller.running, true, "the side agent keeps running");

  controller.toggle(ctx);
  assert.equal(ctx.overlays.length, 1);
  assert.match(screen(), /first answer[\s\S]*Aborted\.[\s\S]*a draft/);

  overlay().component.handleInput(KEY.ctrlC);
  enter("three");
  overlay().component.handleInput(KEY.altA);
  assert.equal(overlay().focused, false, "the toggle key returns focus to the main editor");
  await until(() => ctx.notes.length > 0, { label: "the completion notice" });
  assert.deepEqual(ctx.notes.at(-1), ["info", "Side agent finished. alt+a opens it."]);
  controller.toggle(ctx);
  assert.equal(overlay().focused, true);
  assert.match(screen(), /third answer/);
  assert.doesNotMatch(screen(), /second answer/, "the aborted run produced no answer");
});

test("size, dock, and maximize change the window and persist", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, overlay, enter, screen, configPath, shows } = setup(t, []);
  controller.open(ctx);
  await controller.whenReady();
  const rows = () => screen().split("\n").length;

  enter("/size 80 50");
  assert.equal(overlay().options.overlayOptions.width, "80%");
  assert.equal(rows(), 20);
  enter("/dock right");
  assert.deepEqual([overlay().options.overlayOptions.anchor, overlay().options.overlayOptions.width, rows()], ["right-center", "50%", 40]);
  assert.equal(overlay().focused, true, "a reopened window keeps focus");

  overlay().component.handleInput(KEY.altM);
  assert.deepEqual([overlay().options.overlayOptions.width, rows()], ["100%", 40]);
  overlay().component.handleInput(KEY.altM);
  assert.equal(overlay().options.overlayOptions.width, "50%", "maximize toggles back to the previous layout");
  overlay().component.handleInput(KEY.altPlus);
  assert.equal(overlay().options.overlayOptions.width, "55%");
  overlay().component.handleInput(KEY.altMinus);
  overlay().component.handleInput(KEY.altMinus);
  assert.equal(overlay().options.overlayOptions.width, "45%");

  enter("/size huge");
  await shows(/Usage: \/size <width%> \[height%\] \| full\. Current size: 45% x 100%\./);
  enter("/dock nowhere");
  await shows(/Usage: \/dock center \| left \| right \| top \| bottom\./);
  assert.equal(ctx.overlays.length, 1, "a layout change leaves exactly one window");

  await until(() => fs.existsSync(configPath), { label: "the saved config" });
  assert.deepEqual(readConfig(configPath).window, { dock: "right", width: 45, height: 100 });
});

test("the side agent's model changes by command, picker, and cycle key, and the choice persists", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, overlay, enter, type, shows, scripted, configPath } = setup(t, [{ text: "from script-2" }]);
  controller.open(ctx);
  await controller.whenReady();
  await shows(/side agent · scripted\/script ─/);

  enter("/model scripted/script-2");
  await shows(/side agent · scripted\/script-2 /);
  enter("which model?");
  await shows(/from script-2/);
  assert.equal(scripted.requests().at(-1).model, "script-2");

  overlay().component.handleInput(KEY.ctrlP);
  await shows(/side agent · scripted\/script /, "the cycled model in the title");

  overlay().component.handleInput(KEY.ctrlL);
  await shows(/Side agent model/);
  type("script-2");
  await shows(/→ scripted\/script-2/);
  overlay().component.handleInput(KEY.enter);
  await shows(/side agent · scripted\/script-2 /);

  overlay().component.handleInput(KEY.shiftTab);
  await until(() => controller.config.thinkingLevel !== undefined && controller.config.thinkingLevel !== "off", { label: "a cycled thinking level" });
  const level = controller.config.thinkingLevel;
  await shows(new RegExp(`scripted/script-2 · ${level} `));
  enter("/thinking");
  await shows(new RegExp(`Thinking level: ${level}\\. Available: off, `));
  enter("/thinking off");
  await until(() => controller.config.thinkingLevel === "off", { label: "thinking off" });

  await until(() => fs.existsSync(configPath) && readConfig(configPath).thinkingLevel === "off", { label: "the saved config" });
  assert.deepEqual(readConfig(configPath).model, { provider: "scripted", id: "script-2" });
});

test("a new side agent starts on the configured model, or on the main agent's model", { timeout: 60_000 }, async (t) => {
  const configured = setup(t, [], { config: { ...defaultConfig(), model: { provider: "scripted", id: "script-2" }, thinkingLevel: "high" } });
  configured.controller.open(configured.ctx);
  await configured.shows(/side agent · scripted\/script-2 · high /);

  const inherited = setup(t, []);
  inherited.ctx.model = { provider: "scripted", id: "script-2" };
  inherited.pi.thinking = "low";
  inherited.controller.open(inherited.ctx);
  await inherited.shows(/side agent · scripted\/script-2 · low /);

  const missing = setup(t, [], { config: { ...defaultConfig(), model: { provider: "gone", id: "model" } } });
  missing.controller.open(missing.ctx);
  await missing.shows(/Could not select gone\/model: Model not found: gone\/model/);
  await missing.shows(/side agent · scripted\/script /);
});

test("the side agent messages the main agent and gets its reply", { timeout: 60_000 }, async (t) => {
  const branch = [{ type: "message", id: "m1", message: { role: "user", content: "Refactor the parser." } }];
  const script = [{ tools: [{ name: "main_agent_send", arguments: { message: "Which branch are you on?", wait_for_reply: true } }] }, { text: "The main agent is on feature/parser." }];
  const { pi, ctx, controller, enter, shows, scripted } = setup(t, script, { branch });
  controller.open(ctx);
  await controller.whenReady();
  assert.equal(pi.listeners("message_end"), 1, "the bridge listens to the main session while the side agent runs");
  enter("ask the main agent for its branch");

  await until(() => pi.messages.length === 1, { label: "the message to the main agent" });
  const sent = pi.messages[0];
  assert.equal(sent.message.customType, MAIN_MESSAGE_TYPE);
  assert.match(sent.message.content, /^Message from the side agent[^\n]*:\n\nWhich branch are you on\?\n\nThe side agent is waiting for your reply\./);
  assert.deepEqual(sent.options, { deliverAs: "steer", triggerTurn: true });

  pi.emit("message_end", { message: { role: "custom", ...sent.message } }, ctx);
  pi.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "feature/parser" }] } }, ctx);
  await shows(/The main agent is on feature\/parser\./);
  const toolResult = scripted.requests().at(-1).messages.find((message) => message.role === "toolResult");
  assert.equal(toolResult.content[0].text, "Main agent replied:\n\nfeature/parser");
  assert.ok(JSON.stringify(scripted.requests()[0].messages.slice(1)).includes("Latest user message to the main agent:\\nRefactor the parser."), "the side agent's first run sees the main agent's snapshot");
});

test("/send hands the last answer to the main agent and /copy needs an answer", { timeout: 60_000 }, async (t) => {
  const { pi, ctx, controller, enter, shows, notices } = setup(t, [{ text: "Use a **trie** for the lookup." }]);
  controller.open(ctx);
  await controller.whenReady();
  enter("/send");
  await shows(/The side agent has no answer to send yet\./);
  enter("/copy");
  await shows(/The side agent has no answer to copy yet\./);

  enter("how should the lookup work?");
  await shows(/Use a trie for the lookup\./);
  ctx.idle = false;
  enter("/send Apply this to the tokenizer.");
  assert.equal(notices().at(-1), "Sent the last answer to the main agent. Queued. The main agent is working and reads the message after its current tool calls.");
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].message.details.text, "Apply this to the tokenizer.\n\nUse a **trie** for the lookup.");
});

test("a dialog the side agent opens is asked in the main UI", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, enter, shows, scripted, overlay } = setup(t, [{ tools: [{ name: "ask_confirm", arguments: { question: "Delete the cache?" } }] }, { text: "ok" }]);
  ctx.answers.confirm = true;
  controller.open(ctx);
  await controller.whenReady();
  enter("clean up");
  await shows(/✓ ask_confirm/);
  assert.deepEqual(ctx.dialogs, [["confirm", "[side agent] Delete the cache?", "Asked by the scripted tool."]]);
  assert.equal(scripted.requests().at(-1).messages.find((message) => message.role === "toolResult").content[0].text, "confirmed: true");
  assert.equal(overlay().hidden, false, "the window is visible again after the dialog");
  assert.equal(overlay().focused, true);
});

test("/new starts a fresh side session and commands the window does not own run in the side agent", { timeout: 60_000 }, async (t) => {
  const { pi, ctx, controller, enter, shows, screen, scripted } = setup(t, [{ text: "old answer" }, { text: "fresh answer" }]);
  controller.open(ctx);
  await controller.whenReady();
  enter("old question");
  await shows(/old answer/);
  enter("/model scripted/script-2");
  await shows(/side agent · scripted\/script-2 /);
  enter("/thinking high");
  await shows(/scripted\/script-2 · high /);
  enter("/new");
  await shows(/Started a new side session\./);
  assert.doesNotMatch(screen(), /old answer/);
  await until(() => pi.entries.length === 2, { label: "the new session entry" });
  assert.notEqual(pi.entries[1].data.file, pi.entries[0].data.file);
  assert.match(screen(), /scripted\/script-2 · high /, "a new session keeps the side agent's model and thinking level");

  enter("/help");
  await shows(/Side window commands: \/model/);
  enter("/nonexistent-side-command with args");
  await until(() => scripted.requests().length === 2, { label: "the forwarded prompt" });
  assert.equal(scripted.requests().at(-1).model, "script-2", "the new session answers with the selected model");
  assert.ok(JSON.stringify(scripted.requests().at(-1).messages.slice(1)).includes("/nonexistent-side-command with args"), "an unknown slash command goes to the side agent as a prompt");
});

test("the side session resumes from the entry recorded in the main session", { timeout: 60_000 }, async (t) => {
  const home = tempDir(t);
  const first = setup(t, [{ text: "remembered answer" }], { home });
  first.controller.open(first.ctx);
  await first.controller.whenReady();
  first.enter("remember this");
  await first.shows(/remembered answer/);
  first.controller.shutdown();
  await until(() => !first.controller.running, { label: "the first side agent to stop" });

  const second = setup(t, [{ text: "unused" }, { text: "continued answer" }], { home, branch: [...first.pi.entries] });
  second.controller.open(second.ctx);
  await second.shows(/❯ remember this[\s\S]*remembered answer/);
  assert.equal(second.pi.entries.length, 0, "a resumed session is not recorded again");
  second.enter("go on");
  await second.shows(/continued answer/);
  assert.equal(second.scripted.requests().at(-1).messages.filter((message) => message.role === "user" && JSON.stringify(message).includes("remember this")).length, 1, "the resumed request carries the earlier turn");
});

test("the window names each step of a run, counts its time, and clears the line when the run ends", { timeout: 60_000 }, async (t) => {
  const answer = "The side agent finished the command and reports its result here.";
  const script = [{ delayMs: 500, tools: [{ name: "bash", arguments: { command: "sleep 0.6" } }] }, { delayMs: 300, text: answer, paceMs: 40 }, { delayMs: 300, text: "second answer" }];
  const { ctx, controller, enter, shows, screen } = setup(t, script);
  const step = (label) => new RegExp(`${SPINNER.source} ${label} · esc stops +│\\n├`);
  controller.open(ctx);
  await controller.whenReady();
  assert.doesNotMatch(screen(), SPINNER);

  enter("run it");
  await shows(step("Waiting for the model… 0s"));
  assert.match(screen(), /❯ run it/);
  await shows(step("Running bash… \\ds"));
  await shows(step("Responding… [12]s"), "the time counts from the message, across the run's steps");
  await shows(/ idle[^\n]*─╮/);
  assert.match(screen(), /reports its result here\./);
  assert.doesNotMatch(screen(), SPINNER, "the line clears when the run ends");

  enter("again");
  await shows(step("Waiting for the model… 0s"), "a new run counts from zero");
  await shows(/second answer/);
});

test("a compaction shows on the activity line, and a run after it counts from zero", { timeout: 60_000 }, async (t) => {
  const home = tempDir(t);
  fs.mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi/agent/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
  const { ctx, controller, enter, shows, screen, notices, overlay } = setup(t, [{ delayMs: 1300, text: "first answer" }, { delayMs: 600, text: "second answer" }], { home });
  controller.open(ctx, "say something");
  await shows(/first answer/);
  await shows(/ idle[^\n]*─╮/);
  enter("more");
  await shows(/second answer/);
  await shows(/ idle[^\n]*─╮/);

  enter("/compact");
  await shows(new RegExp(`${SPINNER.source} Compacting context… 0s +│\\n├`), "the compaction line without the escape hint");
  assert.match(screen(), / working…[^\n]*─╮/);
  assert.match(screen(), /esc close/, "escape stops no run during a compaction");
  await shows(new RegExp(`${SPINNER.source} Compacting context… 1s`));

  overlay().component.handleInput(KEY.ctrlC);
  assert.equal(ctx.overlays.length, 0);
  await until(() => notices().includes("Context compacted."), { label: "the compaction to end while the window is closed" });
  controller.open(ctx, "again");
  await shows(new RegExp(`${SPINNER.source} (Sending|Waiting for the model)… 0s`), "a run after the compaction counts from zero");
});

test("a side agent that dies is reported and restarts on the next message", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, enter, shows, screen } = setup(t, [{ text: "back again" }]);
  controller.open(ctx);
  await controller.whenReady();
  const pid = controller.pid;
  process.kill(pid, "SIGKILL");
  await shows(/The side agent process exited \(signal SIGKILL\)\.[\s\S]*Send a message to restart it\./);
  assert.match(screen(), / stopped ─╮/);
  assert.equal(controller.running, false);

  enter("are you there?");
  assert.match(screen(), /❯ are you there\?[\s\S]*Starting the side agent…/, "the message that restarts the side agent shows while it starts");
  await shows(/back again/);
  assert.notEqual(controller.pid, pid);
  assert.equal(screen().match(/❯ are you there\?/g).length, 1);
});

test("shutdown stops the side agent, closes the window, and stops listening to the main session", { timeout: 60_000 }, async (t) => {
  const { pi, ctx, controller } = setup(t, []);
  controller.open(ctx);
  await controller.whenReady();
  const pid = controller.pid;
  controller.shutdown();
  assert.equal(ctx.overlays.length, 0);
  for (const event of pi.handlers.keys()) assert.equal(pi.listeners(event), 0, `${event} handler removed`);
  await until(() => !alive(pid), { label: "the side agent to exit" });
  assert.equal(controller.running, false);
  assert.doesNotMatch(JSON.stringify(controller.transcript.blocks), /exited/, "an intended stop is not reported as a failure");
});

test("/quit stops the side agent and closes the window", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, enter } = setup(t, []);
  controller.open(ctx);
  await controller.whenReady();
  const pid = controller.pid;
  enter("/quit");
  assert.equal(ctx.overlays.length, 0);
  await until(() => !alive(pid), { label: "the side agent to exit" });
});

test("outside interactive mode the command explains itself and starts nothing", (t) => {
  const { ctx, controller } = setup(t, []);
  ctx.mode = "rpc";
  controller.open(ctx, "hello");
  assert.deepEqual(ctx.notes, [["error", "The side agent window needs pi's interactive mode."]]);
  assert.equal(controller.running, false);
  assert.equal(ctx.overlays.length, 0);
});
