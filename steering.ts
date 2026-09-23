/**
 * Mid-run steering for subagent children.
 *
 * Steering sends a user message into a running child over its existing RPC
 * channel: the runner writes Pi's native `steer` command on the child's
 * stdin, and the child queues the message for delivery after its current
 * tool call, before its next model response. The child is never restarted;
 * it course-corrects asynchronously while the steering call returns quickly
 * with an acknowledgement.
 *
 * The RPC `steer` command is valid whether the child is streaming or idle —
 * unlike `prompt`, it always queues and never needs `streamingBehavior`. A
 * child that has already finished has no channel to steer; the job registry
 * rejects that case before any write is attempted.
 */

import { isTerminalJobStatus, type JobRecord, type JobRegistry } from "./jobs.js";

/** How long to wait for the child's `response` ack after sending a steer command. */
export const STEER_ACK_TIMEOUT_MS = 10_000;

/**
 * How long a steering call waits for a job's channel to appear. Covers the
 * gap between a job's registration and its child's first `agent_start`, so
 * a steer issued alongside the spawning `Agent` call still finds its job.
 */
export const STEER_CHANNEL_WAIT_MS = 5_000;

const CHANNEL_POLL_MS = 25;

/** Failure kinds reported for a steering attempt. */
export type SteerFailureCode = "channel-closed" | "write-failed" | "timeout" | "rejected";

/** The child accepted the steering message and queued it for delivery. */
export interface SteerAck {
  delivered: true;
}

/** The steering message could not be delivered. */
export interface SteerFailure {
  delivered: false;
  code: SteerFailureCode;
  error: string;
}

export type SteerOutcome = SteerAck | SteerFailure;

/** One write on the child's RPC stdin; reports flush or write errors. */
export type SteerWriter = (
  line: string,
  onWritten: (error: Error | null) => void,
) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Steering channel for one live child process.
 *
 * The runner owns the channel: it writes steer commands through the injected
 * writer and routes every parsed child stdout event into `handleResponse`,
 * which correlates acks to pending requests by their command id.
 */
export class SteerChannel {
  private readonly write: SteerWriter;
  private readonly pending = new Map<
    string,
    { settle: (outcome: SteerOutcome) => void; timer: NodeJS.Timeout }
  >();
  private sequence = 0;
  private closed = false;
  private closeReason: string | undefined;

