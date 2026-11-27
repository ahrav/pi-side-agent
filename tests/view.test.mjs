import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Transcript } from "../extensions/side-agent/transcript.ts";
import { SideWindow } from "../extensions/side-agent/view.ts";
import { editorTheme, fakeTui, KEY, keys, markdownTheme, theme, until } from "./support/fakes.mjs";

const ACTIONS = ["submit", "stop", "close", "unfocus", "resize", "toggleMaximize", "cycleModel", "cycleThinking", "pickModel"];

/** A focused window over an empty transcript. `calls` records the actions the window invokes. */
function build({ rows = 30, markdown = markdownTheme, actions = {} } = {}) {
  const tui = fakeTui(rows, 120);
  const transcript = new Transcript();
  const calls = [];
  const shown = { rows, title: "side agent · p/m", state: "idle", note: "", activity: undefined, outbox: [], stoppable: undefined };
  const window = new SideWindow({
    tui,
    theme,
    keys,
    markdownTheme: markdown,
    editorTheme,
    transcript,
    cwd: process.cwd(),
    toggleKey: "alt+a",
    rows: () => shown.rows,
    stoppable: () => shown.stoppable ?? transcript.busy,
    activity: () => shown.activity,
    outbox: () => shown.outbox,
    title: () => shown.title,
    state: () => shown.state,
    note: () => shown.note,
    actions: { ...Object.fromEntries(ACTIONS.map((name) => [name, (...args) => calls.push([name, ...args])])), ...actions },
  });
  window.focused = true;
  return { window, transcript, tui, calls, shown };
}

function ask(transcript, question, answer) {
  transcript.apply({ type: "message_start", message: { role: "user", content: question } });
  transcript.apply({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] } });
}

function fill(transcript, count) {
  for (let index = 0; index < count; index++) ask(transcript, `question ${index}`, `answer ${index}`);
}

const body = (lines) => lines.join("\n");
const type = (window, text) => {
  for (const character of text) window.handleInput(character);
};

test("a frame is exactly the window's rows by the given width", () => {
  const { window, transcript, shown } = build();
  fill(transcript, 30);
  transcript.apply({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "ls" } });
  transcript.apply({ type: "queue_update", steering: ["a queued message"], followUp: [] });
  for (const [width, rows] of [[110, 30], [60, 12], [200, 60], [44, 10], [31, 9]]) {
    shown.rows = rows;
    const lines = window.render(width);
    assert.equal(lines.length, rows, `${width}x${rows} row count`);
    for (const line of lines) assert.equal(visibleWidth(line), width, `${width}x${rows}: ${JSON.stringify(line)}`);
  }
});

test("wide characters, long words, and markdown stay inside the frame", () => {
  const { window, transcript } = build({ rows: 24 });
  ask(transcript, "日本語の質問 🎉 ".repeat(12), `# Heading\n\n| a | b |\n|---|---|\n| ${"long".repeat(40)} | 🎉🎉 |\n\n\`\`\`ts\nconst x = "${"y".repeat(200)}";\n\`\`\`\n- 項目 一\n- 項目 二`);
  for (const width of [40, 77, 120]) for (const line of window.render(width)) assert.equal(visibleWidth(line), width, JSON.stringify(line));
});

test("an unchanged frame is served from the cache", () => {
  const { window, transcript, shown } = build();
  fill(transcript, 5);
  const first = window.render(100);
  assert.equal(window.render(100), first, "the same array comes back");
  assert.equal(window.rebuilds, 1);

  ask(transcript, "more", "content");
  const second = window.render(100);
  assert.notEqual(second, first);
  assert.equal(window.render(100), second);
  shown.state = "working…";
  assert.notEqual(window.render(100), second, "a new state rebuilds the frame");
  assert.notEqual(window.render(90), window.render(100), "a new width rebuilds the frame");
  window.handleInput("x");
  assert.match(body(window.render(100)), /│ x/, "typing rebuilds the frame");
});

