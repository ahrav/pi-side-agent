import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  DEFAULT_TOGGLE_KEY,
  DOCK_LAYOUTS,
  defaultConfig,
  isKeyId,
  isMaximized,
  normalizeConfig,
  normalizeLayout,
  overlayOptionsFor,
  parseDock,
  parseSize,
  readConfig,
  resizeLayout,
  windowRows,
  writeConfig,
} from "../extensions/side-agent/layout.ts";
import { tempDir } from "./support/fakes.mjs";

test("the default window covers most of the terminal", () => {
  assert.deepEqual(defaultConfig().window, { dock: "center", width: 92, height: 90 });
  assert.equal(windowRows(50, defaultConfig().window), 45);
  assert.equal(overlayOptionsFor(defaultConfig().window).width, "92%");
});

test("normalizeLayout clamps sizes to 30..100 percent and falls back to the dock's size", () => {
  assert.deepEqual(normalizeLayout({ dock: "right", width: 5, height: 400 }), { dock: "right", width: 30, height: 100 });
  assert.deepEqual(normalizeLayout({ dock: "left" }), DOCK_LAYOUTS.left);
  assert.deepEqual(normalizeLayout({ dock: "nowhere", width: "wide" }), DOCK_LAYOUTS.center);
  assert.deepEqual(normalizeLayout(null), DOCK_LAYOUTS.center);
  assert.deepEqual(normalizeLayout({ dock: "center", width: 66.6, height: 71.4 }), { dock: "center", width: 67, height: 71 });
});

test("resizeLayout changes the axes the dock leaves free", () => {
  assert.deepEqual(resizeLayout({ dock: "center", width: 80, height: 70 }, 5), { dock: "center", width: 85, height: 75 });
  assert.deepEqual(resizeLayout({ dock: "right", width: 50, height: 100 }, 5), { dock: "right", width: 55, height: 100 });
  assert.deepEqual(resizeLayout({ dock: "bottom", width: 100, height: 50 }, -5), { dock: "bottom", width: 100, height: 45 });
  assert.deepEqual(resizeLayout({ dock: "center", width: 98, height: 32 }, 5), { dock: "center", width: 100, height: 37 });
  assert.deepEqual(resizeLayout({ dock: "center", width: 31, height: 31 }, -5), { dock: "center", width: 30, height: 30 });
  assert.equal(isMaximized({ dock: "top", width: 100, height: 100 }), true);
  assert.equal(isMaximized({ dock: "top", width: 100, height: 50 }), false);
});

test("windowRows is the height share of the terminal, within the terminal", () => {
  const layout = (height) => ({ dock: "center", width: 92, height });
  assert.equal(windowRows(60, layout(100)), 60);
  assert.equal(windowRows(60, layout(50)), 30);
  assert.equal(windowRows(24, layout(30)), 10);
  assert.equal(windowRows(8, layout(90)), 8);
});

test("each dock anchors the overlay to its edge", () => {
  const anchors = Object.fromEntries(Object.keys(DOCK_LAYOUTS).map((dock) => [dock, overlayOptionsFor(DOCK_LAYOUTS[dock]).anchor]));
  assert.deepEqual(anchors, { center: "center", left: "left-center", right: "right-center", top: "top-center", bottom: "bottom-center" });
  assert.deepEqual(overlayOptionsFor(DOCK_LAYOUTS.right), { anchor: "right-center", width: "50%", minWidth: 40, maxHeight: "100%", margin: 0, nonCapturing: true });
});

test("parseSize and parseDock accept their forms and explain anything else", () => {
  const layout = { dock: "right", width: 50, height: 100 };
  assert.deepEqual(parseSize("95 85", layout), { dock: "right", width: 95, height: 85 });
  assert.deepEqual(parseSize("70%", layout), { dock: "right", width: 70, height: 100 });
  assert.deepEqual(parseSize("full", layout), { dock: "right", width: 100, height: 100 });
  assert.deepEqual(parseSize("10 500", layout), { dock: "right", width: 30, height: 100 });
  for (const bad of ["", "wide", "1 2 3"]) assert.match(parseSize(bad, layout), /^Usage: \/size .*Current size: 50% x 100%\.$/);
  assert.deepEqual(parseDock(" Left "), DOCK_LAYOUTS.left);
  assert.match(parseDock("middle"), /^Usage: \/dock center \| left \| right \| top \| bottom\.$/);
});

test("isKeyId accepts pi key ids and rejects other text", () => {
  for (const key of ["alt+a", "ctrl+alt+w", "f5", "ctrl+shift+pageup", "alt+/", "super+k"]) assert.equal(isKeyId(key), true, key);
  for (const key of ["", "alt+", "cmd+x", "alt+alt+a", "alt+ab", "alt+ ", 7, null]) assert.equal(isKeyId(key), false, String(key));
});

test("normalizeConfig keeps valid fields and replaces invalid ones with defaults", () => {
  assert.deepEqual(normalizeConfig({ window: { dock: "left", width: 40 }, toggleKey: "CTRL+ALT+K", model: { provider: "p", id: "m" }, thinkingLevel: "high", extra: 1 }), {
    window: { dock: "left", width: 40, height: 100 },
    toggleKey: "ctrl+alt+k",
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
  });
  assert.deepEqual(normalizeConfig({ toggleKey: "cmd+x", model: { provider: "p" }, thinkingLevel: 3 }), { window: DOCK_LAYOUTS.center, toggleKey: DEFAULT_TOGGLE_KEY });
  assert.deepEqual(normalizeConfig("nonsense"), defaultConfig());
});

test("a written config reads back, and a missing or broken file reads as the defaults", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "nested", "side-agent.json");
  assert.deepEqual(readConfig(file), defaultConfig());
  const config = { window: { dock: "bottom", width: 100, height: 60 }, toggleKey: "alt+j", model: { provider: "p", id: "m/with/slash" }, thinkingLevel: "low" };
  await writeConfig(file, config);
  assert.deepEqual(readConfig(file), config);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["side-agent.json"], "the temporary file is renamed into place");
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(readConfig(file), defaultConfig());
});
