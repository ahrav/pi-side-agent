// A stand-in for `pi --mode rpc`. It answers every command with an empty success response, and it writes a
// prompt's response and the whole run that follows in one stdout write.
import { createInterface } from "node:readline";

const line = (record) => `${JSON.stringify(record)}\n`;

createInterface({ input: process.stdin }).on("line", (text) => {
  const command = JSON.parse(text);
  const response = { id: command.id, type: "response", command: command.type, success: true, data: {} };
  if (command.type !== "prompt") {
    process.stdout.write(line(response));
    return;
  }
  response.data = { disposition: "started" };
  const run = [
    response,
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: command.message } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "instant answer" }] } },
    { type: "agent_settled", aborted: false },
  ];
  process.stdout.write(run.map(line).join(""));
});
process.stdin.on("end", () => process.exit(0));
