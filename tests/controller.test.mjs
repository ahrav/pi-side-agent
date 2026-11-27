import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SideAgentController } from "../extensions/side-agent/controller.ts";
import { defaultConfig, readConfig } from "../extensions/side-agent/layout.ts";
import { MAIN_MESSAGE_TYPE, SESSION_ENTRY_TYPE } from "../extensions/side-agent/protocol.ts";
import { alive, bridgePath, fakeContext, fakePi, KEY, root, scriptedPi, tempDir, until } from "./support/fakes.mjs";

initTheme();

const WIDTH = 110;
const SPINNER = /[⠋⠙⠸⠴⠦⠇]/;

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
  assert.match(screen(), new RegExp(`❯ say hello[\\s\\S]*${SPINNER.source} Starting the side agent… 0s · ctrl\\+c stops +│\\n├`), "the held message and the starting line show at once");

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

const STATUS = "side-agent";
const IDLE = / idle[^\n]*─╮/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("escape closes the window while the side agent works, and the main UI follows the run", { timeout: 60_000 }, async (t) => {
  const script = [{ text: "first answer" }, { delayMs: 300, tools: [{ name: "bash", arguments: { command: "sleep 0.4" } }] }, { delayMs: 300, text: "second answer" }, { delayMs: 150, text: "third answer" }];
  const { ctx, controller, overlay, enter, type, screen, shows, scripted } = setup(t, script);
  controller.open(ctx);
  await controller.whenReady();
  enter("one");
  await shows(/first answer/);
  assert.equal(ctx.statusWrites, 0, "an open window writes no footer status");

  enter("two");
  assert.match(screen(), /working…/, "a sent prompt counts as work before the run starts");
  await until(() => controller.transcript.busy, { label: "the second run to start" });
  type("a draft");
  overlay().component.handleInput(KEY.escape);
  assert.equal(ctx.overlays.length, 0, "escape closes the window during a run");
  assert.equal(ctx.statuses.get(STATUS), "side agent working…");
  assert.equal(ctx.notes.length, 0);

  await until(() => ctx.notes.length > 0, { label: "the completion notice" });
  assert.deepEqual(ctx.notes, [["info", "Side agent finished. alt+a opens it."]]);
  assert.equal(ctx.statuses.get(STATUS), "side agent done");
  assert.equal(scripted.requests().length, 3, "the run made its tool call and its next model request with the window closed");
  assert.equal(ctx.statusWrites, 2, "the footer status is written once per change");

  controller.toggle(ctx);
  assert.equal(ctx.overlays.length, 1);
  assert.equal(ctx.statuses.size, 0, "the open window clears the footer status");
  assert.match(screen(), /first answer[\s\S]*✓ bash[\s\S]*second answer[\s\S]*a draft/);
  assert.doesNotMatch(screen(), /Aborted/);

  overlay().component.handleInput(KEY.escape);
  assert.equal(ctx.overlays.length, 0, "escape closes an idle window");
  assert.equal(ctx.statuses.size, 0, "a result the window has shown leaves no footer status");
  assert.equal(controller.running, true, "the side agent keeps running");

  controller.toggle(ctx);
  overlay().component.handleInput(KEY.ctrlC);
  assert.equal(overlay().component.editor.getText(), "", "ctrl+c clears the draft");
  enter("three");
  overlay().component.handleInput(KEY.altA);
  assert.equal(overlay().focused, false, "the toggle key returns focus to the main editor");
  await until(() => ctx.notes.length > 1, { label: "the second completion notice" });
  assert.deepEqual(ctx.notes.at(-1), ["info", "Side agent finished. alt+a opens it."]);
  assert.equal(ctx.statuses.size, 0, "a visible window needs no footer status");
  controller.toggle(ctx);
  assert.equal(overlay().focused, true);
  assert.match(screen(), /third answer/);
});

test("ctrl+c stops the run, returns queued messages to the composer, and then closes the window", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, overlay, enter, type, screen, shows, scripted } = setup(t, [{ delayMs: 20_000, text: "never shown" }, { text: "after the stop" }]);
  const window = () => overlay().component;
  controller.open(ctx);
  await controller.whenReady();
  enter("first");
  await until(() => controller.transcript.busy, { label: "the run to start" });
  enter("steer it");
  type("then follow up");
  window().handleInput(KEY.altEnter);
  await shows(/⏳ queued: steer it[\s\S]*⏳ queued: then follow up/);
  assert.match(screen(), /esc hide · ctrl\+c stop · /);

  window().handleInput(KEY.ctrlC);
  assert.match(screen(), new RegExp(`${SPINNER.source} Stopping… \\ds +│\\n├`), "the activity line names the stop without the stop hint");
  await shows(/Aborted\./);
  await shows(IDLE);
  assert.equal(ctx.overlays.length, 1, "the window stays open after a stop");
  assert.equal(window().editor.getText(), "steer it\n\nthen follow up");
  assert.doesNotMatch(screen(), /queued:/);
  assert.doesNotMatch(screen(), /ctrl\+c stop/);
  await pause(400);
  assert.equal(controller.transcript.busy, false, "the returned messages start no run");
  assert.equal(scripted.requests().length, 1);
  assert.equal(ctx.notes.length, 0);

  window().handleInput(KEY.ctrlC);
  assert.equal(window().editor.getText(), "");
  assert.equal(ctx.overlays.length, 1);
  window().handleInput(KEY.ctrlC);
  assert.equal(ctx.overlays.length, 0, "ctrl+c closes an idle window with an empty composer");
  assert.equal(ctx.statuses.size, 0);

  controller.toggle(ctx);
  enter("next");
  await shows(/after the stop/);
});

