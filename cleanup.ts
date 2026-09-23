/**
 * Session hygiene: orphan cleanup, abort propagation, and headless exit.
 *
 * Background subagent children are owned by their parent session for its
 * whole lifetime. When that session ends — quit, reload, switch, or fork —
 * pi fires `session_shutdown` before the extension runtime is torn down, and
 * this module stops every owned child through the graceful-stop machinery
 * (wrap-up instruction, bounded grace, process-tree termination), then
 * sweeps worktrees by applying their landing policy — patch and pr jobs
 * land their work instead of losing it — before any removal. Child session
 * files are never deleted: they are the durability layer, resumable by handle.
 *
 * Cleanup is idempotent: running it twice is a no-op, because stopped jobs
 * are terminal (skipped) and swept worktrees are already gone. The whole
 * wait is bounded so cleanup can never deadlock a shutdown.
 *
 * The same stop path serves abort propagation: interrupting the parent's
 * current operation (the AbortSignal pi passes to the tool invocation)
 * hard-aborts foreground children through their runner and gracefully stops
 * background jobs, so interrupting the parent never leaves strays.
 */

import { isTerminalJobStatus, type JobRecord, type JobRegistry } from "./jobs.js";
import { resolveIntegerEnv } from "./limits.js";
import type { JobCompletionMap, StopHandleRegistry } from "./stop.js";
import type { SingleResult } from "./types.js";
import {
  applyWorktreeLanding,
  type LandingReport,
  type WorktreePlan,
} from "./worktrees.js";

/**
 * Environment variable overriding the grace period, in milliseconds, each
 * child receives to wrap up when the session shuts down. Shorter than the
 * interactive stop grace (PI_SUBAGENT_STOP_GRACE_MS) because shutdown
 * cleanup must not stall the exit.
 */
export const SHUTDOWN_GRACE_ENV = "PI_SUBAGENT_SHUTDOWN_GRACE_MS";

/** Default per-child grace during session shutdown cleanup. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

/**
 * Environment variable overriding the total bound, in milliseconds, for one
 * session cleanup: the deadline for every owned child to settle. Cleanup
 * never waits longer than this, so a stuck child cannot deadlock shutdown.
 */
export const SHUTDOWN_TIMEOUT_ENV = "PI_SUBAGENT_SHUTDOWN_TIMEOUT_MS";

/** Default total wait bound for one session cleanup. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Resolve the shutdown cleanup grace period from the environment. Invalid
 * values are ignored with a warning, matching the other `PI_SUBAGENT_*`
 * settings.
 */
export function resolveShutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveIntegerEnv(
    env,
    SHUTDOWN_GRACE_ENV,
    DEFAULT_SHUTDOWN_GRACE_MS,
    "Expected a positive integer millisecond grace period.",
  );
}

/**
 * Resolve the total shutdown cleanup bound from the environment. Invalid
 * values are ignored with a warning.
 */
export function resolveShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveIntegerEnv(
    env,
    SHUTDOWN_TIMEOUT_ENV,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    "Expected a positive integer millisecond bound.",
  );
}

const CHANNEL_POLL_MS = 25;

