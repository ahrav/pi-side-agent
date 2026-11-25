// A pi extension that registers the provider `scripted`. Each request answers with the step whose index is the
// number of assistant messages already in the request, so a test fixes the whole conversation in SIDE_SCRIPT.
// A step is { text?, thinking?, tools?: [{ name, arguments }], delayMs?, paceMs?, error? }. `delayMs` delays the
// response and `paceMs` spaces its text deltas. Requests past the last step
// answer "DONE". Every request is appended to SIDE_REQUEST_LOG when that variable is set.
// The tool `ask_confirm` opens a confirm dialog and returns the answer.
import * as fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const usage = () => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function chunks(text, size = 5) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export default function (pi) {
  const steps = JSON.parse(process.env.SIDE_SCRIPT ?? "[]");
  pi.registerTool({
    name: "ask_confirm",
    label: "Ask confirm",
    description: "Ask the user to confirm a question.",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const confirmed = await ctx.ui.confirm(params.question, "Asked by the scripted tool.");
      return { content: [{ type: "text", text: `confirmed: ${confirmed}` }], details: {} };
    },
  });
  const model = (id) => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8000 });
  pi.registerProvider("scripted", {
    name: "scripted",
    apiKey: "scripted",
    baseUrl: "http://127.0.0.1:9",
    api: "scripted",
    models: [model("script"), model("script-2")],
    streamSimple(requested, context, options) {
      const stream = createAssistantMessageEventStream();
      if (process.env.SIDE_REQUEST_LOG) {
        fs.appendFileSync(process.env.SIDE_REQUEST_LOG, `${JSON.stringify({ model: requested.id, tools: (context.tools ?? []).map((tool) => tool.name), messages: context.messages })}\n`);
      }
      const index = context.messages.filter((message) => message.role === "assistant").length;
      const step = steps[index] ?? { text: "DONE" };
      const message = { role: "assistant", content: [], api: "scripted", provider: "scripted", model: requested.id, usage: usage(), stopReason: "stop", timestamp: Date.now() };
      const finish = (reason, errorMessage) => {
        message.stopReason = reason;
        if (errorMessage) message.errorMessage = errorMessage;
        if (reason === "error" || reason === "aborted") stream.push({ type: "error", reason, error: message });
        else stream.push({ type: "done", reason, message });
      };
      const run = async () => {
        if (options?.signal?.aborted) return finish("aborted");
        if (step.error) return finish("error", step.error);
        stream.push({ type: "start", partial: message });
        if (step.thinking) {
          const contentIndex = message.content.push({ type: "thinking", thinking: "" }) - 1;
          stream.push({ type: "thinking_start", contentIndex, partial: message });
          for (const delta of chunks(step.thinking)) {
            message.content[contentIndex].thinking += delta;
            stream.push({ type: "thinking_delta", contentIndex, delta, partial: message });
          }
          stream.push({ type: "thinking_end", contentIndex, content: step.thinking, partial: message });
        }
        if (step.text) {
          const contentIndex = message.content.push({ type: "text", text: "" }) - 1;
          stream.push({ type: "text_start", contentIndex, partial: message });
          for (const delta of chunks(step.text)) {
            message.content[contentIndex].text += delta;
            stream.push({ type: "text_delta", contentIndex, delta, partial: message });
            if (step.paceMs) await new Promise((resolve) => setTimeout(resolve, step.paceMs));
            if (options?.signal?.aborted) return finish("aborted");
          }
          stream.push({ type: "text_end", contentIndex, content: step.text, partial: message });
        }
        (step.tools ?? []).forEach((tool, order) => {
          const toolCall = { type: "toolCall", id: `call-${index}-${order}`, name: tool.name, arguments: tool.arguments ?? {} };
          const contentIndex = message.content.push(toolCall) - 1;
          stream.push({ type: "toolcall_start", contentIndex, partial: message });
          stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: message });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
        });
        finish(step.tools?.length ? "toolUse" : "stop");
      };
      if (!step.delayMs) {
        queueMicrotask(run);
        return stream;
      }
      const timer = setTimeout(run, step.delayMs);
      options?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        finish("aborted");
      }, { once: true });
      return stream;
    },
  });
}