test("ctrl+c twice stops a running tool and closes the window, and the stopped run sends no completion notice", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, overlay, enter, notices, scripted } = setup(t, [{ tools: [{ name: "bash", arguments: { command: "sleep 30" } }] }, { text: "never shown" }]);
  controller.open(ctx);
  await controller.whenReady();
  enter("go");
  await until(() => controller.transcript.activity() === "Running bash…", { label: "the tool to start" });
  overlay().component.handleInput(KEY.ctrlC);
  overlay().component.handleInput(KEY.ctrlC);
  assert.equal(ctx.overlays.length, 0, "the second ctrl+c closes the window while the stop is in progress");
  await until(() => !controller.transcript.busy, { label: "the run to stop", timeoutMs: 5000 });
  await until(() => ctx.statuses.size === 0, { label: "the footer status to clear" });
  assert.deepEqual(notices(), ["Aborted."]);
  assert.deepEqual(controller.transcript.blocks.filter((block) => block.kind === "tool").map((block) => [block.name, block.status]), [["bash", "error"]]);
  assert.equal(ctx.notes.length, 0, "a stopped run is not reported as finished");
  assert.equal(scripted.requests().length, 1);
  assert.equal(controller.running, true, "the side session stays available");
});

test("ctrl+c stops a run whose prompt pi has not accepted yet, and returns a message held for startup", { timeout: 60_000 }, async (t) => {
  const early = setup(t, [{ delayMs: 20_000, text: "never shown" }]);
  early.controller.open(early.ctx);
  await early.controller.whenReady();
  early.enter("[slow input] go");
  early.overlay().component.handleInput(KEY.ctrlC);
  assert.equal(early.ctx.overlays.length, 1, "a sent prompt counts as work to stop");
  await until(() => early.controller.transcript.blocks.some((block) => block.kind === "user"), { label: "pi to accept the prompt" });
  await early.shows(IDLE);
  await pause(400);
  assert.equal(early.controller.transcript.busy, false);
  assert.doesNotMatch(early.screen(), /never shown/);
  assert.doesNotMatch(early.screen(), SPINNER);

  const held = setup(t, [{ text: "unused" }]);
  held.controller.open(held.ctx, "a held message");
  assert.match(held.screen(), /❯ a held message/);
  held.overlay().component.handleInput(KEY.ctrlC);
  assert.equal(held.overlay().component.editor.getText(), "a held message");
  assert.doesNotMatch(held.screen(), /❯ a held message/);
  await held.controller.whenReady();
  await held.shows(IDLE);
  await pause(300);
  assert.equal(fs.existsSync(path.join(held.home, "requests.jsonl")), false, "the returned message reaches no model");
});

test("a run that fails and a side agent that dies behind a closed window are reported in the main UI", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, overlay, enter, screen } = setup(t, [{ delayMs: 300, error: "the scripted request failed" }]);
  controller.open(ctx);
  await controller.whenReady();
  enter("fail");
  await until(() => controller.transcript.busy, { label: "the run to start" });
  overlay().component.handleInput(KEY.escape);
  await until(() => ctx.notes.length > 0, { label: "the failure notice" });
  assert.deepEqual(ctx.notes, [["error", "Side agent stopped on an error. alt+a opens it."]]);
  assert.equal(ctx.statuses.get(STATUS), "side agent failed");

  controller.toggle(ctx);
  assert.match(screen(), /the scripted request failed/);
  assert.equal(ctx.statuses.size, 0);
  overlay().component.handleInput(KEY.escape);
  process.kill(controller.pid, "SIGKILL");
  await until(() => ctx.notes.length > 1, { label: "the exit notice" });
  assert.deepEqual(ctx.notes.at(-1), ["error", "The side agent process exited. alt+a opens it."]);
  assert.equal(ctx.statuses.get(STATUS), "side agent failed");

  controller.shutdown();
  assert.equal(ctx.statuses.size, 0, "shutdown clears the footer status");
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

