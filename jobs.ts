/**
 * Job registry for delegated subagent runs.
 *
 * Every delegation executed through the `Agent` tool is tracked as a job with
 * a short unique id and a lifecycle state. The registry is in-memory, owned by
 * the parent extension instance, and scoped to its parent session; child Pi
 * session files on disk are the durability layer. Later features (background
 * delivery, companion tools, steering, stop, resume, worktrees) build on this
 * registry.
 *
 * Job records are plain JSON-serializable objects. The owning extension
 * embeds the live record in tool result details (as `results[i].job`), so
 * clients observe job identity and lifecycle without any new protocol.
 */

import { randomBytes } from "node:crypto";

/** Job lifecycle: `spawned` -> `running` -> `done` | `failed` | `stopped`. */
export type JobStatus = "spawned" | "running" | "done" | "failed" | "stopped";

const JOB_ID_PREFIX = "job-";
const JOB_ID_RANDOM_BYTES = 6; // 12 hex chars

/**
 * A tracked subagent delegation. Mirrors the spec's job architecture:
 * `{ id, agent, status, childSessionId, childSessionFile, model, cwd,
 * worktree?, spawnedAt }`.
 */
export interface JobRecord {
  /** Short unique job id (`job-<12 hex chars>`), unique within the registry. */
  id: string;
  /** Name of the agent the job runs. */
  agent: string;
  /** Session handle of the call's named session; null for ephemeral calls. */
  handle: string | null;
  /** Lifecycle state. Terminal states (`done`, `failed`, `stopped`) are final. */
  status: JobStatus;
  /**
   * Child Pi session id for named sessions; null for ephemeral (no-session)
   * calls, which have no durable child session to correlate.
   */
  childSessionId: string | null;
  /**
   * Child Pi session JSONL file path once known, or null for ephemeral calls.
   * Filled when the file exists on disk (existing sessions at spawn time, new
   * sessions once the child has flushed it).
   */
  childSessionFile: string | null;
  /** Model configured for the child: call, then agent, then parent model. */
  model: string | null;
  /** Effective working directory of the child process. */
  cwd: string;
  /** Worktree branch when the job runs in a dedicated git worktree (future). */
  worktree?: string;
  /** ISO 8601 timestamp when the job was registered. */
  spawnedAt: string;
}

/** Input for registering a new job. */
export interface JobCreateInput {
  agent: string;
  /** Session handle of the call's named session, when it used one. */
  handle?: string | null;
  childSessionId?: string | null;
  childSessionFile?: string | null;
  model?: string | null;
  cwd: string;
}

function createJobId(taken: Iterable<string>): string {
  const takenSet = taken instanceof Set ? taken : new Set(taken);
  while (true) {
    const id = `${JOB_ID_PREFIX}${randomBytes(JOB_ID_RANDOM_BYTES).toString("hex")}`;
    if (!takenSet.has(id)) return id;
  }
}

/**
 * Session-scoped job registry.
 *
 * Mutation flows through registry methods so later features can hook
 * transitions. `create` and `get` return the live record: the extension embeds
 * it in tool result details, and status changes are visible through those
 * references. `list` returns snapshot copies for read-only consumers such as
 * status tools.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();

  /** Register a new job in the `spawned` state. */
  create(input: JobCreateInput): JobRecord {
    const job: JobRecord = {
      id: createJobId(this.jobs.keys()),
      agent: input.agent,
      handle: input.handle ?? null,
      status: "spawned",
      childSessionId: input.childSessionId ?? null,
      childSessionFile: input.childSessionFile ?? null,
      model: input.model ?? null,
      cwd: input.cwd,
      spawnedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  /** Live job record by id, or undefined. */
  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  /** Snapshot copies of all job records, oldest first. */
  list(): JobRecord[] {
    return Array.from(this.jobs.values(), (job) => ({ ...job }));
  }

  /** Number of registered jobs. */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * Advance a job's lifecycle status. Terminal statuses are final: once a job
   * is `done`, `failed`, or `stopped`, further transitions are ignored.
   * Returns the live record, or undefined for an unknown id.
   */
  setStatus(id: string, status: JobStatus): JobRecord | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status !== "done" && job.status !== "failed" && job.status !== "stopped") {
      job.status = status;
    }
    return job;
  }

  /** Record the child session file path once it is known. */
  setChildSessionFile(id: string, file: string | null): JobRecord | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.childSessionFile = file;
    return job;
  }
}
