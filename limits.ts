/**
 * Concurrency cap and spawn budgets for delegation fan-out.
 *
 * Unbounded parallel delegation melts provider rate limits and burns tokens on
 * runaway loops, so every child start — foreground or background — goes
 * through one session-wide concurrency gate: at most N children run at once
 * across the whole extension, and excess calls wait in a FIFO queue that
 * drains as slots free. The gate is the only limiter; the per-invocation
 * worker pool only feeds it.
 *
 * Two budgets bound total fan-out:
 *
 * - Per run: at most `MAX_CALLS` calls in one tool invocation (schema-level).
 * - Per session: a cap on total jobs ever created in this parent session.
 *   Exceeding it rejects the batch with a clear message before any child
 *   spawns, so a delegation loop cannot silently burn tokens.
 *
 * Both knobs follow the shared `PI_SUBAGENT_*` environment convention:
 * invalid values are ignored with a warning.
 */

/**
 * Environment variable overriding the session-wide concurrency cap: the
 * maximum number of subagent children running at once (foreground plus
 * background). Excess calls wait in a FIFO queue.
 */
export const MAX_CONCURRENCY_ENV = "PI_SUBAGENT_MAX_CONCURRENCY";

/** Default concurrency cap. */
export const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Environment variable overriding the per-session spawn budget: the maximum
 * number of subagent jobs this parent session may create in total.
 */
export const SESSION_JOB_BUDGET_ENV = "PI_SUBAGENT_MAX_SESSION_JOBS";

/** Default per-session job budget (total jobs ever created). */
export const DEFAULT_SESSION_JOB_BUDGET = 32;

/**
 * Resolve one integer `PI_SUBAGENT_*` environment setting. Undefined, empty,
 * and invalid values fall back to the default; invalid values warn, matching
 * the shared convention every knob in this family follows. `minimum` widens
 * the accepted range (the job budget accepts 0 to disable delegation).
 */
export function resolveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  expectation: string,
  minimum = 1,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < minimum) {
    console.warn(`[pi-subagent] Ignoring invalid ${name}="${raw}". ${expectation}`);
    return fallback;
  }
  return Number(trimmed);
}

/**
 * Resolve the session-wide concurrency cap from the environment. Invalid
 * values are ignored with a warning, matching the other `PI_SUBAGENT_*`
 * settings.
 */
export function resolveMaxConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return resolveIntegerEnv(
    env,
    MAX_CONCURRENCY_ENV,
    DEFAULT_MAX_CONCURRENCY,
    "Expected a positive integer.",
  );
}

/**
 * Resolve the per-session job budget from the environment. Zero is valid and
 * disables new delegation; invalid values are ignored with a warning.
 */
export function resolveSessionJobBudget(env: NodeJS.ProcessEnv = process.env): number {
  return resolveIntegerEnv(
    env,
    SESSION_JOB_BUDGET_ENV,
    DEFAULT_SESSION_JOB_BUDGET,
    "Expected a non-negative integer.",
    0,
  );
}

/**
 * The clear rejection message for a batch that would exceed the per-session
 * job budget. Emitted before anything spawns, so no child, worktree, or
 * session lock is created.
 */
export function formatSessionBudgetError(existing: number, requested: number, budget: number): string {
  return [
    `Subagent session budget exceeded: this session has already created ${existing} subagent job(s) and the budget is ${budget} (PI_SUBAGENT_MAX_SESSION_JOBS).`,
    `The requested ${requested} call(s) would exceed the budget, so the batch is rejected before any child spawns.`,
    `Start a new session or raise PI_SUBAGENT_MAX_SESSION_JOBS to delegate further.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

/** A held concurrency slot. `release` is idempotent. */
export interface ConcurrencySlot {
  release(): void;
}

interface GateWaiter {
  /** Settle the queued acquire: a handed-off slot, or null when cancelled. */
  settle: (slot: ConcurrencySlot | null) => void;
  /** Detach the waiter from an abort signal without settling it. */
  detach: () => void;
}

/**
 * Session-wide concurrency limiter with a FIFO wait queue.
 *
 * `tryAcquire` takes a free slot synchronously (so callers can advance job
 * state before yielding); `acquire` queues when the cap is reached and
 * resolves in FIFO order as slots free. Queued waiters can be cancelled en
 * masse (`cancelQueued`), which resolves them with null so callers can settle
 * their calls without spawning: session shutdown and abort use this to
 * guarantee that waiting calls never become strays.
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: GateWaiter[] = [];

  constructor(readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError(`ConcurrencyGate requires a positive integer max, got ${max}.`);
    }
  }

  /** Number of children currently holding a slot. */
  get running(): number {
    return this.active;
  }

  /** Number of calls currently waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Take a slot synchronously when one is free and nobody is queued. Returns
   * null when the call must wait (or the cap is reached).
   */
  tryAcquire(): ConcurrencySlot | null {
    if (this.active < this.max && this.waiters.length === 0) {
      this.active++;
      return this.makeSlot();
    }
    return null;
  }

  /**
   * Acquire a slot, queueing FIFO while the cap is reached. Resolves null
   * when the wait was cancelled or the signal aborted before a slot was
   * handed over; a slot handed over right as the signal aborted is released
   * again and reported as null.
   */
  acquire(signal?: AbortSignal): Promise<ConcurrencySlot | null> {
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<ConcurrencySlot | null>((resolve) => {
      const waiter: GateWaiter = {
        settle: resolve,
        detach: () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
            resolve(null);
          }
          // Otherwise the waiter already received a slot; acquire() re-checks.
        },
      };
      this.waiters.push(waiter);
      if (signal) signal.addEventListener("abort", waiter.detach, { once: true });
    }).then((slot) => {
      if (slot && signal?.aborted) {
        slot.release();
        return null;
      }
      return slot;
    });
  }

  /**
   * Cancel every queued waiter, resolving each acquire with null. Queued
   * calls settle without spawning; new acquisitions queue normally
   * afterwards. Returns the number of cancelled waiters.
   */
  cancelQueued(): number {
    const cancelled = this.waiters.splice(0);
    for (const waiter of cancelled) waiter.settle(null);
    return cancelled.length;
  }

  private makeSlot(): ConcurrencySlot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.handOff();
      },
    };
  }

  /** Hand freed slots to the next waiters, in FIFO order. */
  private handOff(): void {
    while (this.active < this.max && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      this.active++;
      next.settle(this.makeSlot());
    }
  }
}