test("a delta re-renders only the block it extends", () => {
  const { window, transcript } = build();
  fill(transcript, 4);
  transcript.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  transcript.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streaming" } });
  window.render(100);
  const cached = transcript.blocks.map((block) => block.cache.lines);
  transcript.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " more text" } });
  assert.match(body(window.render(100)), /streaming more text/);
  transcript.blocks.forEach((block, index) => {
    if (index === transcript.blocks.length - 1) assert.notEqual(block.cache.lines, cached[index], "the streaming block is rendered again");
    else assert.equal(block.cache.lines, cached[index], `block ${index} keeps its rendered lines`);
  });
});

test("a frame at the end of a long transcript renders only the blocks it shows", () => {
  const { window, transcript } = build({ rows: 30 });
  fill(transcript, 2000);
  const lines = window.render(100);
  assert.match(body(lines), /answer 1999/);
  const rendered = transcript.blocks.filter((block) => block.cache).length;
  assert.ok(rendered <= 30, `${rendered} of ${transcript.blocks.length} blocks rendered`);
});

test("the view follows new output, and holds its place once scrolled back", () => {
  const { window, transcript } = build({ rows: 20 });
  fill(transcript, 40);
  assert.match(body(window.render(100)), /answer 39/);

  window.handleInput(KEY.pageUp);
  const scrolled = window.render(100);
  assert.doesNotMatch(body(scrolled), /answer 39/);
  assert.match(body(scrolled), /scrolled back/);
  const held = scrolled.slice(1, 6);

  ask(transcript, "new question", "new answer");
  assert.deepEqual(window.render(100).slice(1, 6), held, "new output leaves a scrolled-back view in place");

  window.handleInput(KEY.ctrlEnd);
  const following = window.render(100);
  assert.match(body(following), /new answer/);
  assert.doesNotMatch(body(following), /scrolled back/);

  window.handleInput(KEY.pageUp);
  window.handleInput(KEY.pageDown);
  assert.doesNotMatch(body(window.render(100)), /scrolled back/, "paging back down to the end resumes following");
});

test("scrolling stops at the first line and the mouse wheel moves by its delta", () => {
  const { window, transcript } = build({ rows: 20 });
  fill(transcript, 40);
  window.render(100);
  for (let page = 0; page < 30; page++) window.handleInput(KEY.pageUp);
  assert.match(window.render(100)[1], /❯ question 0/);
  window.handleInput(KEY.ctrlEnd);
  const bottom = window.render(100);
  assert.deepEqual(window.handleMouse({ type: "wheel", wheelDelta: -3 }), { handled: true });
  assert.deepEqual(window.render(100).slice(4, 10), bottom.slice(1, 7), "three lines up");
  window.handleMouse({ type: "wheel", wheelDelta: 3 });
  assert.deepEqual(window.render(100).slice(1, -1), bottom.slice(1, -1), "three lines down returns to the end");
  window.handleInput(KEY.ctrlHome);
  assert.match(window.render(100)[1], /❯ question 0/);
});

test("tool calls show one line, and their output when expanded or failed", () => {
  const { window, transcript } = build();
  transcript.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "ls -la" } });
  assert.match(body(window.render(100)), /◐ bash ls -la/);
  transcript.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "README.md\nsrc" }] }, isError: false, durationMs: 1500 });
  transcript.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "missing.ts" } });
  transcript.apply({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: { content: [{ type: "text", text: "ENOENT: no such file" }] }, isError: true });
  const collapsed = body(window.render(100));
  assert.match(collapsed, /✓ bash ls -la {2}1\.5s/);
  assert.doesNotMatch(collapsed, /README\.md/);
  assert.match(collapsed, /✗ read missing\.ts[^\n]*\n│ {3}ENOENT: no such file/, "a failed call shows its error");
  window.handleInput(KEY.ctrlO);
  assert.match(body(window.render(100)), /✓ bash ls -la {2}1\.5s[^\n]*\n│ {3}README\.md[^\n]*\n│ {3}src/);
});

