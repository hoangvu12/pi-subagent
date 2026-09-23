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
 * A child question relayed into the parent session (questions.ts wording),
 * recognized by its fixed phrasing so the parent fixture can answer through
 * the real subagent_reply tool.
 */
function extractRelayedQuestion(userText) {
  if (typeof userText !== "string") return undefined;
  const match = userText.match(
    /^Subagent job (job-[0-9a-f]+) \(agent ([^)]+)\) is asking a question mid-task:\n\n([\s\S]*?)\n\nReply with the subagent_reply tool/,
  );
  return match ? { jobId: match[1], agent: match[2], question: match[3] } : undefined;
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
    async streamSimple(model, context) {
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
        // Scripted test inputs are JSON plans. Any other user text (for example
        // an injected background-subagent summary) is answered with plain text.
        let plan: any;
        try { plan = JSON.parse(text); } catch { plan = undefined; }
        const file = ctx.sessionManager.getSessionFile();
        log({
          kind: "request",
          tag: plan?.tag,
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
        // Scripted modes (used by background-delivery and steering tests):
        // delay the response, fail the run, or emit oversized output.
        if (plan?.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
        // A bare `fail: true` fails the whole run by throwing (caught below,
        // surfacing as a runner-level error). A `fail: { partial, error }`
        // object instead streams partial output and ends the assistant run
        // with a terminal error while the child session keeps its progress.
        if (plan?.fail === true) throw new Error("deliberate fixture failure");
        stream.push({ type: "start", partial: output });
        // Scripted mid-task stall: the request never resolves, so the runner's
        // inactivity watchdog kills the child mid-run. Only follow-up requests
        // (after a tool result) stall, so a plan can still emit its progress
        // note and tool call before the child dies; tool execution itself
        // emits progress heartbeats that would keep the watchdog fed.
        if (plan.hang && context.messages.at(-1)?.role !== "user") {
          await new Promise(() => {});
        }
        const lastIsUser = context.messages.at(-1)?.role === "user";
        // Parent-side question answering: a relayed child question is not a
        // JSON plan; recognize it by its fixed phrasing and answer it through
        // the real subagent_reply tool, unless the question asks to be left
        // unanswered (the child-timeout test path).
        const relayedQuestion = plan ? undefined : extractRelayedQuestion(text);
        const declinedQuestion = relayedQuestion?.question.includes("DO-NOT-ANSWER") === true;
        let terminal = "done";
        const emitToolCall = (id, name, args) => {
          const contentIndex = output.content.length;
          const toolCall = { type: "toolCall" as const, id, name, arguments: args };
          output.content.push(toolCall);
          output.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
        };
        const emitNote = () => {
          if (typeof plan?.note !== "string") return;
          const noteIndex = output.content.length;
          output.content.push({ type: "text", text: plan.note });
          stream.push({ type: "text_start", contentIndex: noteIndex, partial: output });
          stream.push({ type: "text_delta", contentIndex: noteIndex, delta: plan.note, partial: output });
          stream.push({ type: "text_end", contentIndex: noteIndex, content: plan.note, partial: output });
        };
        if (lastIsUser && plan.calls) {
          // Optional progress note flushed with the tool call before a stall.
          emitNote();
          emitToolCall(`delegate-${plan.tag}`, "Agent", { calls: plan.calls });
        } else if (lastIsUser && Array.isArray(plan.tools)) {
          // Companion-tool plans: the fixture emits the requested tool calls
          // and Pi executes the real production tools.
          emitNote();
          for (const [index, tool] of plan.tools.entries()) {
            emitToolCall(`tool-${plan.tag}-${index}`, tool.name, tool.arguments ?? {});
          }
        } else if (lastIsUser && plan.ask !== undefined) {
          // Child-side ask_parent plans: the first turn asks the parent; the
          // child blocks on the answer tool.
          emitNote();
          emitToolCall(`ask-${plan.tag}`, "ask_parent", {
            question: plan.ask,
            ...(plan.askTimeout ? { timeout: plan.askTimeout } : {}),
          });
        } else if (lastIsUser && relayedQuestion && !declinedQuestion) {
          emitToolCall(`reply-${relayedQuestion.jobId}`, "subagent_reply", {
            job: relayedQuestion.jobId,
            answer: "fixture-answer-42",
          });
        } else if (lastIsUser && plan.bash) {
          emitNote();
          emitToolCall(`bash-${plan.tag}`, "bash", { command: plan.bash });
        } else if (lastIsUser && plan.fail) {
          // Scripted mid-task failure: partial output is streamed, then the
          // assistant run ends with a terminal error while the child session
          // keeps everything written so far.
          const text = typeof plan.fail.partial === "string" ? plan.fail.partial : `partial:${plan.tag}`;
          output.content.push({ type: "text", text });
          output.stopReason = "error";
          output.errorMessage = typeof plan.fail.error === "string" ? plan.fail.error : "scripted subagent failure";
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          terminal = "error";
        } else if (!lastIsUser && plan?.ask !== undefined &&
            context.messages.at(-1)?.role === "toolResult" &&
            context.messages.at(-1)?.toolName === "ask_parent") {
          // The ask_parent tool returned: the final message reports exactly
          // what the child saw (the parent's answer or the no-answer notice).
          const body = `child-saw:${messageText(context.messages.at(-1))}`;
          output.content.push({ type: "text", text: body });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_delta", contentIndex: 0, delta: body, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: body, partial: output });
        } else {
          const body = plan?.bigOutputBytes
            ? `${"x".repeat(99)}\n`.repeat(Math.ceil(plan.bigOutputBytes / 100))
            : `fixture:${plan?.tag ?? "unparsed"}`;
          output.content.push({ type: "text", text: body });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_delta", contentIndex: 0, delta: body, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: body, partial: output });
        }
        if (terminal === "done") {
          stream.push({ type: "done", reason: output.stopReason, message: output });
        } else {
          stream.push({ type: "error", reason: "error", error: output });
        }
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
