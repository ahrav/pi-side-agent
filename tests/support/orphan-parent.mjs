// Starts a side agent process, prints its pid once it answers, and then idles until it is killed.
import * as path from "node:path";
import { launchArgs, SideProcess } from "../../extensions/side-agent/process.ts";
import { SIDE_AGENT_PROMPT } from "../../extensions/side-agent/protocol.ts";
import { bridgePath, scriptedPi } from "./fakes.mjs";

const home = process.argv[2];
const pi = scriptedPi(home, []);
const side = new SideProcess({
  invocation: pi.invocation([...launchArgs({ bridgePath, sessionDir: path.join(home, "sessions"), trusted: true, systemPrompt: SIDE_AGENT_PROMPT }), ...pi.extraArgs]),
  cwd: home,
  env: pi.env,
  onRecord() {},
  onBridge() {},
  onExit() {},
});
side.start();
await side.request({ type: "get_state" });
console.log(side.pid);
setInterval(() => {}, 1000);
