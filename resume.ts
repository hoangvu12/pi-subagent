/**
 * Fail-soft resume support.
 *
 * A failed delegation never destroys progress: children persist their sessions
 * incrementally, so a failure result carries the partial output, the child
 * session handle, and guidance for one corrective call. This module owns the
 * resume contract — the handle shape, the handle resolution rules, and the
 * guidance wording — so the tool schema, result details, and summaries derive
 * from one place.
 *
 * Resume generalizes the existing named-session continuation: every job's
 * child session id is a resumable handle. A new `Agent` call whose `session`
 * argument is that id continues the persisted child session from where it
 * died, and the child retains its earlier context.
 */

/** Raw child session ids produced by {@linkcode deriveSessionId} in index.ts. */
const CHILD_SESSION_ID_PATTERN = /^subagent\.[0-9a-f]{16}$/;

/**
 * Resume guidance attached to failed results. Mirrored in tool result
 * `details.results[i].resume` and in the model-facing result content.
 */
export interface ResumeInfo {
	/**
	 * Resumable session handle (the child session id), or null when the
	 * failed call ran without a persistent session and cannot be resumed.
	 */
	handle: string | null;
	/** Model-facing guidance for the next corrective call. */
	guidance: string;
}

/** Inputs for {@linkcode buildResumeInfo}. */
export interface ResumeInfoInput {
	/** Agent name to use in the corrective call. */
	agent: string;
	/** Child session id when the failed run has a durable session, else null. */
	handle: string | null;
	/** Whether the child session file with prior progress exists on disk. */
	persisted: boolean;
}

/** Lookup inputs for {@linkcode resolveResumedSessionId}. */
export interface ResumableSessionLookup {
	/** Known jobs from the parent-side registry (snapshots are fine). */
	jobs: ReadonlyArray<{ childSessionId: string | null; cwd: string }>;
	/** Best-effort on-disk session file lookup scoped to a cwd. */
	findSessionFile: (cwd: string, sessionId: string) => string | undefined;
}

/**
 * Whether a `session` argument has the raw child session id shape and should
 * be considered for direct resolution instead of handle derivation.
 */
export function isResumableSessionHandle(handle: string): boolean {
	return CHILD_SESSION_ID_PATTERN.test(handle);
}

/**
 * Resolve a `session` argument that names an existing child session directly
 * to that session id. The cwd is the resolving call's effective working
 * directory — the scope the failed job's session lives in. A handle matches
 * when the parent-side registry knows a job for it in that working directory
 * (covers sessions the failing child never flushed), or when a session file
 * with that exact id exists on disk in that scope (covers handles recovered
 * across parent restarts). Returns undefined when the argument is not a
 * resumable raw id, so the caller falls back to ordinary handle derivation.
 */
export function resolveResumedSessionId(
	handle: string,
	lookup: ResumableSessionLookup,
	cwd: string,
): string | undefined {
	if (!isResumableSessionHandle(handle)) return undefined;
	if (lookup.jobs.some((job) => job.childSessionId === handle && job.cwd === cwd)) {
		return handle;
	}
	if (lookup.findSessionFile(cwd, handle) !== undefined) return handle;
	return undefined;
}

/**
 * Build the resume info embedded in a failed result. The guidance is worded so
 * the main agent's natural next move is one corrective call: `Agent` with
 * `session` set to the reported handle and a prompt explaining what went
 * wrong. Ephemeral failures state explicitly that resume is impossible.
 */
export function buildResumeInfo(input: ResumeInfoInput): ResumeInfo {
	const { agent, handle, persisted } = input;
	if (handle === null) {
		return {
			handle: null,
			guidance:
				`This subagent ran without a persistent session, so its progress cannot be resumed. ` +
				`Rerun the Agent call with a corrected prompt; include a session handle if the work should survive future failures.`,
		};
	}
	if (!persisted) {
		return {
			handle,
			guidance:
				`This subagent failed before its session was persisted, so no prior progress can be continued. ` +
				`Start a corrective Agent call with session "${handle}" and agent "${agent}", restating the task and the fix in the prompt.`,
		};
	}
	return {
		handle,
		guidance:
			`This subagent failed mid-task, but its session is preserved with all progress before the failure. ` +
			`Continue it with one corrective Agent call: session "${handle}" and agent "${agent}", with a prompt explaining what went wrong and what to do next — ` +
			`the subagent picks up from where it stopped, retaining its earlier context.`,
	};
}