test("thinking shows as text or as one line, and queued messages show below the transcript", () => {
  const { window, transcript } = build();
  transcript.apply({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "public answer" }] } });
  transcript.apply({ type: "queue_update", steering: ["do this\nnext"], followUp: [] });
  assert.match(body(window.render(100)), /private reasoning[\s\S]*public answer[\s\S]*⏳ queued: do this next/);
  window.handleInput(KEY.ctrlT);
  const hidden = body(window.render(100));
  assert.doesNotMatch(hidden, /private reasoning/);
  assert.match(hidden, /thought[\s\S]*public answer/);
});

test("the title, state, note, and key hints frame the transcript", () => {
  const { window, transcript, shown } = build();
  shown.note = "Only one model is available to cycle.";
  let lines = window.render(100);
  assert.match(lines[0], /^╭─ side agent · p\/m ─+ idle ─╮$/);
  assert.match(lines.at(-2), /Only one model is available to cycle\..*alt\+a main · esc hide · pgup\/pgdn scroll/);
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.match(lines.at(-5), /^├─+┤$/, "the composer joins the frame");
  transcript.apply({ type: "agent_start" });
  shown.state = "working…";
  lines = window.render(100);
  assert.match(lines[0], /working… ─╮$/);
  assert.match(lines.at(-2), /alt\+a main · esc hide · ctrl\+c stop · pgup\/pgdn scroll/);
  type(window, "a draft");
  assert.doesNotMatch(body(window.render(100)), /ctrl\+c stop/, "with a draft, ctrl+c clears the draft, so the stop hints are absent");
  window.handleInput(KEY.ctrlC);
  assert.match(window.render(100).at(-2), /ctrl\+c stop/);
  shown.title = "side agent · " + "very-long-model-name/".repeat(10);
  assert.equal(visibleWidth(window.render(60)[0]), 60, "a long title is cut to the frame");
});

test("keys reach the window's actions", () => {
  const { window, transcript, calls, shown } = build();
  window.render(100);
  for (const key of [KEY.altM, KEY.altPlus, KEY.altMinus, KEY.ctrlL, KEY.ctrlP, KEY.shiftTab, KEY.altA]) window.handleInput(key);
  assert.deepEqual(calls.splice(0), [["toggleMaximize"], ["resize", 1], ["resize", -1], ["pickModel"], ["cycleModel"], ["cycleThinking"], ["unfocus"]]);

  window.handleInput(KEY.escape);
  transcript.apply({ type: "agent_start" });
  window.handleInput(KEY.escape);
  assert.deepEqual(calls.splice(0), [["close"], ["close"]], "escape closes the window and leaves a running turn alone");

  type(window, "draft");
  window.handleInput(KEY.ctrlC);
  assert.equal(window.editor.getText(), "", "ctrl+c clears a draft first");
  assert.deepEqual(calls.splice(0), []);
  window.handleInput(KEY.ctrlC);
  assert.deepEqual(calls.splice(0), [["stop"]], "ctrl+c on an empty composer stops a running turn");
  shown.stoppable = false;
  window.handleInput(KEY.ctrlC);
  assert.deepEqual(calls.splice(0), [["close"]], "ctrl+c closes the window when nothing is left to stop");
});

test("enter sends the draft and alt+enter queues it as a follow-up", () => {
  const { window, calls } = build();
  type(window, "first question");
  window.handleInput(KEY.enter);
  type(window, "then this");
  window.handleInput(KEY.altEnter);
  window.handleInput(KEY.enter);
  window.handleInput(KEY.altEnter);
  assert.deepEqual(calls, [["submit", "first question", "steer"], ["submit", "then this", "followUp"]], "an empty draft sends nothing");
  assert.equal(window.editor.getText(), "");
});

