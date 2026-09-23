/**
 * Parent-side relay for child questions (`ask_parent`).
 *
 * The runner registers every spawned child's ask directory here and stops
 * watching when the job ends. A shared unref'd poll timer watches the
 * directories: a new `question.json` is relayed into the parent session as a
 * queued user message with follow-up delivery (the same mechanism as
 * background result summaries) naming the job, the agent, and the question,
 * phrased so the natural next move is the `subagent_reply` tool. A
 * `timeout.json` left by a child that gave up waiting is relayed the same way;
 * the job keeps running.
 *
 * `subagent_reply` writes `answer.json` for the job's pending question, which
 * the waiting child picks up on its own poll. The ask mechanism is purely
 * file-based and independent of steering and stopping: `subagent_steer` and
 * `subagent_stop` keep working on a job while its child waits for an answer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  ASK_ANSWER_FILE,
  ASK_QUESTION_FILE,
  ASK_TIMEOUT_FILE,
  formatAskSeconds,
  parseAskQuestionFile,
  parseAskTimeoutFile,
  writeAskFileAtomic,
  type AskQuestionFile,
} from "./ask-parent.js";
import type { JobRecord } from "./jobs.js";

/** Parent-side poll interval for question and timeout files (ms). */
export const ASK_POLL_MS = 250;

/**
 * Parse attempts before a malformed protocol file is given up on. Writes are
 * atomic renames, so persistent parse failures mean corruption; the relay
 * keeps polling for a bounded time first (the writer may still be mid-rename
 * on some filesystems) and then fails soft.
 */
export const ASK_MAX_PARSE_ATTEMPTS = 40;

/** A child question waiting to be relayed (or already relayed, for formatting). */
export interface AskQuestionEvent {
  job: JobRecord;
  question: AskQuestionFile;
}

/** A child that gave up waiting and proceeded on its own. */
export interface AskTimeoutEvent {
  job: JobRecord;
  questionId: string;
  /** How long the child waited (ms). */
  timeoutMs: number;
  /** The question text, when the relay observed it before the timeout. */
  question?: string;
}

/** Where the hub delivers questions and timeouts (owned by the extension). */
export interface AskDelivery {
  onQuestion: (event: AskQuestionEvent) => void;
  onTimeout: (event: AskTimeoutEvent) => void;
}

/** Result of answering a job's pending question. */
export type AskReplyOutcome =
  | { ok: true; job: JobRecord; question: AskQuestionFile; answer: string }
  | { ok: false; code: "no-pending" | "write-failed"; error: string };

/** Machine-readable details carried on every `subagent_reply` tool result. */
export interface ReplyDetails {
  kind: "pi-subagent-reply";
  /** Job snapshot at reply time; null when no job could be resolved. */
  job: JobRecord | null;
  /** The answer that was (or was meant to be) delivered. */
  answer: string;
  /** Whether the answer was written for the job's pending question. */
  delivered: boolean;
  /** Explanation when the answer was not delivered. */
  error?: string;
  /** Present when the tool result should be treated as an error. */
  failed?: true;
}

interface WatchState {
  job: JobRecord;
  dir: string;
  /** Last question id relayed for this job (a child may ask repeatedly). */
  lastQuestionId?: string;
  /** Last timeout notice id relayed for this job. */
  lastTimeoutQuestionId?: string;
  questionParseFailures: number;
  timeoutParseFailures: number;
  questionIgnored: boolean;
  timeoutIgnored: boolean;
}

interface PendingQuestion {
  job: JobRecord;
  dir: string;
  question: AskQuestionFile;
}

function noPendingError(jobId: string): string {
  return `Subagent job ${jobId} has no question waiting for an answer. The child may have timed out and moved on, already finished, or never asked; check the job's latest messages.`;
}

/**
 * Ask-directory relay, owned by the parent extension for the lifetime of its
 * session. One unref'd timer polls every watched directory; it stops with the
 * last watch so no timers outlive their jobs.
 */
