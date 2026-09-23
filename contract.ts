/**
 * Parent-facing subagent tool contract.
 *
 * This module owns the wording taught to the parent agent through the tool
 * schema, tool description, and injected system prompt. Keep API semantics here
 * so those surfaces do not drift independently.
 */

import type { AgentConfig } from "./agents.js";

export interface DelegationGuardSummary {
  currentDepth: number;
  maxDepth: number;
  preventCycles: boolean;
  ancestorAgentStack: string[];
}

interface CallFieldContract {
  name: "agent" | "prompt" | "model" | "thinking" | "cwd" | "initialContext" | "session" | "inactivityTimeout" | "timeout" | "worktree" | "landing" | "background";
  required: boolean;
  schemaDescription: string;
  promptDescription: string;
}

export const CALLS_SCHEMA_DESCRIPTION =
  "One or more subagent calls. A single call and multiple parallel calls use the same shape.";

export const CALL_FIELDS: CallFieldContract[] = [
  {
    name: "agent",
    required: true,
    schemaDescription: "Name of an available agent (must match exactly)",
    promptDescription: "exact available agent name",
  },
  {
    name: "prompt",
    required: true,
    schemaDescription: "Prompt sent verbatim to the subagent for this call",
    promptDescription: "non-empty prompt sent verbatim to the subagent",
  },
  {
    name: "model",
    required: false,
    schemaDescription: "Model to use for this call. Overrides the agent file's default model; otherwise the parent session's current model is inherited.",
    promptDescription: "model to use for this call. Overrides the agent file's default model. If omitted, the agent's default model is used when configured; otherwise Pi uses the parent session's current effective model",
  },
  {
    name: "thinking",
    required: false,
    schemaDescription: "Thinking level: off, minimal, low, medium, high, xhigh, max. Precedence: call, agent frontmatter, startup --thinking, child default/session setting.",
    promptDescription: "thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Precedence: call, agent frontmatter, startup `--thinking` fallback, child default/session setting. Applies to continued sessions too; does not inherit the parent's current thinking level",
  },
  {
    name: "cwd",
    required: false,
    schemaDescription: "Working directory for this subagent process",
    promptDescription: "working directory for this subagent process",
  },
  {
    name: "initialContext",
    required: false,
    schemaDescription:
      "Initial context for a newly-created child conversation: 'empty' (default) or 'parent'. Parent cloning is expensive and carries the parent's authority; prefer empty and pass relevant context deliberately. Existing named sessions ignore this field.",
    promptDescription:
      '`"empty"` (default) starts without parent history; `"parent"` exceptionally clones the current parent session snapshot, which is expensive and carries the parent conversation\'s authority. Prefer empty and pass relevant context deliberately. Existing named sessions ignore this field',
  },
  {
    name: "session",
    required: false,
    schemaDescription:
      "Optional logical handle for a persistent subagent session. Scoped by parent session, effective cwd, and agent name. A child session id reported by a failed job resumes that session directly.",
    promptDescription:
      "durable conversation handle. If present, the call continues or creates a persistent child Pi session. The handle is scoped by parent session, effective cwd, and agent name. The same handle used with different agents resolves to different sessions. Requires a persisted parent Pi session. A child session id reported in a previous job result also works and resumes that exact session",
  },
  {
    name: "inactivityTimeout",
    required: false,
    schemaDescription:
      "Optional positive integer inactivity timeout in seconds. Overrides the agent default. Resets only when the child emits RPC stdout activity; omitted uses the agent default, or no inactivity timeout.",
    promptDescription:
      "positive integer inactivity timeout in seconds. Overrides the agent default; otherwise the agent default applies, or there is no inactivity timeout. It resets only on child RPC stdout activity",
  },
  {
    name: "timeout",
    required: false,
    schemaDescription:
      "Optional exceptional positive integer absolute wall-clock deadline in seconds. Independent of inactivityTimeout. Omit for ordinary stuck-run protection.",
    promptDescription:
      "exceptional positive integer absolute wall-clock deadline in seconds, independent of `inactivityTimeout`. Omit it for ordinary stuck-run protection",
  },
  {
    name: "worktree",
    required: false,
    schemaDescription:
      "Run this subagent in an isolated git worktree on a dedicated branch (pi-subagent/<job-id>), so parallel implementation jobs never conflict. Requires a git repository at the call's cwd. The branch is recorded in the job details.",
    promptDescription:
      "run this subagent in an isolated git worktree on a dedicated branch (`pi-subagent/<job-id>`), so parallel implementation jobs never conflict and can be landed independently. Requires a git repository at the call's cwd; the branch is recorded in the job details. Prefer this for implementation tasks that change files",
  },
  {
    name: "landing",
    required: false,
    schemaDescription:
      "What happens to a worktree job when it terminates: 'keep' (default) leaves the branch and worktree for review, 'patch' writes a patch file under <repo>/.pi-subagent-patches/ and removes the worktree, 'pr' pushes the branch, opens a PR via gh, then removes the worktree. Requires worktree: true.",
    promptDescription:
      "landing policy for worktree calls (requires `worktree: true`): `\"keep\"` (default) leaves the branch and worktree for review; `\"patch\"` writes a patch file (diff of the branch against its base) under `<repo>/.pi-subagent-patches/` and removes the worktree; `\"pr\"` pushes the branch, opens a PR via `gh`, then removes the worktree. Branches survive every policy; only the worktree directory is removed",
  },
  {
    name: "background",
    required: false,
    schemaDescription:
      "Run this call in the background. The tool call returns immediately with the job id while the subagent keeps running detached; when the job finishes, a compact result summary is delivered as a new message and the full output is retrievable via the subagent_result tool.",
    promptDescription:
      "run this call in the background. The tool call returns immediately with the job id while the subagent runs detached from the invocation; when the job finishes, a compact capped result summary arrives as a new message and the full output is retrievable via `subagent_result`. Foreground (non-background) calls block the invocation until every call completes",
  },
];

