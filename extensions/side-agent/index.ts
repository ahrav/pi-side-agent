import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, type KeyId, Markdown, Text } from "@earendil-works/pi-tui";
import { SideAgentController } from "./controller.ts";
import { readConfig } from "./layout.ts";
import { CHILD_ENV, MAIN_MESSAGE_TYPE } from "./protocol.ts";

const COMMANDS = ["side-agent", "sa"];

export default function (pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] === "1") return;

  const agentDir = getAgentDir();
  const configPath = join(agentDir, "side-agent.json");
  const controller = new SideAgentController({
    pi,
    config: readConfig(configPath),
    configPath,
    sessionDir: join(agentDir, "side-agent", "sessions"),
    bridgePath: join(dirname(fileURLToPath(import.meta.url)), "child.ts"),
  });

  for (const name of COMMANDS) {
    pi.registerCommand(name, {
      description: "Open the side agent window. Text after the command is sent to the side agent.",
      handler: async (args, ctx) => controller.open(ctx, args.trim() || undefined),
    });
  }

  pi.registerShortcut(controller.config.toggleKey as KeyId, {
    description: "Open the side agent window, or move focus between it and the main editor.",
    handler: (ctx) => controller.toggle(ctx),
  });

  pi.registerMessageRenderer(MAIN_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details as { text?: string; expectsReply?: boolean } | undefined;
    const text = details?.text ?? (typeof message.content === "string" ? message.content : "");
    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(details?.expectsReply ? "side agent asks" : "side agent")), 0, 0));
    box.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }));
    return box;
  });

  pi.on("session_shutdown", () => controller.shutdown());
}
