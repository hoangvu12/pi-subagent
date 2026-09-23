/**
 * Child-side `ask_parent` tool.
 *
 * The parent extension's runner loads this file in every spawned subagent
 * process (`--extension`, the same explicit-loading pattern as
 * delegation-metadata.ts) and hands the child a private ask directory through
 * the `PI_SUBAGENT_ASK_DIR` environment variable. The tool is registered only
 * when that marker is set, so unrelated sessions that load the file never see
 * it.
 *
 * Asking writes a versioned `question.json` into the directory and then waits,
 * polling for an `answer.json` the parent writes through its `subagent_reply`
 * tool. The wait honors an optional per-question timeout (default 120s): on
 * expiry the child writes `timeout.json` — the parent-side hub relays it as a
 * queued message — and the tool returns a clear "no answer arrived" result so
 * the child proceeds without guessing instead of hanging. An answer written
 * for a different question is never mistaken for this one's.
 *
 * The wait emits periodic progress updates, which keeps the parent's
 * inactivity watchdog fed: a child legitimately waiting on its parent is not
 * a silent child.
 *
 * Every file is written through a temp-file rename so a reader never observes
 * a partial JSON document, and the whole protocol is file-based: no sockets
 * and no platform-specific signaling.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Environment variable carrying the child's private ask directory (the activation marker). */
export const ASK_PARENT_DIR_ENV = "PI_SUBAGENT_ASK_DIR";

/** Tool name the child model calls. */
export const ASK_PARENT_TOOL_NAME = "ask_parent";

/** Default wait before a child gives up on an answer (ms). */
export const ASK_PARENT_DEFAULT_TIMEOUT_MS = 120_000;

/** Maximum allowed wait before a child gives up on an answer (ms). */
export const ASK_PARENT_MAX_TIMEOUT_MS = 3_600_000;

/** How often the waiting child checks for the answer file (ms). */
export const ASK_PARENT_POLL_MS = 100;

/** How often the waiting child emits a progress update (ms). */
export const ASK_PARENT_PROGRESS_MS = 1_000;

// File names of the ask-directory protocol, shared with the parent-side relay
// (questions.ts). The ask directory itself maps to exactly one job.
export const ASK_QUESTION_FILE = "question.json";
export const ASK_ANSWER_FILE = "answer.json";
export const ASK_TIMEOUT_FILE = "timeout.json";

/** Question file written by the child (versioned cross-process contract). */
export interface AskQuestionFile {
  version: 1;
  /** Unique id of this question; answers and timeouts correlate by it. */
  questionId: string;
  /** The question text, delivered verbatim. */
  question: string;
  /** How long the child waits before giving up (ms). */
  timeoutMs: number;
  /** ISO 8601 timestamp when the child asked. */
  askedAt: string;
  /** Child Pi session id when known; the parent relay may echo it. */
  childSessionId?: string;
}

/** Answer file written by the parent's `subagent_reply` tool. */
export interface AskAnswerFile {
  version: 1;
  questionId: string;
  answer: string;
  answeredAt: string;
}

/** Timeout notice file written by a child that gave up waiting. */
export interface AskTimeoutFile {
  version: 1;
  questionId: string;
  timeoutMs: number;
  timedOutAt: string;
}

/**
 * Write one protocol file atomically: a temp file in the same directory plus
 * a rename, so a concurrent reader never sees a partial document.
 */
export function writeAskFileAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** Parse an answer file strictly; malformed input yields undefined (fail-soft). */
export function parseAskAnswerFile(raw: string): AskAnswerFile | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.questionId !== "string" || !record.questionId.trim()) return undefined;
  if (typeof record.answer !== "string") return undefined;
  return {
    version: 1,
    questionId: record.questionId,
    answer: record.answer,
    answeredAt: typeof record.answeredAt === "string" ? record.answeredAt : "",
  };
}

/** Parse a question file strictly; malformed input yields undefined (fail-soft). */
export function parseAskQuestionFile(raw: string): AskQuestionFile | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.questionId !== "string" || !record.questionId.trim()) return undefined;
  if (typeof record.question !== "string" || !record.question.trim()) return undefined;
  if (
    typeof record.timeoutMs !== "number" ||
    !Number.isFinite(record.timeoutMs) ||
    record.timeoutMs < 1
  ) {
    return undefined;
  }
  const question: AskQuestionFile = {
    version: 1,
    questionId: record.questionId,
    question: record.question,
    timeoutMs: Math.floor(record.timeoutMs),
    askedAt: typeof record.askedAt === "string" ? record.askedAt : "",
  };
  if (typeof record.childSessionId === "string" && record.childSessionId) {
    question.childSessionId = record.childSessionId;
  }
  return question;
}

/** Parse a timeout notice strictly; malformed input yields undefined (fail-soft). */
export function parseAskTimeoutFile(raw: string): AskTimeoutFile | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.questionId !== "string" || !record.questionId.trim()) return undefined;
  if (
    typeof record.timeoutMs !== "number" ||
    !Number.isFinite(record.timeoutMs) ||
    record.timeoutMs < 1
  ) {
    return undefined;
  }
  return {
    version: 1,
    questionId: record.questionId,
    timeoutMs: Math.floor(record.timeoutMs),
    timedOutAt: typeof record.timedOutAt === "string" ? record.timedOutAt : "",
  };
}

