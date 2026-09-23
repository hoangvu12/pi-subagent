/**
 * Companion tools for status and result collection.
 *
 * `subagent_status` lists the jobs tracked in this session, privacy-filtered:
 * the listing carries job ids, agent names, lifecycle status, and elapsed
 * time, never task prompts or output. `subagent_result` collects a finished
 * job's full stored output from the registry without blocking; a
 * still-running job reports that it is not done yet.
 *
 * Both tools read the live registry, so they reflect job state as of the
 * call. The graceful-stop companion lives in stop.ts.
 */

import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { capBackgroundOutput, formatBackgroundElapsed, formatLandingLine } from "./background.js";
import { isTerminalJobStatus, type JobRecord, type JobRegistry } from "./jobs.js";
import { getResultSummaryText } from "./runner-events.js";
import type { SingleResult } from "./types.js";

/** Job status as listed by `subagent_status`: `spawned` lists as queued. */
export type JobDisplayStatus = "queued" | "running" | "done" | "failed" | "stopped";

/**
 * One job in a `subagent_status` listing. Privacy-filtered: no prompt, no
 * output, no task text.
 */
export interface JobStatusEntry {
  id: string;
  agent: string;
  status: JobDisplayStatus;
  /** Milliseconds since the job was registered. */
  age: number;
  /**
   * How long the job has run (or ran): elapsed so far for live jobs,
   * start-to-finish duration for finished ones. Undefined when unknown.
   */
  elapsedMs?: number;
}

function toDisplayStatus(status: JobRecord["status"]): JobDisplayStatus {
  if (status === "spawned") return "queued";
  return status;
}

/** Build one privacy-filtered listing entry from a job record. */
export function toStatusEntry(job: JobRecord, nowMs: number): JobStatusEntry {
  const started = Date.parse(job.spawnedAt);
  const age = Number.isFinite(started) ? Math.max(0, nowMs - started) : 0;
  let elapsedMs: number | undefined;
  if (isTerminalJobStatus(job.status) && job.finishedAt) {
    const finished = Date.parse(job.finishedAt);
    if (Number.isFinite(finished) && finished >= started) elapsedMs = finished - started;
  } else {
    elapsedMs = age;
  }
  return {
    id: job.id,
    agent: job.agent,
    status: toDisplayStatus(job.status),
    age,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  };
}

function formatStatusLine(entry: JobStatusEntry): string {
  const elapsed = entry.elapsedMs !== undefined ? formatBackgroundElapsed(entry.elapsedMs) : "an unknown duration";
  switch (entry.status) {
    case "queued":
    case "running":
      return `- ${entry.id} (${entry.agent}): ${entry.status}, ${elapsed} elapsed`;
    case "done":
      return `- ${entry.id} (${entry.agent}): done, ran ${elapsed}`;
    case "failed":
      return `- ${entry.id} (${entry.agent}): failed after ${elapsed}`;
    case "stopped":
      return `- ${entry.id} (${entry.agent}): stopped after ${elapsed}`;
  }
}

/** Compact human/model-readable listing text for status entries. */
export function formatStatusText(entries: JobStatusEntry[]): string {
  if (entries.length === 0) {
    return "No subagent jobs have been started in this session. Every Agent call (foreground or background) is tracked as a job; call subagent_status again after starting one.";
  }
  const counts = new Map<JobDisplayStatus, number>();
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  const summary = (["queued", "running", "done", "failed", "stopped"] as const)
    .filter((status) => counts.get(status))
    .map((status) => `${counts.get(status)} ${status}`)
    .join(", ");
  return [
    `Subagent jobs (${entries.length} total: ${summary}):`,
    "",
    ...entries.map((entry) => formatStatusLine(entry)),
    "",
    "The listing is privacy-filtered: it carries no prompts or output. Use subagent_result to collect a finished job's full output, or subagent_stop to stop a running job.",
  ].join("\n");
}

