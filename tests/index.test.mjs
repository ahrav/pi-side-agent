import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/side-agent/index.ts";
import { CHILD_ENV, MAIN_MESSAGE_TYPE } from "../extensions/side-agent/protocol.ts";
import { fakeContext, fakePi, tempDir } from "./support/fakes.mjs";

initTheme();

/** Loads the host extension against an empty agent directory, or one holding `config`. */
function load(t, config) {
  const agentDir = tempDir(t);
  if (config) fs.writeFileSync(path.join(agentDir, "side-agent.json"), JSON.stringify(config));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const pi = fakePi();
  extension(pi);
  return { pi, agentDir };
}

test("the extension registers its commands, toggle key, and renderer, and starts nothing", (t) => {
  const { pi, agentDir } = load(t);
  assert.deepEqual([...pi.commands.keys()], ["side-agent", "sa"]);
  assert.deepEqual([...pi.shortcuts.keys()], ["alt+a"]);
  assert.deepEqual([...pi.renderers.keys()], [MAIN_MESSAGE_TYPE]);
  assert.deepEqual([...pi.handlers.keys()], ["session_shutdown"], "the only handler is the shutdown hook");
  assert.equal(pi.tools.size, 0, "the main agent gets no new tool");
  assert.deepEqual(fs.readdirSync(agentDir), [], "loading writes nothing");
});

test("the toggle key comes from the config file", (t) => {
  const { pi } = load(t, { toggleKey: "ctrl+alt+k" });
  assert.deepEqual([...pi.shortcuts.keys()], ["ctrl+alt+k"]);
});

test("the extension is inert inside the side agent process", (t) => {
  process.env[CHILD_ENV] = "1";
  t.after(() => delete process.env[CHILD_ENV]);
  const { pi } = load(t);
  assert.deepEqual([pi.commands.size, pi.shortcuts.size, pi.renderers.size, pi.handlers.size], [0, 0, 0, 0]);
});

test("the command and the shortcut refuse to open outside interactive mode, and shutdown is safe when nothing ran", async (t) => {
  const { pi } = load(t);
  const ctx = fakeContext({ cwd: process.cwd() });
  ctx.mode = "print";
  ctx.hasUI = false;
  await pi.commands.get("sa").handler("hello there", ctx);
  await pi.shortcuts.get("alt+a").handler(ctx);
  assert.deepEqual(ctx.notes, [], "print mode has no UI to notify");
  assert.equal(ctx.overlays.length, 0);
  pi.emit("session_shutdown", { reason: "quit" }, ctx);
});

test("a side agent message renders in the main transcript with its sender", (t) => {
  const { pi } = load(t);
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const render = (message) => pi.renderers.get(MAIN_MESSAGE_TYPE)(message, { expanded: false }, theme).render(60).join("\n");
  const plain = render({ customType: MAIN_MESSAGE_TYPE, content: "Message from the side agent...\n\nRun the tests.", details: { text: "Run the tests.", expectsReply: false } });
  assert.match(plain, /side agent\s*\n\s*Run the tests\./);
  assert.doesNotMatch(plain, /Message from the side agent/, "the transcript shows the message, not the wrapper the model reads");
  assert.match(render({ customType: MAIN_MESSAGE_TYPE, content: "x", details: { text: "Which branch?", expectsReply: true } }), /side agent asks\s*\n\s*Which branch\?/);
  assert.match(render({ customType: MAIN_MESSAGE_TYPE, content: "raw content" }), /raw content/);
});
