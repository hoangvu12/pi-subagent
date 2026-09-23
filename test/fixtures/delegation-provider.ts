import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const customType = "pi-subagent:delegation";

function messageText(message: { content: string | { type: string; text?: string }[] }): string {
  return typeof message.content === "string" ? message.content : message.content
    .filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

/** Tool calls the provider emits for a plan: delegation, steering, or raw tool scripts. */
function planToolCalls(plan, messages) {
  const calls = [];
  if (messages.at(-1)?.role !== "user") return calls;
  if (Array.isArray(plan.calls)) {
    calls.push({
      type: "toolCall" as const,
      id: `delegate-${plan.tag}`,
      name: "Agent",
      arguments: { calls: plan.calls },
    });
  }
  if (plan.steer) {
    calls.push({
      type: "toolCall" as const,
      id: `steer-${plan.tag}`,
      name: "subagent_steer",
      arguments: { handle: plan.steer.handle, message: plan.steer.message },
    });
  }
  if (Array.isArray(plan.tools)) {
    for (const [index, tool] of plan.tools.entries()) {
      calls.push({
        type: "toolCall" as const,
        id: `tool-${plan.tag}-${index}`,
        name: tool.name,
        arguments: tool.arguments ?? {},
      });
    }
  }
  return calls;
}

/**
 * Scripted course for the steering fixture: turn 1 writes artifact
 * `<tag>-a.txt` (delayed so a parent steering message can queue while the
 * child is mid-run), turn 2 — after the steering message is delivered —
 * writes `<tag>-b.txt` reflecting both the original prompt and the steering
 * message, and the final turn ends the run. Owns its done/end timing
 * because the first turn is delayed.
 */
function steerScriptResponse(stream, output, plan, messages) {
  const userMessages = messages.filter((message) => message.role === "user");
  const originalText = userMessages.length > 0 ? messageText(userMessages[0]) : "";
  const latestUserText = userMessages.length > 0 ? messageText(userMessages[userMessages.length - 1]) : "";
  const toolResults = messages.filter((message) => message.role === "toolResult").length;

  const pushArtifact = (file, content) => {
    const toolCall = {
      type: "toolCall" as const,
      id: `artifact-${file}`,
      name: "delegation_artifact",
      arguments: { path: file, content },
    };
    output.content.push(toolCall);
    output.stopReason = "toolUse";
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
  };
  const finish = () => {
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  };

  if (toolResults === 0) {
    setTimeout(() => {
      pushArtifact(`${plan.tag}-a.txt`, `course: A\nprompt: ${originalText}\n`);
      finish();
    }, plan.steerDelayMs ?? 1000);
    return;
  }
  if (toolResults === 1) {
    pushArtifact(`${plan.tag}-b.txt`, `course: B\nprompt: ${originalText}\nsteer: ${latestUserText}\n`);
    finish();
    return;
  }
  const text = `fixture:${plan.tag}`;
  output.content.push({ type: "text", text });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
  finish();
}

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

  // Writes deterministic artifact files so steering tests can observe a
  // child's course through real tool execution.
  pi.registerTool({
    name: "delegation_artifact",
    label: "Delegation artifact",
    description: "Write a deterministic artifact file (steering integration fixture).",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "File name relative to the process cwd" }),
      content: Type.String({ description: "Exact file content to write" }),
    }),
    async execute(_toolCallId, params) {
      const resolved = path.resolve(process.cwd(), params.path);
      writeFileSync(resolved, params.content, "utf8");
      return {
        content: [{ type: "text", text: `wrote ${params.path}` }],
        details: { kind: "delegation-artifact", path: resolved },
      };
    },
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
        if (context.messages.at(-1)?.role === "user" && plan.calls) {
          const toolCall = {
            type: "toolCall" as const,
            id: `delegate-${plan.tag}`,
            name: "Agent",
            arguments: { calls: plan.calls },
          };
          output.content.push(toolCall);
          output.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
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