/** Machine-readable details carried on every `subagent_status` tool result. */
export interface StatusDetails {
  kind: "pi-subagent-status";
  jobs: JobStatusEntry[];
  /** Present when the tool result should be treated as an error. */
  failed?: true;
}

export interface StatusListing {
  text: string;
  details: StatusDetails;
  /** Error text for an unknown job filter; the tool result is an error then. */
  error?: string;
}

function unknownJobError(jobId: string): string {
  return `Unknown subagent job "${jobId}". Use a job id reported by this session's Agent tool results, or omit the filter to list every job.`;
}

export interface StatusListingOptions {
  /** Restrict the listing to one job id. */
  job?: string;
  /** Clock (default: `Date.now`). */
  now?: () => number;
}

/**
 * Build the `subagent_status` listing from the live registry. The optional
 * job filter must name a tracked job; unknown ids error rather than
 * listing nothing.
 */
export function formatStatusListing(
  jobs: JobRegistry,
  options: StatusListingOptions = {},
): StatusListing {
  const now = options.now ?? Date.now;
  let records = jobs.list();
  if (options.job) {
    records = records.filter((record) => record.id === options.job);
    if (records.length === 0) {
      const error = unknownJobError(options.job);
      return {
        text: error,
        details: { kind: "pi-subagent-status", jobs: [], failed: true },
        error,
      };
    }
  }
  const entries = records.map((record) => toStatusEntry(record, now()));
  return {
    text: formatStatusText(entries),
    details: { kind: "pi-subagent-status", jobs: entries },
  };
}

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------

/** Machine-readable details carried on every `subagent_result` tool result. */
export interface SubagentResultDetails {
  kind: "pi-subagent-result";
  /** Job snapshot; null when no job could be resolved. */
  job: JobRecord | null;
  /** Whether the job is finished and its output is included. */
  ready: boolean;
  /** The full stored result, present when ready. */
  result?: SingleResult;
  /** Present when the tool result should be treated as an error. */
  failed?: true;
}

export interface JobResultView {
  content: [{ type: "text"; text: string }];
  details: SubagentResultDetails;
}

export interface JobResultOptions {
  /** Per-child output cap in bytes for the included output. */
  limitBytes?: number;
  /** Clock (default: `Date.now`). */
  now?: () => number;
}