/** Human-readable seconds for timeout wording shared by both sides. */
export function formatAskSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function resolveAskDir(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AskParentParams = Type.Object({
  question: Type.String({
    description: "One clear question for the parent agent. Delivered verbatim.",
    minLength: 1,
  }),
  timeout: Type.Optional(
    Type.Integer({
      description:
        "Seconds to wait for the answer before giving up (default 120, maximum 3600).",
      minimum: 1,
      maximum: 3_600,
    }),
  ),
});

/**
 * Loaded explicitly in children. Inert unless the ask-directory marker env is
 * set, so the tool never appears in unrelated sessions.
 */
export default function (pi: ExtensionAPI) {
  const askDir = resolveAskDir(process.env[ASK_PARENT_DIR_ENV]);
  if (!askDir) return;

  pi.registerTool({
    name: ASK_PARENT_TOOL_NAME,
    label: "Ask parent",
    description: [
      "Ask the parent agent — the main conversation that delegated this task — one clarifying question and wait for its answer.",
      "Use it when the answer materially changes how you should proceed and guessing would risk significant wasted work; do not use it for anything you can reasonably determine yourself.",
      "The parent is notified immediately and answers through its subagent_reply tool; this call blocks until the answer arrives or the timeout expires.",
      "On timeout the tool returns a \"no answer arrived\" result — proceed with the most reasonable interpretation and state the assumption you made.",
    ].join(" "),

    parameters: AskParentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const question = params.question.trim();
      const askedAt = Date.now();
      const timeoutMs = Math.min(
        params.timeout !== undefined ? params.timeout * 1000 : ASK_PARENT_DEFAULT_TIMEOUT_MS,
        ASK_PARENT_MAX_TIMEOUT_MS,
      );
      const questionId = randomUUID();
      const details = (answered: boolean, waitedMs: number) => ({
        kind: "pi-subagent-ask" as const,
        questionId,
        answered,
        waitedMs,
        timeoutMs,
      });

      let childSessionId: string | null = null;
      try {
        childSessionId = ctx.sessionManager.getSessionId();
      } catch {
        childSessionId = null;
      }

      try {
        writeAskFileAtomic(path.join(askDir, ASK_QUESTION_FILE), {
          version: 1,
          questionId,
          question,
          timeoutMs,
          askedAt: new Date(askedAt).toISOString(),
          ...(childSessionId ? { childSessionId } : {}),
        });
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `ask_parent could not deliver the question to the parent session: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          details: details(false, 0),
        };
      }

      const answerPath = path.join(askDir, ASK_ANSWER_FILE);
      const readAnswer = (): string | undefined => {
        try {
          if (!fs.existsSync(answerPath)) return undefined;
          const parsed = parseAskAnswerFile(fs.readFileSync(answerPath, "utf8"));
          // Only an answer for this question unblocks the wait; a leftover
          // answer for an earlier question must not be mistaken for this one.
          if (!parsed || parsed.questionId !== questionId || !parsed.answer) return undefined;
          return parsed.answer;
        } catch {
          return undefined;
        }
      };

      const deadline = askedAt + timeoutMs;
      let lastProgress = 0;
      for (;;) {
        const answer = readAnswer();
        if (answer !== undefined) {
          return {
            content: [{ type: "text" as const, text: answer }],
            details: details(true, Date.now() - askedAt),
          };
        }
        if (signal?.aborted) {
          return {
            content: [
              {
                type: "text" as const,
                text: "The wait for a parent answer was interrupted before an answer arrived; the run was aborted.",
              },
            ],
            details: details(false, Date.now() - askedAt),
          };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const now = Date.now();
        // Periodic progress keeps the parent's inactivity watchdog fed and
        // gives live visibility into the waiting child.
        if (onUpdate && now - lastProgress >= ASK_PARENT_PROGRESS_MS) {
          lastProgress = now;
          try {
            onUpdate({
              content: [
                {
                  type: "text" as const,
                  text: `Waiting for the parent's answer (${Math.max(
                    1,
                    Math.ceil(remaining / 1000),
                  )}s remaining)...`,
                },
              ],
              details: details(false, now - askedAt),
            });
          } catch {
            // Progress is best-effort.
          }
        }
        await delay(Math.min(ASK_PARENT_POLL_MS, remaining));
      }

      // Timed out: report back to the parent (best-effort) and return a clear
      // result so the child can proceed without guessing.
      try {
        writeAskFileAtomic(path.join(askDir, ASK_TIMEOUT_FILE), {
          version: 1,
          questionId,
          timeoutMs,
          timedOutAt: new Date().toISOString(),
        });
      } catch {
        // The parent-side relay also fails soft.
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `No answer from the parent arrived within ${formatAskSeconds(timeoutMs)}. Proceed without an answer: choose the most reasonable interpretation, state the assumption you made in your final response, and continue the task.`,
          },
        ],
        details: details(false, timeoutMs),
      };
    },
  });
}
