/**
 * Graceful stop for subagent children.
 *
 * Stopping is a sequence, not a kill: the child first receives a wrap-up
 * instruction over its existing RPC channel (a steer-style user message
 * telling it to report partial progress now), then a bounded grace period
 * to finish that final message, then process-tree termination (Unix process
 * groups, Windows `taskkill /T /F`). The runner owns the per-child state
 * machine and publishes it as a stop handle per job; timeout expiry reuses
 * the same sequence so timeouts produce clean partial results instead of
 * cut-off garbage.
 *
 * A stopped job ends in the `stopped` status with its partial output
 * preserved in the registry: stopping only makes the child's run resolve,
 * so every existing completion path (result storage, queued summary
 * delivery, session-lock release, worktree landing) applies unchanged.
 */

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { capBackgroundOutput, formatBackgroundElapsed } from "./background.js";
import { isTerminalJobStatus, type JobRecord, type JobRegistry } from "./jobs.js";
import { getResultSummaryText } from "./runner-events.js";
import type { SingleResult } from "./types.js";

const DEFAULT_RESULT_LIMIT = DEFAULT_MAX_BYTES;

/**
 * Environment variable overriding the graceful-stop grace period in
 * milliseconds: how long a stopping or timed-out child gets to wrap up
 * before its process tree is terminated.
 */
export const STOP_GRACE_ENV = "PI_SUBAGENT_STOP_GRACE_MS";

/** Default grace period before termination. */
export const DEFAULT_STOP_GRACE_MS = 10_000;

/**
 * Resolve the graceful-stop grace period from the environment. Invalid
 * values are ignored with a warning, matching the other `PI_SUBAGENT_*`
 * settings.
 */
export function resolveStopGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STOP_GRACE_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_STOP_GRACE_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < 1) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${STOP_GRACE_ENV}="${raw}". Expected a positive integer millisecond grace period.`,
    );
    return DEFAULT_STOP_GRACE_MS;
  }
  return Number(trimmed);
}

/**
 * How long a stop call waits for the job's stop handle to appear. Covers
 * the gap between a job's registration and its child's spawn, so a stop
 * issued alongside the spawning `Agent` call still finds its job.
 */
export const STOP_HANDLE_WAIT_MS = 5_000;

/**
 * Extra time a stop call waits for the job to finish after the grace
 * period: termination settling and (for named sessions) the child's natural
 * exit while Pi flushes its session file.
 */
export const STOP_COMPLETION_MARGIN_MS = 15_000;

const CHANNEL_POLL_MS = 25;

/** The RPC command id used for wrap-up instructions; its ack is not awaited. */
export const STOP_WRAPUP_COMMAND_ID = "pi-subagent-stop-wrapup";

/** The wrap-up instruction sent to a child that is being stopped by request. */
export function formatStopWrapUpInstruction(): string {
  return "Stop working on this task now and wrap up. Do not start new work. Report your partial progress, the steps you completed, and any next steps in one final message, then stop.";
}

/** The wrap-up instruction sent to a child whose wall-clock timeout expired. */
export function formatTimeoutWrapUpInstruction(seconds: number): string {
  return `You have exceeded your ${seconds}s run timeout. Stop working on this task now and wrap up. Do not start new work. Report your partial progress, the steps you completed, and any next steps in one final message, then stop.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A live child's graceful-stop control. The runner attaches one per job
 * when the child spawns and detaches it when the run finishes.
 */
export interface SubagentStopHandle {
  /** Job id this handle controls. */
  readonly jobId: string;
  /** Whether a graceful stop has already been initiated for this child. */
  readonly requested: boolean;
  /**
   * Begin the graceful stop sequence: send the wrap-up instruction, wait the
   * grace period, then terminate the process tree. Returns true when
   * initiated; false when the child already settled, closed, or is already
   * stopping or terminating (idempotent).
   *
   * `graceMs` optionally overrides the run's configured grace period for this
   * stop — session shutdown passes a shortened grace so cleanup cannot stall
   * the exit. Omitted, the run's grace (env or default) applies.
   */
  requestStop(reason: string, graceMs?: number): boolean;
}

/**
 * Live stop handles by job id, owned by the parent extension for the
 * lifetime of its session.
 */
export class StopHandleRegistry {
  private readonly handles = new Map<string, SubagentStopHandle>();

  attach(jobId: string, handle: SubagentStopHandle): void {
    this.handles.set(jobId, handle);
  }

  detach(jobId: string): void {
    this.handles.delete(jobId);
  }

  get(jobId: string): SubagentStopHandle | undefined {
    return this.handles.get(jobId);
  }