/** Clock and sleep injection for tests. */
export interface CleanupTiming {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Outcome of one session cleanup: what was stopped and what was swept. */
export interface CleanupReport {
  /** Jobs that were live (queued or running) when cleanup started, with their final state. */
  stopped: JobRecord[];
  /** Jobs still non-terminal after the bounded wait (termination was requested). */
  pending: JobRecord[];
  /** Gate waiters cancelled so queued calls never spawn. */
  cancelledQueued: number;
  /** Worktree plans whose directory was removed by the sweep. */
  worktreesRemoved: WorktreePlan[];
  /** Worktree plans kept: landing policy `keep`, or removal failed. */
  worktreesKept: WorktreePlan[];
  /** Landing reports for swept patch/pr worktrees: the applied policy and its artifacts. */
  landings: LandingReport[];
  /** The per-child grace applied to shutdown stops. */
  graceMs: number;
  /** The total wait bound that was applied. */
  totalTimeoutMs: number;
}

export interface SessionCleanupInput {
  /** The session's job registry. */
  jobs: JobRegistry;
  /** Live graceful-stop handles by job id. */
  stopHandles: StopHandleRegistry;
  /** Completion promises by job id (resolving when the job's run is fully settled). */
  completions: JobCompletionMap;
  /** The session-wide concurrency gate; queued waiters are cancelled. */
  gate: { queued: number; cancelQueued(): number };
  /** Materialized worktrees whose jobs have not terminated yet. */
  pendingWorktrees: Set<WorktreePlan>;
  /**
   * Prompt per job id, used by the sweep's landing reports (PR bodies).
   * Optional: without it the sweep falls back to a placeholder prompt.
   */
  prompts?: ReadonlyMap<string, string>;
}

export interface SessionCleanupOptions extends CleanupTiming {
  /** Per-child grace for shutdown stops (default: env or 2000ms). */
  graceMs?: number;
  /** Total bound for the whole cleanup (default: env or 15000ms). */
  totalTimeoutMs?: number;
  /** Per-job bound for waiting on a stop handle to attach (default: 1000ms). */
  handleWaitMs?: number;
  /** Reason recorded on stopped results (default: session shutdown). */
  reason?: string;
}

/**
 * Run one session cleanup: stop every owned live child, settle queued calls,
 * and sweep pending worktrees. Bounded and idempotent — a second run finds
 * only terminal jobs and an empty worktree set, and does nothing.
 *
 * The stop is the graceful-stop sequence per child: the wrap-up instruction,
 * a shortened grace period, then process-tree termination. Jobs waiting for
 * a concurrency slot never spawned; cancelling their gate wait settles them
 * as stopped without a child. Child session files are never touched.
 */
export async function cleanupSession(
  input: SessionCleanupInput,
  options: SessionCleanupOptions = {},
): Promise<CleanupReport> {
  const graceMs = options.graceMs ?? resolveShutdownGraceMs();
  const totalTimeoutMs = options.totalTimeoutMs ?? resolveShutdownTimeoutMs();
  const handleWaitMs = options.handleWaitMs ?? 1_000;
  const reason =
    options.reason ?? "Subagent was stopped because its parent session ended.";
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;

  const live = input.jobs.list().filter((job) => !isTerminalJobStatus(job.status));
  const report: CleanupReport = {
    stopped: [],
    pending: [],
    cancelledQueued: 0,
    worktreesRemoved: [],
    worktreesKept: [],
    landings: [],
    graceMs,
    totalTimeoutMs,
  };

  // Nothing to stop and nothing queued: the sweep still runs (it is a no-op
  // on an empty set), keeping the whole cleanup idempotent.
  const deadline = now() + totalTimeoutMs;
  if (live.length > 0 || input.gate.queued > 0) {
    // Queued calls must never start after their session is gone.
    report.cancelledQueued = input.gate.cancelQueued();

    // Request a graceful stop from every live child. The handle attaches when
    // the child spawns, so a job registered microseconds ago gets a short,
    // bounded wait; queued jobs settle through the cancelled gate wait and
    // need no handle at all.
    await Promise.all(
      live.map(async (job) => {
        const waitUntil = Math.min(now() + handleWaitMs, deadline);
        for (;;) {
          const current = input.jobs.get(job.id);
          if (!current || isTerminalJobStatus(current.status)) return;
          const handle = input.stopHandles.get(job.id);
          if (handle) {
            handle.requestStop(reason, graceMs);
            return;
          }
          if (now() >= waitUntil) return;
          await sleep(CHANNEL_POLL_MS);
        }
      }),
    );

    // Bounded wait for every live job's run to settle. The deadline bounds
    // the total cleanup; a child that refuses to die is reported as pending,
    // never blocking the shutdown forever.
    const completions = live
      .map((job) => input.completions.get(job.id))
      .filter((completion): completion is Promise<SingleResult | undefined> =>
        Boolean(completion));
    if (completions.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const bounded = new Promise<void>((resolve) => {
        const remaining = Math.max(0, deadline - now());
        timer = setTimeout(resolve, remaining);
      });
      try {
        await Promise.race([
          Promise.all(completions.map((completion) => completion.then(
            () => undefined,
            () => undefined,
          ))),
          bounded,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  for (const job of live) {
    const final = input.jobs.get(job.id) ?? job;
    if (isTerminalJobStatus(final.status)) report.stopped.push(final);
    else report.pending.push(final);
  }

  // Sweep worktrees whose jobs never terminated through a normal landing.
  // The landing policy applies before any removal — a patch/pr job keeps
  // its work instead of losing it — mirroring the foreground completion
  // path (including its fail-soft catch). Branches survive every policy; an
  // already-removed worktree is skipped, so the sweep stays idempotent and
  // a second run finds an empty set.
  const sweep = Array.from(input.pendingWorktrees);
  input.pendingWorktrees.clear();
  for (const plan of sweep) {
    if (plan.landing === "keep") {
      report.worktreesKept.push(plan);
      continue;
    }
    try {
      const job = input.jobs.get(plan.jobId);
      const landing = await applyWorktreeLanding(plan, {
        jobId: plan.jobId,
        agent: job?.agent ?? "unknown",
        status: job?.status ?? "stopped",
        prompt: input.prompts?.get(plan.jobId) ?? "(job prompt unavailable during session cleanup)",
        childSessionId: job?.childSessionId ?? null,
      });
      report.landings.push(landing);
      (landing.worktreeRemoved ? report.worktreesRemoved : report.worktreesKept).push(plan);
    } catch (error) {
      console.warn(
        `[pi-subagent] Could not remove worktree ${plan.path} during session cleanup: ${String(error)}`,
      );
      report.worktreesKept.push(plan);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Abort propagation
// ---------------------------------------------------------------------------

export interface AbortStopOptions extends CleanupTiming {
  /** Jobs owned by the aborting invocation's foreground calls; their runner aborts them directly. */
  excludeJobIds?: ReadonlySet<string>;
  /** Reason recorded on stopped results (default: parent operation aborted). */
  reason?: string;
  /** Bound for waiting on each job's stop handle (default: 5000ms). */
  handleWaitMs?: number;
}

/**
 * Stop every live background job when the parent's current operation is
 * aborted (Esc / Ctrl+C). pi passes the tool invocation's AbortSignal to
 * `execute`; foreground children already abort through their runner's own
 * signal wiring, so this targets the detached background jobs — including
 * queued ones, whose gate wait is cancelled so they never spawn.
 *
 * Fire-and-forget: the invocation does not wait for background jobs to die
 * (they are detached by design); the stops proceed with the standard
 * graceful-stop grace and each job releases its session lock when it
 * settles.
 */
export async function stopJobsForAbort(
  jobs: JobRegistry,
  stopHandles: StopHandleRegistry,
  gate: { cancelQueued(): number },
  options: AbortStopOptions = {},
): Promise<void> {
  const reason =
    options.reason ?? "Subagent was stopped because the parent operation was aborted.";
  const handleWaitMs = options.handleWaitMs ?? 5_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const exclude = options.excludeJobIds;

  // Aborted operations stop starting new work: queued calls settle without
  // spawning (their own invocation reports them as aborted/stopped).
  gate.cancelQueued();

  const deadline = now() + handleWaitMs;
  const targets = jobs
    .list()
    .filter((job) => !isTerminalJobStatus(job.status) && !exclude?.has(job.id));
  if (targets.length === 0) return;

  await Promise.all(
    targets.map(async (job) => {
      const waitUntil = now() + handleWaitMs;
      for (;;) {
        const current = jobs.get(job.id);
        if (!current || isTerminalJobStatus(current.status)) return;
        const handle = stopHandles.get(job.id);
        if (handle) {
          handle.requestStop(reason);
          return;
        }
        if (now() >= Math.min(waitUntil, deadline)) return;
        await sleep(CHANNEL_POLL_MS);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Headless (print mode) exit report
// ---------------------------------------------------------------------------

function jobLine(job: JobRecord, pending: boolean): string {
  const state = pending
    ? "still terminating at the exit deadline (process-tree termination was requested)"
    : `stopped${job.status === "stopped" ? "" : ` (status "${job.status}")`}`;
  const session = job.childSessionId
    ? `session ${job.childSessionId}${job.childSessionFile ? ` (${job.childSessionFile})` : ""}`
    : "no session (ephemeral call; it cannot be resumed)";
  return `- ${job.id} (agent ${job.agent}): ${state}; ${session}`;
}

/**
 * The report written to stderr when a print-mode (`pi -p`) session exits
 * with subagent jobs still running: which jobs were live, that they were
 * stopped, and where their persisted sessions live. Null when nothing was
 * live (nothing to report).
 */
export function formatHeadlessExitReport(report: CleanupReport): string | null {
  const live = [...report.stopped, ...report.pending];
  if (live.length === 0) return null;
  const lines = [
    `pi-subagent: ${live.length} background job(s) were still running when this print-mode session exited.`,
    "Each was stopped (wrap-up instruction, bounded grace, then process-tree termination). Child sessions persist on disk and stay resumable.",
    ...live.map((job) => jobLine(job, report.pending.includes(job))),
  ];
  if (report.pending.length > 0) {
    lines.push(
      "Jobs listed as still terminating did not settle within the shutdown bound; their process trees were terminated.",
    );
  }
  lines.push("Resume a job's session by its session id with a new Agent call.");
  return lines.join("\n");
}