export function getCallFieldSchemaDescription(name: CallFieldContract["name"]): string {
  const field = CALL_FIELDS.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`Unknown subagent call field: ${name}`);
  return field.schemaDescription;
}

function formatCallFieldList(): string {
  return CALL_FIELDS
    .map((field) => {
      const requirement = field.required ? "required" : "optional";
      return `- \`${field.name}\` — ${requirement}: ${field.promptDescription}.`;
    })
    .join("\n");
}

function formatDelegationRules(): string {
  return [
    "- Do not use the same resolved session in more than one concurrent call. Same handle + same agent + same cwd conflicts; same handle + different agent is allowed. If a stale session lock is reported, remove the lock directory only after confirming no subagent is still running.",
    "- Use `session` for multi-turn specialist work; omit it for one-off delegation, when the parent is running with `--no-session`, or from temporary parent-seeded subagent sessions.",
    "- Agent-specific session preference and hint lines are advisory only. The tool creates or continues a persistent session only when a call includes `session`.",
    "- Prefer `initialContext: \"empty\"` and pass relevant task context deliberately. Parent cloning is exceptional because it is expensive and carries the parent conversation's authority.",
    "- Use `worktree: true` for parallel implementation tasks so each job changes files on its own branch; combine it with `landing` to control what survives after the job ends.",
    "- Use `background: true` when the conversation should stay responsive or continue other work while the subagent runs; the call returns immediately with job ids and each result arrives later as a new message. A background job holds its session lock until it finishes.",
    "- Failures are fail-soft: a failed result embeds the partial output, the child session handle, and resume guidance. Resume with one corrective call — same agent, `session` set to the reported handle, and a prompt explaining what went wrong; the subagent continues from where it stopped. Calls without `session` cannot be resumed; rerun them with a corrected prompt.",
  ].join("\n");
}

export function formatSubagentUsageExample(): string {
  return `Use exactly one top-level \`calls\` array:\n\`\`\`json\n{\n  "calls": [\n    {\n      "agent": "agent-name",\n      "prompt": "Prompt sent verbatim to the subagent",\n      "model": "optional-model",\n      "initialContext": "empty",\n      "session": "optional-logical-handle"\n    }\n  ]\n}\n\`\`\``;
}

export function formatSubagentUsageErrorExample(): string {
  return `Use the current API shape:\n{\n  "calls": [\n    { "agent": "agent-name", "prompt": "Prompt sent verbatim to the subagent" }\n  ]\n}`;
}

