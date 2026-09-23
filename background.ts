/**
 * Background delivery formatting and output capping.
 *
 * A `background: true` call returns from the tool invocation immediately
 * with its job id while the child keeps running detached. When the job
 * finishes (done or failed), the extension injects a compact result summary
 * into the parent session as a queued user message with follow-up delivery
 * (pi delivers it as a new turn when the parent agent is idle, and queues it
 * meanwhile). Full output is never injected: anything delivered into the
 * parent context is capped per child, and the full result stays stored in
 * the job registry for on-demand retrieval.
 *
 * This module is pure formatting plus capping; the extension owns the
 * delivery timing and ownership handoff.
 */

import { StringDecoder } from "node:string_decoder";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { JobRecord } from "./jobs.js";
import { getResultSummaryText } from "./runner-events.js";
import type { SingleResult } from "./types.js";
import type { LandingReport } from "./worktrees.js";

/**
 * Environment variable overriding the per-child output cap for anything
 * injected into the parent context, in bytes. Defaults to Pi's standard
 * 50KB tool-output limit.
 */
export const BACKGROUND_OUTPUT_LIMIT_ENV = "PI_SUBAGENT_MAX_OUTPUT_BYTES";

/**
 * Resolve the per-child output cap from the environment. Invalid values are
 * ignored with a warning, matching the other `PI_SUBAGENT_*` settings.
 */
export function resolveBackgroundOutputLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[BACKGROUND_OUTPUT_LIMIT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_BYTES;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < 1) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${BACKGROUND_OUTPUT_LIMIT_ENV}="${raw}". Expected a positive integer byte limit.`,
    );
    return DEFAULT_MAX_BYTES;
  }
  return Number(trimmed);
}

function truncateUtf8FromHead(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // Drop a trailing partial UTF-8 sequence rather than emitting replacement characters.
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes));
}

export interface CappedOutput {
  /** Output text to include, never longer than the byte cap. */
  text: string;
  /** Whether the original text exceeded the cap. */
  truncated: boolean;
  /** The byte limit that was applied. */
  limitBytes: number;
}

/**
 * Cap output text included in anything injected into the parent context.
 * Follows the shared output-capping convention (byte and line limits via
 * Pi's `truncateHead`), with a byte-slice fallback for single-line output
 * that exceeds the byte cap (`truncateHead` would otherwise drop it entirely).
 */
export function capBackgroundOutput(text: string, limitBytes: number): CappedOutput {
  const truncation = truncateHead(text, {
    maxBytes: limitBytes,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) {
    return { text, truncated: false, limitBytes };
  }
  if (truncation.firstLineExceedsLimit || truncation.content.length === 0) {
    return {
      text: truncateUtf8FromHead(text, limitBytes),
      truncated: true,
      limitBytes,
    };
  }
  return { text: truncation.content, truncated: true, limitBytes };
}

/** Human-readable run duration for a background job summary. */
export function formatBackgroundElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "0.0s";
  const seconds = elapsedMs / 1000;
  if (seconds < 120) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 120) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function statusPhrase(status: JobRecord["status"]): string {
  switch (status) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "was stopped";
    default:
      return status;
  }
}

/**
 * Tool result text for a background invocation: returned immediately with
 * the job ids while the children keep running detached.
 */
export function formatBackgroundAck(results: SingleResult[]): string {
  const lines = results.map((result) => {
    const id = result.job?.id ?? "(untracked job)";
    return `- ${id} (${result.agent}): ${result.job?.status ?? "running"}`;
  });
  const singular = results.length === 1;
  const subject = singular
    ? "Background subagent started:"
    : `Background subagents started (${results.length} jobs):`;
  const tail = singular
    ? "This call returns immediately; the subagent keeps running detached from the tool call."
    : "This call returns immediately; the subagents keep running detached from the tool call.";
  return [
    subject,
    "",
    ...lines,
    "",
    `${tail} When a job finishes, its compact result summary is delivered here as a new message, and its full output is retrievable via the subagent_result tool.`,
  ].join("\n");
}

export interface BackgroundResultSummaryOptions {
  /** Per-child output cap in bytes (default: Pi's standard 50KB limit). */
  limitBytes?: number;
  /** Clock used for the elapsed time (default: `Date.now`). */
  now?: () => number;
}

/**
 * Compact result summary injected into the parent session as a queued user
 * message when a background job finishes. Contains the job id, agent name,
 * status, elapsed time, and the capped output; points at the `subagent_result`
 * tool for the full output, which is never injected automatically.
 */
export function formatBackgroundResultMessage(
  job: JobRecord,
  result: SingleResult,
  options: BackgroundResultSummaryOptions = {},
): string {
  const limitBytes = options.limitBytes ?? DEFAULT_MAX_BYTES;
  const spawnedAtMs = Date.parse(job.spawnedAt);
  const now = options.now?.() ?? Date.now();
  const elapsedMs = Number.isFinite(spawnedAtMs) ? Math.max(0, now - spawnedAtMs) : 0;
  const bodyLabel = job.status === "done" ? "Output:" : "Error:";
  const output = capBackgroundOutput(getResultSummaryText(result), limitBytes);

  const lines = [
    `Background subagent job ${job.id} (${job.agent}) ${statusPhrase(job.status)} after ${formatBackgroundElapsed(elapsedMs)}.`,
    "",
    bodyLabel,
    output.text || "(no output)",
  ];
  if (output.truncated) {
    lines.push("", `[Output truncated to the ${formatSize(limitBytes)} per-child cap.]`);
  }
  if (result.landing) {
    lines.push("", formatLandingLine(result.landing));
  }
  lines.push(
    "",
    "The full output of this job remains available on demand via the subagent_result tool.",
  );
  return lines.join("\n");
}

/** One-line landing report for result and stop messages. */
export function formatLandingLine(landing: LandingReport): string {
  const parts = [`Landing (${landing.policy}): branch ${landing.branch}`];
  if (landing.patchFile) parts.push(`patch at ${landing.patchFile}`);
  if (landing.prUrl) parts.push(`PR ${landing.prUrl}`);
  if (!landing.worktreeRemoved) parts.push("worktree kept");
  if (landing.note) parts.push(landing.note);
  return `${parts.join("; ")}.`;
}