  /** Wait (bounded) for a job's stop handle to attach. */
  async waitForHandle(jobId: string, timeoutMs: number): Promise<SubagentStopHandle | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const handle = this.handles.get(jobId);
      if (handle) return handle;
      if (Date.now() >= deadline) return undefined;
      await delay(CHANNEL_POLL_MS);
    }
  }
}

/** Which job to stop: its registry id and/or the session handle it runs. */
export interface StopTarget {
  jobId?: string;
  handle?: string;
}

/** A run's completion promise, resolving with its final result once stored. */
export type JobCompletionMap = ReadonlyMap<string, Promise<SingleResult | undefined>>;

export interface StopJobOptions {
  /** Grace period the child gets to wrap up (default: env or 10s). */
  graceMs?: number;
  /** Bound for waiting on the job's stop handle (default STOP_HANDLE_WAIT_MS). */
  handleWaitMs?: number;
  /** Bound for waiting on the job to finish (default: grace + margin). */
  completionWaitMs?: number;
  /** Stop reason recorded on the result (default: stopped by request). */
  reason?: string;
}

/** Result of a stop attempt against the job registry. */
export type StopJobOutcome =
  | { ok: true; outcome: "stopped"; job: JobRecord; result: SingleResult | undefined; reason: string }
  | {
      ok: true;
      outcome: "finished";
      job: JobRecord;
      result: SingleResult | undefined;
      note: string;
    }
  | { ok: true; outcome: "pending"; job: JobRecord; reason: string; note: string }
  | { ok: true; outcome: "already-finished"; job: JobRecord }
  | { ok: false; job: JobRecord | null; error: string };

function unknownJobError(jobId: string): string {
  return `Unknown subagent job "${jobId}". Use the job id from the Agent tool result details, or stop by session handle instead.`;
}

function findByHandle(jobs: JobRegistry, handle: string): JobRecord | undefined {
  const jobsForHandle = jobs.list().filter((job) => job.handle === handle);
  return (
    jobsForHandle.find((job) => !isTerminalJobStatus(job.status)) ??
    jobsForHandle[jobsForHandle.length - 1]
  );
}

/**
 * Stop a running job gracefully and wait (bounded) for it to end.
 *
 * The stop handle initiates the wrap-up -> grace -> terminate sequence in
 * the child's runner; this call then awaits the job's completion so the
 * result reflects the job's final state. Jobs that already finished are
 * reported, not errored: stopping is idempotent.
 */
export async function stopJob(
  jobs: JobRegistry,
  stopHandles: StopHandleRegistry,
  completions: JobCompletionMap,
  target: StopTarget,
  options: StopJobOptions = {},
): Promise<StopJobOutcome> {
  const { jobId, handle } = target;
  const handleWaitMs = options.handleWaitMs ?? STOP_HANDLE_WAIT_MS;
  const graceMs = options.graceMs ?? resolveStopGraceMs();
  const completionWaitMs = options.completionWaitMs ?? graceMs + STOP_COMPLETION_MARGIN_MS;
  const reason = options.reason ?? "Subagent was stopped by request.";

  let resolved: JobRecord | undefined;

  if (jobId) {
    resolved = jobs.get(jobId);
    if (!resolved) {
      return { ok: false, job: null, error: unknownJobError(jobId) };
    }
    if (handle && resolved.handle !== null && resolved.handle !== handle) {
      return {
        ok: false,
        job: { ...resolved },
        error: `Subagent job ${resolved.id} does not use session handle "${handle}" (it uses "${resolved.handle}").`,
      };
    }
  }

  const deadline = Date.now() + handleWaitMs;
  for (;;) {
    if (!resolved && handle) resolved = findByHandle(jobs, handle);
    if (resolved) {
      const live = jobs.get(resolved.id);
      if (!live) {
        return { ok: false, job: { ...resolved }, error: unknownJobError(resolved.id) };
      }
      if (isTerminalJobStatus(live.status)) {
        return { ok: true, outcome: "already-finished", job: { ...live } };
      }
      const stopHandle = stopHandles.get(live.id);
      const completion = completions.get(live.id);
      if (stopHandle && completion) {
        stopHandle.requestStop(reason);
        await Promise.race([
          completion.then(() => undefined, () => undefined),
          delay(completionWaitMs),
        ]);
        const final = jobs.get(live.id);
        const result = final ? jobs.getResult(final.id) : undefined;
        if (final && isTerminalJobStatus(final.status)) {
          if (final.status === "stopped") {
            return { ok: true, outcome: "stopped", job: { ...final }, result, reason };
          }
          return {
            ok: true,
            outcome: "finished",
            job: { ...final },
            result,
            note: `The job finished with status "${final.status}" while the stop was being applied: it completed on its own before termination.`,
          };
        }
        return {
          ok: true,
          outcome: "pending",
          job: { ...(final ?? live) },
          reason,
          note: `The stop was initiated, but the job had not fully terminated within ${completionWaitMs}ms (grace period plus settling). It will end as "stopped" with its partial output preserved.`,
        };
      }
      resolved = live;
    }
    if (Date.now() >= deadline) break;
    await delay(CHANNEL_POLL_MS);
  }

  if (!resolved) {
    return {
      ok: false,
      job: null,
      error: `No subagent job found for session handle "${handle}". The handle must name a call from this session, and the job must still be running.`,
    };
  }
  return {
    ok: false,
    job: { ...resolved },
    error: `Subagent job ${resolved.id} (agent ${resolved.agent}) has no live stop handle. The child may not have spawned yet, or its run may already be finishing; check the job status and retry.`,
  };
}