export class AskParentHub {
  private readonly watches = new Map<string, WatchState>();
  private readonly pending = new Map<string, PendingQuestion>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly delivery: AskDelivery) {}

  /** Watch one child's ask directory for the lifetime of its job. */
  watch(job: JobRecord, dir: string): void {
    this.watches.set(job.id, {
      job,
      dir,
      questionParseFailures: 0,
      timeoutParseFailures: 0,
      questionIgnored: false,
      timeoutIgnored: false,
    });
    this.ensureTimer();
  }

  /**
   * Stop watching a job (its run ended). Clears any pending question, so a
   * late reply reports no question waiting instead of writing into a
   * directory the child no longer reads.
   */
  stopWatch(jobId: string): void {
    this.watches.delete(jobId);
    this.pending.delete(jobId);
    if (this.watches.size === 0) this.stopTimer();
  }

  /**
   * Answer a job's pending question: write `answer.json` into its ask
   * directory. The waiting child picks the answer up on its own poll and
   * continues with it.
   */
  reply(jobId: string, answer: string): AskReplyOutcome {
    const pending = this.pending.get(jobId);
    if (!pending) {
      return { ok: false, code: "no-pending", error: noPendingError(jobId) };
    }
    try {
      writeAskFileAtomic(path.join(pending.dir, ASK_ANSWER_FILE), {
        version: 1,
        questionId: pending.question.questionId,
        answer,
        answeredAt: new Date().toISOString(),
      });
    } catch (error) {
      return {
        ok: false,
        code: "write-failed",
        error: `Could not deliver the answer to subagent job ${jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    this.pending.delete(jobId);
    return {
      ok: true,
      job: { ...pending.job },
      question: pending.question,
      answer,
    };
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), ASK_POLL_MS);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    for (const state of Array.from(this.watches.values())) {
      this.checkQuestion(state);
      this.checkTimeout(state);
    }
    if (this.watches.size === 0) this.stopTimer();
  }

  private checkQuestion(state: WatchState): void {
    if (state.questionIgnored) return;
    const file = path.join(state.dir, ASK_QUESTION_FILE);
    let raw: string;
    try {
      if (!fs.existsSync(file)) return;
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    const question = parseAskQuestionFile(raw);
    if (!question) {
      state.questionParseFailures += 1;
      if (state.questionParseFailures >= ASK_MAX_PARSE_ATTEMPTS) {
        state.questionIgnored = true;
        console.warn(
          `[pi-subagent] Ignoring a malformed question file for job ${state.job.id}.`,
        );
      }
      return;
    }
    if (question.questionId === state.lastQuestionId) return;
    state.lastQuestionId = question.questionId;
    this.pending.set(state.job.id, { job: state.job, dir: state.dir, question });
    this.deliverSafely(() => this.delivery.onQuestion({ job: { ...state.job }, question }));
  }

  private checkTimeout(state: WatchState): void {
    if (state.timeoutIgnored) return;
    const file = path.join(state.dir, ASK_TIMEOUT_FILE);
    let raw: string;
    try {
      if (!fs.existsSync(file)) return;
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    const timeout = parseAskTimeoutFile(raw);
    if (!timeout) {
      state.timeoutParseFailures += 1;
      if (state.timeoutParseFailures >= ASK_MAX_PARSE_ATTEMPTS) {
        state.timeoutIgnored = true;
        console.warn(
          `[pi-subagent] Ignoring a malformed timeout file for job ${state.job.id}.`,
        );
      }
      return;
    }
    if (timeout.questionId === state.lastTimeoutQuestionId) return;
    state.lastTimeoutQuestionId = timeout.questionId;
    // The child gave up: its pending question (if any) can no longer be
    // answered usefully.
    const pending = this.pending.get(state.job.id);
    const question =
      pending && pending.question.questionId === timeout.questionId
        ? pending.question.question
        : undefined;
    if (pending && pending.question.questionId === timeout.questionId) {
      this.pending.delete(state.job.id);
    }
    this.deliverSafely(() =>
      this.delivery.onTimeout({
        job: { ...state.job },
        questionId: timeout.questionId,
        timeoutMs: timeout.timeoutMs,
        ...(question ? { question } : {}),
      }),
    );
  }

  private deliverSafely(deliver: () => void): void {
    try {
      deliver();
    } catch (error) {
      console.warn(
        `[pi-subagent] Could not relay a subagent question message: ${String(error)}`,
      );
    }
  }
}

function capQuestionText(question: string): string {
  const truncation = truncateHead(question, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return truncation.truncated ? truncation.content : question;
}

/**
 * Queued user message relaying a child question into the parent session.
 * Names the job, the agent, and the question, and points at `subagent_reply`
 * as the natural next move.
 */
export function formatAskQuestionMessage(job: JobRecord, question: AskQuestionFile): string {
  return [
    `Subagent job ${job.id} (agent ${job.agent}) is asking a question mid-task:`,
    "",
    capQuestionText(question.question),
    "",
    `Reply with the subagent_reply tool, passing \`job\` "${job.id}" and your answer. The child is blocked waiting and will continue its task using your answer${
      job.childSessionId ? ` (child session ${job.childSessionId})` : ""
    }.`,
    `If no answer arrives within ${formatAskSeconds(question.timeoutMs)}, the child gives up and proceeds on its own.`,
  ].join("\n");
}

/**
 * Queued user message informing the parent that a child question timed out.
 * The job keeps running: no reply is needed, and the child proceeded on its
 * own.
 */
export function formatAskTimeoutMessage(
  job: JobRecord,
  event: { questionId: string; timeoutMs: number; question?: string },
): string {
  const lines = [
    `Subagent job ${job.id} (agent ${job.agent}) timed out waiting for an answer after ${formatAskSeconds(event.timeoutMs)} and proceeded on its own.`,
    "",
  ];
  if (event.question) {
    lines.push("It asked:", "", capQuestionText(event.question), "");
  }
  lines.push(
    "No reply is needed now: the job keeps running, and its result will show how it continued without the answer.",
  );
  return lines.join("\n");
}