function formatSessionPreference(preference: AgentConfig["sessionPreference"]): string {
  switch (preference) {
    case "persistent":
      return "Prefer topic-specific named persistent sessions when context should carry across related calls.";
    case "ephemeral":
      return "Prefer ephemeral calls unless the caller explicitly needs continuation.";
    case "either":
      return "Choose ephemeral or persistent sessions based on the task.";
    default:
      return "";
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatAgentForPrompt(agent: AgentConfig): string {
  const lines = [`- **${agent.name}** (${agent.source}): ${agent.description}`];
  if (agent.inactivityTimeout) {
    lines.push(`  Inactivity timeout default: ${agent.inactivityTimeout}s (child RPC stdout inactivity).`);
  }
  if (agent.sessionPreference) {
    lines.push(
      `  Session preference: ${agent.sessionPreference} — ${formatSessionPreference(agent.sessionPreference)}`,
    );
  }
  if (agent.sessionHint) {
    lines.push(`  Session hint: ${oneLine(agent.sessionHint)}`);
  }
  return lines.join("\n");
}

export function formatAvailableSubagentsPrompt(
  agents: AgentConfig[],
  guards: DelegationGuardSummary,
): string {
  const agentList = agents.map((agent) => formatAgentForPrompt(agent)).join("\n");
  const stack = guards.ancestorAgentStack.length > 0
    ? guards.ancestorAgentStack.join(" -> ")
    : "(root)";

  return `\n\n## Available Subagents

The following subagents are available via the \`Agent\` tool:

${agentList}

Agent source labels are informational. Project agents come from this repository and can override user agents with the same name.

### How to call the Agent tool

${formatSubagentUsageExample()}

Each call runs in an isolated \`pi\` process. Multiple calls may run concurrently.

Every call is tracked as a job: tool result details carry the job id, status, child session id and file, and model. Named sessions are durable and resumable; calls without \`session\` are ephemeral and report no child session.
Failed named-session calls embed their partial output, the child session handle, and resume guidance in the result — call the Agent tool again with \`session\` set to that handle and a corrective prompt to continue the subagent from where it stopped. Ephemeral failures state that they cannot be resumed.

Fields:
${formatCallFieldList()}

Rules:
${formatDelegationRules()}

### Steering running subagents

While a subagent job runs, the \`subagent_steer\` tool can redirect it: pass the job id (from the Agent tool result details) or the session handle plus a \`message\`. The message is delivered after the child's current tool call, before its next response — the child course-corrects without a restart. Steering returns as soon as the child acknowledges the queued message; use it when new information changes the work, not to poll for status.

### Companion tools

- \`subagent_status\` lists the jobs tracked in this session as queued, running, done, failed, or stopped, with agent names and elapsed time. The listing is privacy-filtered (no prompts or output); pass a \`job\` id to list one job.
- \`subagent_result\` collects a finished job's full stored output without blocking — including its final status, exit info, and the session handle. A still-running job reports that it is not done yet. Identify jobs by \`job\` id or session \`handle\`.
- \`subagent_stop\` stops a running job gracefully: the child is told to wrap up and report partial progress, gets a bounded grace period, then its process tree is terminated. The job ends \`stopped\` with partial output preserved, and its session lock is released. Already-finished jobs are reported, not errored.
- \`subagent_reply\` answers a child question: subagents get an \`ask_parent\` tool, and a question asked mid-task is relayed into this session as a queued message naming the job. Answer with \`subagent_reply\`, passing that \`job\` id and the \`answer\`; the blocked child continues its task using the answer. An unanswered child gives up after its own wait (default 120s) and proceeds on its own — the timeout is reported back as a queued message.

### Runtime delegation guards

- Max depth: current depth ${guards.currentDepth}, max depth ${guards.maxDepth}
- Cycle prevention: ${guards.preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${stack}
`;
}

export function formatSubagentToolDescription(): string {
  return [
    "Delegate work to specialized subagents running in isolated pi processes.",
    "",
    "Use exactly one top-level `calls` array for both one and many invocations.",
    "Each call requires `agent` and `prompt`; `prompt` is sent verbatim.",
    "",
    "Every call is tracked as a job with a unique id and lifecycle status; details in each tool result carry the job id, status, child session id, child session file, and model.",
    "",
    "Failed calls are fail-soft: their results carry the partial output, the child session handle, and resume guidance. Continue the work with one corrective call using `session` set to the reported handle; the subagent picks up from where it stopped, retaining its earlier context.",
    "",
    "Fields:",
    formatCallFieldList(),
    "",
    "Rules:",
    formatDelegationRules(),
    "",
    "Multiple calls may run concurrently.",
    "Model-facing output is capped at Pi's standard 50KB/2000-line limits; full truncated output is saved to a temporary file for the active session.",
    "",
    'Example: { calls: [{ agent: "review", prompt: "Review this diff", model: "anthropic/claude-sonnet-4", session: "api-review", initialContext: "empty" }] }',
  ].join("\n");
}

/** Schema descriptions for the `subagent_steer` companion tool parameters. */
export const STEER_FIELD_DESCRIPTIONS = {
  job: "Job id of the running subagent to steer, from the Agent tool result details (results[].job.id).",
  handle: "Session handle of the running subagent to steer: the `session` value its Agent call used.",
  message: "Steering message sent to the running child. Delivered after its current tool call, before its next response.",
} as const;

/** Schema descriptions for the `subagent_status` companion tool parameters. */
export const STATUS_FIELD_DESCRIPTIONS = {
  job: "Optional job id: list only that job. Omit to list every job tracked in this session.",
} as const;

/** Schema descriptions for the `subagent_result` companion tool parameters. */
export const RESULT_FIELD_DESCRIPTIONS = {
  job: "Job id of the subagent whose output to collect, from the Agent tool result details (results[].job.id).",
  handle: "Alternative to job: the session handle the subagent's Agent call used; resolves to that handle's most recent job.",
} as const;

/** Schema descriptions for the `subagent_stop` companion tool parameters. */
export const STOP_FIELD_DESCRIPTIONS = {
  job: "Job id of the running subagent to stop, from the Agent tool result details (results[].job.id).",
  handle: "Alternative to job: the session handle the running subagent's Agent call used.",
} as const;

/** Schema descriptions for the `subagent_reply` companion tool parameters. */
export const REPLY_FIELD_DESCRIPTIONS = {
  job: "Job id of the subagent waiting for an answer, from the question message relayed into this session.",
  answer: "The answer to deliver. Sent verbatim to the waiting child, which continues its task using it.",
} as const;

export function formatStatusToolDescription(): string {
  return [
    "List the subagent jobs tracked in this session with their status and elapsed time.",
    "",
    "Each job appears as queued, running, done, failed, or stopped, with its job id, agent name, and elapsed time.",
    "The listing is privacy-filtered: it never includes task prompts or output. Pass `job` to list a single job id.",
    "Use this to see what is in flight; use subagent_result to collect a finished job's full output, or subagent_stop to stop a running job.",
  ].join("\n");
}

export function formatResultToolDescription(): string {
  return [
    "Collect a finished subagent job's full stored output, non-blocking.",
    "",
    "Identify the job with `job` (the job id from the Agent tool result details) or `handle` (the session handle that call used).",
    "A finished job returns its complete stored output with its final status, exit info, and session handle. A still-running job reports that it is not done yet without blocking. An unknown job id is an error.",
  ].join("\n");
}

export function formatStopToolDescription(): string {
  return [
    "Stop a running subagent job gracefully.",
    "",
    "Identify the job with `job` (the job id from the Agent tool result details) or `handle` (the session value that call used).",
    "The child first receives a wrap-up instruction asking it to report partial progress; after a bounded grace period (default 10s, PI_SUBAGENT_STOP_GRACE_MS) the process tree is terminated if it is still running.",
    "The job ends as \"stopped\" with its partial output preserved and retrievable via subagent_result; background jobs deliver their stopped summary as a new message and release their session lock.",
    "Already-finished jobs are reported, not treated as errors. Stopping is idempotent.",
  ].join("\n");
}

export function formatReplyToolDescription(): string {
  return [
    "Answer a subagent that asked a question mid-task through its ask_parent tool.",
    "",
    "The child's question arrives in this session as a queued message naming the job; pass that `job` id and your `answer`.",
    "The waiting child receives the answer verbatim and continues its task using it, so one reply finishes the exchange.",
    "If the child stopped waiting — it timed out and moved on, or its job already ended — the reply reports that no question is waiting instead of delivering anything.",
  ].join("\n");
}

export function formatSteerToolDescription(): string {
  return [
    "Send a steering message to a running subagent without stopping or restarting it.",
    "",
    "Identify the job with `job` (the job id from the Agent tool result details) or `handle` (the `session` value that call used); `message` is the steering text.",
    "The message is queued in the child and delivered after its current tool call completes, before its next response, so the child course-corrects mid-run.",
    "This tool returns as soon as the child acknowledges the queued message; the child processes it asynchronously and is never restarted.",
    "Jobs that are done, failed, or stopped cannot be steered.",
  ].join("\n");
}