/** Machine-readable details carried on every `subagent_stop` tool result. */
export interface StopDetails {
  kind: "pi-subagent-stop";
  /** Job snapshot at stop time; null when no job could be resolved. */
  job: JobRecord | null;
  /** Final outcome of the stop attempt. */
  outcome: "stopped" | "finished" | "pending" | "already-finished" | "error";
  /** Explanation for error and pending outcomes. */
  error?: string;
  /** Present when the tool result should be treated as an error. */
  failed?: true;
}

export interface StopViewOptions {
  /** Per-child output cap for the included partial output. */
  limitBytes?: number;
}

/**
 * Tool result content and details for a stop outcome. A successful stop is
 * never an error result, even when the stopped child's own result is one:
 * the stop did what was asked. Already-finished jobs are reported plainly.
 */
export function formatStopView(
  outcome: StopJobOutcome,
  options: StopViewOptions = {},
): { content: [{ type: "text"; text: string }]; details: StopDetails } {
  if (!outcome.ok) {
    return {
      content: [{ type: "text", text: outcome.error }],
      details: {
        kind: "pi-subagent-stop",
        job: outcome.job,
        outcome: "error",
        error: outcome.error,
        failed: true,
      },
    };
  }

  if (outcome.outcome === "already-finished") {
    const text = `Subagent job ${outcome.job.id} (agent ${outcome.job.agent}) is already finished with status "${outcome.job.status}". Nothing to stop: only running jobs can be stopped, and stopping is idempotent.`;
    return {
      content: [{ type: "text", text }],
      details: { kind: "pi-subagent-stop", job: outcome.job, outcome: "already-finished" },
    };
  }

  if (outcome.outcome === "finished") {
    const text = [
      `Subagent job ${outcome.job.id} (agent ${outcome.job.agent}) ${outcome.note}`,
      "",
      formatPartialOutputSection(outcome.result, options),
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      details: { kind: "pi-subagent-stop", job: outcome.job, outcome: "finished" },
    };
  }

  if (outcome.outcome === "pending") {
    const text = [
      `Subagent job ${outcome.job.id} (agent ${outcome.job.agent}) stop initiated but not yet complete.`,
      "",
      outcome.note,
      "",
      `The wrap-up instruction was sent and the grace period started; the job's status is "${outcome.job.status}". Check subagent_status, or call subagent_result once it finishes.`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      details: { kind: "pi-subagent-stop", job: outcome.job, outcome: "pending", error: outcome.note },
    };
  }

  const job = outcome.job;
  const duration = jobDurationText(job);
  const text = [
    `Subagent job ${job.id} (agent ${job.agent}) stopped${duration ? ` after ${duration}` : ""}.`,
    "",
    "The child received a wrap-up instruction (report partial progress), then a bounded grace period, then process-tree termination. The job ended as \"stopped\": its partial output is preserved and retrievable via the subagent_result tool.",
    "",
    formatPartialOutputSection(outcome.result, options),
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: { kind: "pi-subagent-stop", job, outcome: "stopped" },
  };
}

function jobDurationText(job: JobRecord): string {
  const started = Date.parse(job.spawnedAt);
  const ended = job.finishedAt ? Date.parse(job.finishedAt) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return "";
  return formatBackgroundElapsed(ended - started);
}

function formatPartialOutputSection(
  result: SingleResult | undefined,
  options: StopViewOptions,
): string {
  if (!result) return "Partial output: (none captured before the stop).";
  const capped = capBackgroundOutput(getResultSummaryText(result), options.limitBytes ?? DEFAULT_RESULT_LIMIT);
  return `Partial output:\n${capped.text || "(no output)"}`;
}