test("the picker filters, puts pinned items first, and returns the chosen item", () => {
  const { window } = build({ rows: 16 });
  const items = [
    { value: "0", label: "prov/alpha-large", description: "Alpha Large" },
    { value: "1", label: "prov/beta-small", description: "Beta Small" },
    { value: "2", label: "prov/alpha-small", description: "Alpha Small", pinned: true },
    { value: "3", label: "other/gamma" },
  ];
  const picked = [];
  window.openPicker("Side agent model", items, "", (item) => picked.push(item.value));
  let shown = body(window.render(100));
  assert.match(shown, /Side agent model[\s\S]*→ prov\/alpha-small {2}Alpha Small {2}★[\s\S]*prov\/alpha-large[\s\S]*4 · enter selects/);

  type(window, "alpha");
  shown = body(window.render(100));
  assert.match(shown, /→ prov\/alpha-small/);
  assert.match(shown, /prov\/alpha-large/);
  assert.doesNotMatch(shown, /beta|gamma/);
  window.handleInput(KEY.down);
  window.handleInput(KEY.enter);
  assert.deepEqual(picked, ["0"]);
  assert.doesNotMatch(body(window.render(100)), /Side agent model/, "choosing closes the picker");

  window.openPicker("Side agent model", items, "zzz", (item) => picked.push(item.value));
  assert.match(body(window.render(100)), /No match/);
  window.handleInput(KEY.escape);
  assert.doesNotMatch(body(window.render(100)), /No match/);
  assert.deepEqual(picked, ["0"], "escape chooses nothing");
});

test("content updates share frames, and the frame interval grows with the cost of a rebuild", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { window, transcript, tui } = build();
  fill(transcript, 3);
  window.render(100);
  tui.renders = 0;

  window.renderCostMs = 0;
  for (let index = 0; index < 50; index++) window.contentChanged();
  assert.equal(tui.renders, 0, "updates inside the 50 ms interval wait");
  t.mock.timers.tick(50);
  assert.equal(tui.renders, 1, "one frame serves all 50 updates");

  window.render(100);
  window.renderCostMs = 5;
  tui.renders = 0;
  window.contentChanged();
  t.mock.timers.tick(249);
  assert.equal(tui.renders, 0, "a 5 ms rebuild spaces frames 250 ms apart");
  t.mock.timers.tick(1);
  assert.equal(tui.renders, 1);

  window.render(100);
  window.renderCostMs = 1000;
  tui.renders = 0;
  window.contentChanged();
  t.mock.timers.tick(500);
  assert.equal(tui.renders, 1, "the interval is at most 500 ms");

  window.contentChanged();
  window.dispose();
  t.mock.timers.tick(1000);
  assert.equal(tui.renders, 1, "a disposed window requests no frame");
});

test("a click focuses an unfocused window and leaves a focused one to the terminal", () => {
  const { window } = build();
  assert.equal(window.handleMouse({ type: "press", button: "left" }), undefined);
  window.focused = false;
  assert.deepEqual(window.handleMouse({ type: "press", button: "left" }), { focus: true });
});