  constructor(write: SteerWriter) {
    this.write = write;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Send one steering message. Resolves as soon as the child acknowledges
   * the queued message, the write fails, the channel closes, or the
   * bounded acknowledgement timeout expires.
   */
  steer(message: string, timeoutMs: number = STEER_ACK_TIMEOUT_MS): Promise<SteerOutcome> {
    if (this.closed) {
      return Promise.resolve(this.channelClosedFailure());
    }
    const id = `pi-subagent-steer-${++this.sequence}`;
    return new Promise<SteerOutcome>((resolve) => {
      const settle = (outcome: SteerOutcome) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        settle({
          delivered: false,
          code: "timeout",
          error: `The subagent did not acknowledge the steering message within ${timeoutMs}ms. It may be unresponsive; the message may or may not have been delivered.`,
        });
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { settle, timer });

      const onWritten = (error: Error | null) => {
        if (!error) return;
        settle({
          delivered: false,
          code: "write-failed",
          error: `Could not send the steering message to the subagent: ${error.message}`,
        });
      };
      try {
        this.write(`${JSON.stringify({ type: "steer", id, message })}\n`, onWritten);
      } catch (error) {
        onWritten(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Route one parsed child stdout event. Returns true when the event
   * resolved a pending steering request.
   */
  handleResponse(event: unknown): boolean {
    if (!event || typeof event !== "object") return false;
    const record = event as {
      type?: unknown;
      id?: unknown;
      command?: unknown;
      success?: unknown;
      error?: unknown;
    };
    if (record.type !== "response" || record.command !== "steer" || typeof record.id !== "string") {
      return false;
    }
    const entry = this.pending.get(record.id);
    if (!entry) return false;
    if (record.success === true) {
      entry.settle({ delivered: true });
    } else {
      const error = typeof record.error === "string" && record.error.trim()
        ? record.error
        : "The subagent rejected the steering message.";
      entry.settle({ delivered: false, code: "rejected", error });
    }
    return true;
  }

  /**
   * Tear the channel down (the child exited or the run settled). Pending
   * steering requests fail with a channel-closed outcome; new ones fail
   * immediately.
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, entry] of this.pending) {
      entry.settle(this.channelClosedFailure());
    }
    this.pending.clear();
  }

  private channelClosedFailure(): SteerFailure {
    return {
      delivered: false,
      code: "channel-closed",
      error: `The subagent's steering channel is closed: ${this.closeReason ?? "the child process is no longer running."}`,
    };
  }
}

/**
 * Live steering channels by job id, owned by the parent extension for the
 * lifetime of its session. The runner attaches a channel when the child's
 * agent run starts and detaches it when the run settles.
 */
export class SteerChannelRegistry {
  private readonly channels = new Map<string, SteerChannel>();

  attach(jobId: string, channel: SteerChannel): void {
    this.channels.set(jobId, channel);
  }

  detach(jobId: string): void {
    this.channels.delete(jobId);
  }

  get(jobId: string): SteerChannel | undefined {
    return this.channels.get(jobId);
  }

  /** Wait (bounded) for a job's channel to attach. */
  async waitForChannel(jobId: string, timeoutMs: number): Promise<SteerChannel | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const channel = this.channels.get(jobId);
      if (channel) return channel;
      if (Date.now() >= deadline) return undefined;
      await delay(CHANNEL_POLL_MS);
    }
  }
}

/** Which job to steer: its registry id and/or the session handle it runs. */
export interface SteerTarget {
  jobId?: string;
  handle?: string;
}

/** Result of a steering attempt against the job registry. */
export type SteerJobOutcome =
  | { ok: true; job: JobRecord; message: string }
  | { ok: false; job: JobRecord | null; message: string; error: string };

export interface SteerJobOptions {
  /** Bound for waiting on the job's channel (default STEER_CHANNEL_WAIT_MS). */
  channelWaitMs?: number;
}

function unknownJobError(jobId: string): string {
  return `Unknown subagent job "${jobId}". Use the job id from the Agent tool result details, or steer by session handle instead.`;
}

function notRunningError(job: JobRecord): string {
  return `Subagent job ${job.id} (agent ${job.agent}) is not running: its status is "${job.status}". Only running jobs can be steered.`;
}

function noChannelError(job: JobRecord): string {
  return `Subagent job ${job.id} (agent ${job.agent}) has no live steering channel. The child may not have started an agent run, or its channel may already be closed; check the job status and retry.`;
}

function findByHandle(jobs: JobRegistry, handle: string): JobRecord | undefined {
  const jobsForHandle = jobs.list().filter((job) => job.handle === handle);
  return (
    jobsForHandle.find((job) => !isTerminalJobStatus(job.status)) ??
    jobsForHandle[0]
  );
}

/**
 * Resolve a running job and deliver a steering message to its child.
 *
 * The bounded wait covers jobs that were just registered (a steer issued
 * alongside the spawning `Agent` tool call) and channels that attach once
 * the child's agent run starts. Terminal jobs fail immediately.
 */
export async function steerJob(
  jobs: JobRegistry,
  channels: SteerChannelRegistry,
  target: SteerTarget,
  message: string,
  options: SteerJobOptions = {},
): Promise<SteerJobOutcome> {
  const { jobId, handle } = target;
  const waitMs = options.channelWaitMs ?? STEER_CHANNEL_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let resolved: JobRecord | undefined;

  if (jobId) {
    resolved = jobs.get(jobId);
    if (!resolved) {
      return { ok: false, job: null, message, error: unknownJobError(jobId) };
    }
    if (handle && resolved.handle !== null && resolved.handle !== handle) {
      return {
        ok: false,
        job: { ...resolved },
        message,
        error: `Subagent job ${resolved.id} does not use session handle "${handle}" (it uses "${resolved.handle}").`,
      };
    }
  }

  for (;;) {
    if (!resolved && handle) resolved = findByHandle(jobs, handle);
    if (resolved) {
      const live = jobs.get(resolved.id);
      if (!live) {
        return { ok: false, job: { ...resolved }, message, error: unknownJobError(resolved.id) };
      }
      if (isTerminalJobStatus(live.status)) {
        return { ok: false, job: { ...live }, message, error: notRunningError(live) };
      }
      const channel = channels.get(live.id);
      if (channel) {
        const outcome = await channel.steer(message, STEER_ACK_TIMEOUT_MS);
        if (outcome.delivered) {
          return { ok: true, job: { ...live }, message };
        }
        return { ok: false, job: { ...live }, message, error: outcome.error };
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
      message,
      error: `No subagent job found for session handle "${handle}". The handle must name a call from this session, and the job must still be running.`,
    };
  }
  return { ok: false, job: { ...resolved }, message, error: noChannelError(resolved) };
}

/** Machine-readable details carried on every `subagent_steer` tool result. */
export interface SteerDetails {
  kind: "pi-subagent-steer";
  /** Job snapshot at steer time; null when no job could be resolved. */
  job: JobRecord | null;
  /** The steering message that was sent. */
  message: string;
  /** Whether the child acknowledged the message as queued. */
  delivered: boolean;
  /** Explanation when the message was not delivered. */
  error?: string;
  /** Present when the tool result should be treated as an error. */
  failed?: true;
}