function errorView(job: JobRecord | null, error: string): JobResultView {
  return {
    content: [{ type: "text", text: error }],
    details: { kind: "pi-subagent-result", job, ready: false, failed: true },
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function jobElapsedMs(job: JobRecord, nowMs: number): number {
  const started = Date.parse(job.spawnedAt);
  if (!Number.isFinite(started)) return 0;
  if (isTerminalJobStatus(job.status) && job.finishedAt) {
    const finished = Date.parse(job.finishedAt);
    if (Number.isFinite(finished) && finished >= started) return finished - started;
  }
  return Math.max(0, nowMs - started);
}

/** Text for a finished job: final status, exit info, session, and full output. */
export function formatJobResultText(
  job: JobRecord,
  result: SingleResult,
  options: JobResultOptions = {},
): string {
  const limitBytes = options.limitBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? Date.now;
  const elapsed = formatBackgroundElapsed(jobElapsedMs(job, now()));
  const statusPhrase: Record<string, string> = {
    done: "completed",
    failed: "failed",
    stopped: "was stopped",
  };
  const lines: string[] = [
    `Subagent job ${job.id} (agent ${job.agent}) ${statusPhrase[job.status] ?? job.status} after ${elapsed}.`,
  ];

  const exitBits = [`exit code ${result.exitCode}`];
  if (result.stopReason) exitBits.push(`stop reason "${result.stopReason}"`);
  lines.push(`Status: ${job.status} (${exitBits.join(", ")})`);
  if (result.errorMessage) lines.push(`Error: ${result.errorMessage}`);

  if (job.childSessionId) {
    const label = job.handle ?? job.childSessionId;
    lines.push(
      `Session: ${label}${job.childSessionFile ? ` (${job.childSessionFile})` : ""}`,
    );
  } else {
    lines.push("Session: none (ephemeral call; it cannot be resumed)");
  }
  if (result.resume?.guidance) lines.push(`Resume: ${oneLine(result.resume.guidance)}`);
  if (result.landing) lines.push(`Landing: ${oneLine(formatLandingLine(result.landing))}`);

  const output = capBackgroundOutput(getResultSummaryText(result), limitBytes);
  lines.push("", "Output:", output.text || "(no output)");
  if (output.truncated) {
    lines.push(
      "",
      `[Output truncated to the ${formatSize(limitBytes)} per-child cap. The full output remains in the child's session file on disk.]`,
    );
  }
  return lines.join("\n");
}

function formatNotReadyText(job: JobRecord, nowMs: number): string {
  const entry = toStatusEntry(job, nowMs);
  const elapsed = entry.elapsedMs !== undefined ? ` (${formatBackgroundElapsed(entry.elapsedMs)} elapsed)` : "";
  return [
    `Subagent job ${job.id} (agent ${job.agent}) is still ${entry.status}${elapsed}.`,
    "",
    "Its result is not ready yet. This call never blocks: a compact summary is delivered as a new message when the job finishes, and subagent_result returns the full stored output afterwards. Use subagent_status to monitor progress.",
  ].join("\n");
}

function findJobForHandle(jobs: JobRegistry, handle: string): JobRecord | undefined {
  const matches = jobs.list().filter((job) => job.handle === handle);
  for (let index = matches.length - 1; index >= 0; index--) {
    if (isTerminalJobStatus(matches[index].status)) return matches[index];
  }
  return matches[matches.length - 1];
}

/**
 * Collect one job's stored output, non-blocking. Finished jobs return their
 * full stored result; running jobs report that they are not done. Unknown
 * job ids error. Jobs can be named by id or by session handle (the most
 * recent job for that handle).
 */
export function collectJobResult(
  jobs: JobRegistry,
  target: { jobId?: string; handle?: string },
  options: JobResultOptions = {},
): JobResultView {
  const now = options.now ?? Date.now;
  const { jobId, handle } = target;

  let job: JobRecord | undefined;
  if (jobId) {
    job = jobs.get(jobId);
    if (!job) {
      return errorView(null, `Unknown subagent job "${jobId}". Use the job id from the Agent tool result details, or the session handle the call used.`);
    }
    if (handle && job.handle !== null && job.handle !== handle) {
      return errorView(
        job,
        `Subagent job ${job.id} does not use session handle "${handle}" (it uses "${job.handle}").`,
      );
    }
  } else if (handle) {
    job = findJobForHandle(jobs, handle);
    if (!job) {
      return errorView(
        null,
        `No subagent job found for session handle "${handle}". The handle must name a call from this session.`,
      );
    }
  }

  if (!job) {
    return errorView(null, "Provide `job` (the job id from the Agent tool result details) or `handle` (the session handle the call used) to identify the subagent.");
  }

  if (!isTerminalJobStatus(job.status)) {
    return {
      content: [{ type: "text", text: formatNotReadyText(job, now()) }],
      details: { kind: "pi-subagent-result", job: { ...job }, ready: false },
    };
  }

  const result = jobs.getResult(job.id);
  if (!result) {
    return {
      content: [
        {
          type: "text",
          text: `Subagent job ${job.id} (agent ${job.agent}) finished with status "${job.status}", but no stored output is available for it.`,
        },
      ],
      details: { kind: "pi-subagent-result", job: { ...job }, ready: false },
    };
  }

  return {
    content: [{ type: "text", text: formatJobResultText(job, result, options) }],
    details: { kind: "pi-subagent-result", job: { ...job }, ready: true, result },
  };
}