test("a block that fails to render shows as plain text, and a frame that fails to draw does not throw", () => {
  const heading = () => {
    throw new Error("theme failure");
  };
  const { window, transcript, shown } = build({ markdown: { ...markdownTheme, heading } });
  ask(transcript, "question", "# A heading\n\nBody text.");
  const lines = window.render(80);
  assert.match(body(lines), /# A heading/, "the block falls back to its source text");
  assert.match(body(lines), /❯ question/, "other blocks render normally");

  Object.defineProperty(shown, "title", { get: heading });
  const fallback = window.render(80);
  assert.equal(fallback.length, 1);
  assert.match(fallback[0], /^side agent window failed to draw: theme failure/);
  assert.equal(visibleWidth(fallback[0]), 80);
});

test("an action that throws is reported in the window instead of thrown at pi", () => {
  const toggleMaximize = () => {
    throw new Error("maximize failed");
  };
  const { window } = build({ actions: { toggleMaximize } });
  window.handleInput(KEY.altM);
  assert.match(window.render(100).at(-2), /maximize failed/);
  window.handleInput("x");
  assert.doesNotMatch(window.render(100).at(-2), /maximize failed/, "the next key clears the report");
});

const SPINNER = /[⠋⠙⠸⠴⠦⠇]/;
const activityLine = (lines) => lines[lines.findIndex((line) => line.startsWith("├")) - 1];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("an active side agent shows a spinner, its step, and the elapsed time above the composer", () => {
  const { window, transcript, shown } = build();
  fill(transcript, 3);
  const idle = window.render(100);
  assert.doesNotMatch(body(idle), SPINNER);
  assert.match(activityLine(idle), /^│ +│$/, "an idle window ends its transcript with a blank line");

  transcript.apply({ type: "agent_start" });
  shown.activity = { label: "Thinking…", since: performance.now() - 2350 };
  const active = window.render(100);
  assert.equal(active.length, 30, "the activity line takes a transcript row, and the frame keeps its height");
  assert.match(activityLine(active), new RegExp(`^│ ${SPINNER.source} Thinking… 2s · ctrl\\+c stops +│$`));
  assert.match(body(active), /answer 2/, "the end of the transcript stays in view");

  shown.activity = { label: "Running bash…", since: performance.now() - 65_400 };
  assert.match(activityLine(window.render(100)), /Running bash… 1m 05s · ctrl\+c stops/);

  transcript.apply({ type: "agent_settled" });
  shown.activity = { label: "Starting the side agent…", since: performance.now() - 400 };
  assert.match(activityLine(window.render(100)), /Starting the side agent… 0s +│$/, "the stop hint shows only while there is work to stop");

  for (const [width, rows] of [[44, 10], [31, 9], [200, 60]]) {
    shown.rows = rows;
    const lines = window.render(width);
    assert.equal(lines.length, rows);
    for (const line of lines) assert.equal(visibleWidth(line), width, JSON.stringify(line));
  }
  window.dispose();
});

test("the spinner advances while pi draws the window and requests no frame otherwise", async () => {
  const { window, tui, shown } = build();
  window.render(100);
  await pause(250);
  assert.equal(tui.renders, 0, "an idle window requests no frame");

  shown.activity = { label: "Waiting for the model…", since: performance.now() };
  const first = activityLine(window.render(100));
  await until(() => tui.renders >= 1, { label: "a frame request for the next spinner frame" });
  const second = activityLine(window.render(100));
  assert.notEqual(second, first, "the next frame shows a new spinner frame");

  tui.renders = 0;
  await until(() => tui.renders >= 1, { label: "the frame request scheduled by the last draw" });
  await pause(400);
  assert.equal(tui.renders, 1, "a window that pi no longer draws requests one frame and stops");

  window.render(100);
  window.dispose();
  tui.renders = 0;
  await pause(400);
  assert.equal(tui.renders, 0, "a disposed window requests no frame");
});

test("a working window that pi keeps drawing requests four spinner frames a second", async () => {
  const { window, tui, shown } = build();
  shown.activity = { label: "Thinking", since: performance.now() };
  let drawing = true;
  tui.requestRender = () => {
    tui.renders += 1;
    setImmediate(() => drawing && window.render(100));
  };
  window.render(100);
  await pause(1100);
  drawing = false;
  window.dispose();
  assert.ok(tui.renders >= 3 && tui.renders <= 5, `${tui.renders} frame requests in 1.1 s`);
});

test("a message held for the side agent shows as sent, above the queued messages", () => {
  const { window, transcript, shown } = build({ rows: 20 });
  fill(transcript, 40);
  shown.outbox = ["first held message", "second held\nmessage"];
  transcript.apply({ type: "queue_update", steering: ["a queued message"], followUp: [] });
  const following = window.render(100);
  assert.equal(following.length, 20);
  assert.match(body(following), /answer 39[\s\S]*❯ first held message[^\n]*\n│ +│\n│ ❯ second held[^\n]*\n│ {3}message[^\n]*\n│ +│\n│ ⏳ queued: a queued message/);

  window.handleInput(KEY.pageUp);
  assert.doesNotMatch(body(window.render(100)), /first held message/);
  window.handleInput(KEY.pageDown);
  assert.deepEqual(window.render(100), following, "paging back down returns to the held messages");

  shown.outbox = [];
  window.touch();
  assert.doesNotMatch(body(window.render(100)), /held/);
});