test("a dialog the side agent opens behind a closed window is asked in the main UI", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, enter, scripted, overlay } = setup(t, [{ delayMs: 300, tools: [{ name: "ask_confirm", arguments: { question: "Delete the cache?" } }] }, { text: "ok" }]);
  ctx.answers.confirm = true;
  controller.open(ctx);
  await controller.whenReady();
  enter("clean up");
  await until(() => controller.transcript.busy, { label: "the run to start" });
  overlay().component.handleInput(KEY.escape);
  await until(() => ctx.notes.length > 0, { label: "the completion notice" });
  assert.deepEqual(ctx.dialogs, [["confirm", "[side agent] Delete the cache?", "Asked by the scripted tool."]]);
  assert.equal(scripted.requests().at(-1).messages.find((message) => message.role === "toolResult").content[0].text, "confirmed: true");
  assert.equal(ctx.overlays.length, 0, "the window stays closed");
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
  const step = (label) => new RegExp(`${SPINNER.source} ${label} · ctrl\\+c stops +│\\n├`);
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

test("the side agent counts as working from the prompt to the end of the run, across a slow run start", { timeout: 60_000 }, async (t) => {
  const { ctx, controller, overlay, enter, screen, shows } = setup(t, [{ delayMs: 300, text: "first answer" }, { delayMs: 300, text: "second answer" }]);
  controller.open(ctx);
  await controller.whenReady();
  enter("[slow start] go");
  for (let sample = 0; sample < 45; sample++) {
    assert.match(screen(), SPINNER, `the activity line shows ${sample * 10} ms after the prompt`);
    await pause(10);
  }
  await shows(/first answer/);
  await shows(IDLE);

  overlay().component.handleInput(KEY.escape);
  controller.submit("[slow start] again", "steer");
  await until(() => ctx.notes.length > 0, { label: "the completion notice" });
  assert.equal(ctx.statusWrites, 2, "the footer status holds from the prompt to the end of the run");
  assert.equal(ctx.statuses.get(STATUS), "side agent done");
});

test("a run that ends in the same read as its prompt's response leaves the side agent idle", { timeout: 30_000 }, async (t) => {
  const home = tempDir(t);
  const ctx = fakeContext({ cwd: home });
  const invocation = () => ({ command: process.execPath, args: [path.join(root, "tests/support/instant-rpc.mjs")] });
  const controller = new SideAgentController({ pi: fakePi(), config: defaultConfig(), configPath: path.join(home, "side-agent.json"), sessionDir: path.join(home, "sessions"), bridgePath, invocation });
  t.after(() => controller.shutdown());
  controller.open(ctx);
  await controller.whenReady();
  const window = ctx.overlays[0].component;
  const screen = () => window.render(WIDTH).join("\n");
  for (const key of ["g", "o", KEY.enter]) window.handleInput(key);
  await until(() => /instant answer/.test(screen()), { label: "the answer" });
  await pause(50);
  assert.match(screen(), IDLE);
  assert.doesNotMatch(screen(), SPINNER);
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
  await shows(new RegExp(`${SPINNER.source} Compacting context… 0s · ctrl\\+c stops +│\\n├`), "the compaction line");
  assert.match(screen(), / working…[^\n]*─╮/);
  await shows(new RegExp(`${SPINNER.source} Compacting context… 1s`));

  overlay().component.handleInput(KEY.escape);
  assert.equal(ctx.overlays.length, 0);
  assert.equal(ctx.statuses.get(STATUS), "side agent working…", "a compaction behind a closed window counts as work");
  await until(() => notices().includes("Context compacted."), { label: "the compaction to end while the window is closed" });
  await until(() => ctx.statuses.size === 0, { label: "the footer status to clear" });
  assert.equal(ctx.notes.length, 0, "a compaction ends without a completion notice");
  controller.open(ctx, "again");
  await shows(new RegExp(`${SPINNER.source} (Sending|Waiting for the model)… 0s`), "a run after the compaction counts from zero");
  await shows(IDLE);

  enter("/compact");
  await shows(/Compacting context… \ds · ctrl\+c stops/);
  overlay().component.handleInput(KEY.ctrlC);
  await until(() => notices().includes("Compaction aborted."), { label: "ctrl+c to stop the compaction" });
  assert.equal(ctx.overlays.length, 1);
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
  await until(() => !controller.running, { label: "the controller to see the exit" });
  assert.equal(ctx.statuses.size, 0, "a side agent that was quit leaves no footer status");
  assert.equal(ctx.notes.length, 0);
});

test("outside interactive mode the command explains itself and starts nothing", (t) => {
  const { ctx, controller } = setup(t, []);
  ctx.mode = "rpc";
  controller.open(ctx, "hello");
  assert.deepEqual(ctx.notes, [["error", "The side agent window needs pi's interactive mode."]]);
  assert.equal(controller.running, false);
  assert.equal(ctx.overlays.length, 0);
});
