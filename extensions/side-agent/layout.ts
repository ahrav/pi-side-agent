import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OverlayAnchor, OverlayOptions } from "@earendil-works/pi-tui";

export type Dock = "center" | "left" | "right" | "top" | "bottom";

export interface WindowLayout {
  dock: Dock;
  width: number;
  height: number;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export interface SideAgentConfig {
  window: WindowLayout;
  toggleKey: string;
  model?: ModelRef;
  thinkingLevel?: string;
}

export const MIN_PERCENT = 30;
export const MIN_ROWS = 10;
export const RESIZE_STEP = 5;
export const DEFAULT_TOGGLE_KEY = "alt+a";

export const DOCK_LAYOUTS: Record<Dock, WindowLayout> = {
  center: { dock: "center", width: 92, height: 90 },
  left: { dock: "left", width: 50, height: 100 },
  right: { dock: "right", width: 50, height: 100 },
  top: { dock: "top", width: 100, height: 50 },
  bottom: { dock: "bottom", width: 100, height: 50 },
};

const ANCHORS: Record<Dock, OverlayAnchor> = {
  center: "center",
  left: "left-center",
  right: "right-center",
  top: "top-center",
  bottom: "bottom-center",
};

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const NAMED_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end",
  "pageup", "pagedown", "up", "down", "left", "right", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

function isDock(value: unknown): value is Dock {
  return typeof value === "string" && value in DOCK_LAYOUTS;
}

function clampPercent(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(MIN_PERCENT, Math.round(number)));
}

export function normalizeLayout(value: unknown): WindowLayout {
  const input = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof WindowLayout, unknown>>;
  const dock = isDock(input.dock) ? input.dock : "center";
  const base = DOCK_LAYOUTS[dock];
  return { dock, width: clampPercent(input.width, base.width), height: clampPercent(input.height, base.height) };
}

/**
 * `resizeLayout` treats `step` as percentage points: left/right docks resize width, top/bottom docks
 * resize height, and center resizes both. `normalizeLayout` rounds and clamps the result.
 */
export function resizeLayout(layout: WindowLayout, step: number): WindowLayout {
  const horizontal = layout.dock !== "top" && layout.dock !== "bottom";
  const vertical = layout.dock !== "left" && layout.dock !== "right";
  return normalizeLayout({
    dock: layout.dock,
    width: horizontal ? layout.width + step : layout.width,
    height: vertical ? layout.height + step : layout.height,
  });
}

export function isMaximized(layout: WindowLayout): boolean {
  return layout.width === 100 && layout.height === 100;
}

export function overlayOptionsFor(layout: WindowLayout): OverlayOptions {
  return { anchor: ANCHORS[layout.dock], width: `${layout.width}%`, minWidth: 40, maxHeight: "100%", margin: 0, nonCapturing: true };
}

export function windowRows(terminalRows: number, layout: WindowLayout): number {
  return Math.max(Math.min(MIN_ROWS, terminalRows), Math.min(terminalRows, Math.floor((terminalRows * layout.height) / 100)));
}

export function parseSize(args: string, layout: WindowLayout): WindowLayout | string {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0] === "full") return { dock: layout.dock, width: 100, height: 100 };
  const numbers = words.map((word) => Number(word.replace(/%$/, "")));
  if (words.length < 1 || words.length > 2 || numbers.some((number) => !Number.isFinite(number))) {
    return `Usage: /size <width%> [height%] | full. Current size: ${layout.width}% x ${layout.height}%.`;
  }
  return normalizeLayout({ dock: layout.dock, width: numbers[0], height: numbers[1] ?? layout.height });
}

export function parseDock(args: string): WindowLayout | string {
  const dock = args.trim().toLowerCase();
  return isDock(dock) ? { ...DOCK_LAYOUTS[dock] } : `Usage: /dock ${Object.keys(DOCK_LAYOUTS).join(" | ")}.`;
}

export function isKeyId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.toLowerCase().split("+");
  const base = parts.pop();
  if (!base || (base.length === 1 ? /\s/.test(base) : !NAMED_KEYS.has(base))) return false;
  return parts.every((part) => MODIFIERS.has(part)) && new Set(parts).size === parts.length;
}

export function defaultConfig(): SideAgentConfig {
  return { window: { ...DOCK_LAYOUTS.center }, toggleKey: DEFAULT_TOGGLE_KEY };
}

export function normalizeConfig(value: unknown): SideAgentConfig {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const config: SideAgentConfig = {
    window: normalizeLayout(input.window),
    toggleKey: isKeyId(input.toggleKey) ? input.toggleKey.toLowerCase() : DEFAULT_TOGGLE_KEY,
  };
  const model = input.model as Partial<ModelRef> | undefined;
  if (model && typeof model.provider === "string" && typeof model.id === "string") config.model = { provider: model.provider, id: model.id };
  if (typeof input.thinkingLevel === "string") config.thinkingLevel = input.thinkingLevel;
  return config;
}

export function readConfig(path: string): SideAgentConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(path: string, config: SideAgentConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
