import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const customType = "pi-subagent:delegation";

// Only the provider is synthetic. Pi owns the agent loop, RPC, tools, and sessions.
export default function (pi: ExtensionAPI) {
  const logPath = process.env.DELEGATION_TEST_LOG!;
  const log = (record: object) => appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...record })}\n`);
  log({ kind: "process" });
  process.once("exit", () => log({ kind: "exit" }));
  let ctx: ExtensionContext;
  pi.on("session_start", (_event, context) => { ctx = context; });

  // Test inputs for copied history and inherited launch payloads; neither emits a message.
  pi.registerCommand("delegation-test-seed", {
    handler: async (args) => { pi.appendEntry(customType, JSON.parse(args)); },
  });
  pi.registerCommand("delegation-test-payload", {
    handler: async (args) => { process.env.PI_SUBAGENT_DELEGATION = args; },
  });

  pi.registerProvider("delegation-test", {
    api: "delegation-test-api",
    baseUrl: "https://invalid.invalid",
    apiKey: "not-a-real-credential",
    models: ["deterministic", "reasoning"].map((id) => ({
      id,
      name: `Deterministic integration fixture (${id})`,
      reasoning: id === "reasoning",
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 4096,
    })),
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const user = context.messages.findLast((message) => message.role === "user")!;
        const text = typeof user.content === "string" ? user.content : user.content
          .filter((block) => block.type === "text").map((block) => block.text).join("");
        const plan = JSON.parse(text);
        const file = ctx.sessionManager.getSessionFile();
        log({
          kind: "request",
          tag: plan.tag,
          lastRole: context.messages.at(-1)?.role,
          sessionId: ctx.sessionManager.getSessionId(),
          thinking: pi.getThinkingLevel(),
          argv: process.argv,
          header: ctx.sessionManager.getHeader(),
          file: file ?? null,
          diskEntries: file && existsSync(file)
            ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
          entries: ctx.sessionManager.getEntries(),
          contextMessages: context.messages,
          tools: pi.getAllTools().map((tool) => tool.name),
          depth: process.env.PI_SUBAGENT_DEPTH ?? "0",
          temporaryParent: process.env.PI_SUBAGENT_TEMP_PARENT_SESSION ?? "0",
          launchPayload: process.env.PI_SUBAGENT_DELEGATION ?? null,
        });
        stream.push({ type: "start", partial: output });
        const lastIsUser = context.messages.at(-1)?.role === "user";
        const emitToolCall = (id, name, args) => {
          const toolCall = { type: "toolCall" as const, id, name, arguments: args };
          output.content.push(toolCall);
          output.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        };
        if (lastIsUser && plan.fail) {
          output.stopReason = "error";
          stream.push({ type: "error", reason: "error", error: { ...output, errorMessage: `fixture failure: ${plan.tag}` } });
          stream.end();
          return stream;
        } else if (lastIsUser && plan.calls) {
          emitToolCall(`delegate-${plan.tag}`, "Agent", { calls: plan.calls });
        } else if (lastIsUser && plan.bash) {
          emitToolCall(`bash-${plan.tag}`, "bash", { command: plan.bash });
        } else {
          const text = `fixture:${plan.tag}`;
          output.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
      } catch (error) {
        output.stopReason = "error";
        const failed = { ...output, errorMessage: String(error) };
        stream.push({ type: "error", reason: "error", error: failed });
      }
      stream.end();
      return stream;
    },
  });
}
