/**
 * Pi Subagent Extension
 *
 * Delegates prompts to specialized subagents, each running as an isolated `pi`
 * process. The tool accepts a single `calls` array for both one and many
 * subagent invocations.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AgentToolResult,
  type ExtensionAPI,
  getAgentDir,
  ProjectTrustStore,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  type AgentConfig,
  MAX_TIMER_SECONDS,
  STARTER_AGENT_NAME,
  discoverAgentsWithStarter,
} from "./agents.js";
import {
  formatBackgroundAck,
  formatBackgroundResultMessage,
  resolveBackgroundOutputLimit,
} from "./background.js";
import {
  CALLS_SCHEMA_DESCRIPTION,
  formatAvailableSubagentsPrompt,
  formatReplyToolDescription,
  formatResultToolDescription,
  formatStatusToolDescription,
  formatSteerToolDescription,
  formatStopToolDescription,
  formatSubagentToolDescription,
  formatSubagentUsageErrorExample,
  getCallFieldSchemaDescription,
  REPLY_FIELD_DESCRIPTIONS,
  RESULT_FIELD_DESCRIPTIONS,
  STATUS_FIELD_DESCRIPTIONS,
  STEER_FIELD_DESCRIPTIONS,
  STOP_FIELD_DESCRIPTIONS,
} from "./contract.js";
import {
  collectJobResult,
  formatStatusListing,
  type StatusDetails,
  type SubagentResultDetails,
} from "./companion.js";
import {
  DELEGATION_CUSTOM_TYPE,
  type DelegationOriginEntry,
} from "./delegation-metadata.js";
import { JobRegistry, type JobRecord, type JobStatus } from "./jobs.js";
import { formatCallsSummary, writeOutputArtifact } from "./output.js";
import { renderCall, renderResult } from "./render.js";
import {
	buildResumeInfo,
	resolveResumedSessionId,
	type ResumableSessionLookup,
} from "./resume.js";
import { parseInheritedCliArgs, selectInheritedPiArgv } from "./runner-cli.js";
import {
  AskParentHub,
  formatAskQuestionMessage,
  formatAskTimeoutMessage,
  formatReplyDeliveredMessage,
  type ReplyDetails,
} from "./questions.js";
import {
  formatStopView,
  resolveStopGraceMs,
  StopHandleRegistry,
  stopJob,
  type StopDetails,
} from "./stop.js";
import {
  SteerChannelRegistry,
  steerJob,
  type SteerDetails,
} from "./steering.js";
import { ensureDefaultSessionDir, getDefaultSessionDirPath } from "./session-paths.js";
import { mapConcurrent, runAgent, type ParentModel } from "./runner.js";
import {
  acquireSessionLocks,
  releaseSessionLocks,
  type SessionLock,
  type SessionLockTarget,
} from "./session-lock.js";
import {
  type CallThinkingLevel,
  type InitialContext,
  CALL_THINKING_LEVELS,
  type SingleResult,
  type SubagentDetails,
  type SubagentSessionDetails,
  DEFAULT_INITIAL_CONTEXT,
  emptyUsage,
  isResultError,
} from "./types.js";
import {
  DEFAULT_LANDING_POLICY,
  type LandingPolicy,
  type WorktreePlan,
  applyWorktreeLanding,
  materializeWorktrees,
  planWorktrees,
  removeWorktree,
} from "./worktrees.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_CALLS = 8;
const MAX_CONCURRENCY = 4;
const CALLS_HEARTBEAT_MS = 1000;
const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TEMP_PARENT_SESSION_ENV = "PI_SUBAGENT_TEMP_PARENT_SESSION";
const SESSION_ID_NAMESPACE = "pi-subagent/v1";
const SESSION_ID_PREFIX = "subagent.";
const SESSION_HANDLE_MAX_LENGTH = 120;
const inheritedPiArgv = selectInheritedPiArgv(process.argv, process.env);

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const CallItem = Type.Object({
  agent: Type.String({
    description: getCallFieldSchemaDescription("agent"),
    minLength: 1,
  }),
  prompt: Type.String({
    description: getCallFieldSchemaDescription("prompt"),
    minLength: 1,
  }),
  model: Type.Optional(
    Type.String({
      description: getCallFieldSchemaDescription("model"),
      minLength: 1,
    }),
  ),
  thinking: Type.Optional(
    StringEnum(CALL_THINKING_LEVELS, {
      description: getCallFieldSchemaDescription("thinking"),
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: getCallFieldSchemaDescription("cwd"),
      minLength: 1,
    }),
  ),
  initialContext: Type.Optional(
    StringEnum(["empty", "parent"] as const, {
      description: getCallFieldSchemaDescription("initialContext"),
      default: DEFAULT_INITIAL_CONTEXT,
    }),
  ),
  session: Type.Optional(
    Type.String({
      description: getCallFieldSchemaDescription("session"),
      minLength: 1,
      maxLength: SESSION_HANDLE_MAX_LENGTH,
    }),
  ),
  inactivityTimeout: Type.Optional(
    Type.Integer({
      description: getCallFieldSchemaDescription("inactivityTimeout"),
      minimum: 1,
      maximum: MAX_TIMER_SECONDS,
    }),
  ),
  timeout: Type.Optional(
    Type.Integer({
      description: getCallFieldSchemaDescription("timeout"),
      minimum: 1,
      maximum: MAX_TIMER_SECONDS,
    }),
  ),
  worktree: Type.Optional(
    Type.Boolean({
      description: getCallFieldSchemaDescription("worktree"),
    }),
  ),
  landing: Type.Optional(
    StringEnum(["keep", "patch", "pr"] as const, {
      description: getCallFieldSchemaDescription("landing"),
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: getCallFieldSchemaDescription("background"),
    }),
  ),
});

const SubagentParams = Type.Object({
  calls: Type.Array(CallItem, {
    description: CALLS_SCHEMA_DESCRIPTION,
    minItems: 1,
    maxItems: MAX_CALLS,
  }),
});

// The steer companion tool is an ordinary tool (not a spawn tool): clients
// that bind subagent UI to the Agent naming convention must not treat a
// steering call as a new subagent.
const SteerParams = Type.Object({
  job: Type.Optional(
    Type.String({
      description: STEER_FIELD_DESCRIPTIONS.job,
      minLength: 1,
    }),
  ),
  handle: Type.Optional(
    Type.String({
      description: STEER_FIELD_DESCRIPTIONS.handle,
      minLength: 1,
      maxLength: SESSION_HANDLE_MAX_LENGTH,
    }),
  ),
  message: Type.String({
    description: STEER_FIELD_DESCRIPTIONS.message,
    minLength: 1,
  }),
});

// The status, result, and stop companion tools are ordinary tools too: they
// observe and manage tracked jobs and must not spawn subagent UI chips.
const StatusParams = Type.Object({
  job: Type.Optional(
    Type.String({
      description: STATUS_FIELD_DESCRIPTIONS.job,
      minLength: 1,
    }),
  ),
});

const ResultParams = Type.Object({
  job: Type.Optional(
    Type.String({
      description: RESULT_FIELD_DESCRIPTIONS.job,
      minLength: 1,
    }),
  ),
  handle: Type.Optional(
    Type.String({
      description: RESULT_FIELD_DESCRIPTIONS.handle,
      minLength: 1,
      maxLength: SESSION_HANDLE_MAX_LENGTH,
    }),
  ),
});

const StopParams = Type.Object({
  job: Type.Optional(
    Type.String({
      description: STOP_FIELD_DESCRIPTIONS.job,
      minLength: 1,
    }),
  ),
  handle: Type.Optional(
    Type.String({
      description: STOP_FIELD_DESCRIPTIONS.handle,
      minLength: 1,
      maxLength: SESSION_HANDLE_MAX_LENGTH,
    }),
  ),
});

// The reply companion tool targets the job named in a relayed child question;
// handles do not identify a pending question, so the id is required.
const ReplyParams = Type.Object({
  job: Type.String({
    description: REPLY_FIELD_DESCRIPTIONS.job,
    minLength: 1,
  }),
  answer: Type.String({
    description: REPLY_FIELD_DESCRIPTIONS.answer,
    minLength: 1,
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DelegationDepthConfig {
  currentDepth: number;
  maxDepth: number;
  canDelegate: boolean;
  ancestorAgentStack: string[];
  preventCycles: boolean;
}

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

interface NormalizedCall {
  index: number;
  agent: string;
  prompt: string;
  model?: string;
  thinking?: CallThinkingLevel;
  effectiveCwd: string;
  initialContext: InitialContext;
  sessionHandle?: string;
  session?: SubagentSessionDetails;
  inactivityTimeoutMs?: number;
  timeoutMs?: number;
  worktree?: boolean;
  landing?: LandingPolicy;
  /** Run detached from the tool invocation; results arrive as queued messages. */
  background?: boolean;
}

interface NormalizedCallsResult {
  calls?: NormalizedCall[];
  error?: string;
}

interface ExtensionExecutionContext {
  cwd: string;
  sessionManager: SessionSnapshotSource & {
    getSessionId: () => string;
    getSessionDir: () => string;
    getSessionFile: () => string | undefined;
  };
}

/**
 * A detached background job and everything it owns for its lifetime. The
 * tool invocation returns immediately after starting the child; the start
 * record travels with the job until it finishes, carrying the session lock
 * and reserved session id that must be released on completion instead of
 * when the tool call returns.
 */
interface BackgroundJobStart {
  call: NormalizedCall;
  job: JobRecord;
  lock?: SessionLock;
  /** Worktree plan for background worktree jobs; landing applies when the detached child terminates. */
  worktreePlan?: WorktreePlan;
  parentSessionId: string;
  parentSessionSnapshotJsonl?: string;
  persistentSessionDir?: string;
  parentModel?: ParentModel;
  agents: AgentConfig[];
  defaultCwd: string;
  makeDetails: ReturnType<typeof makeDetailsFactory>;
}

function parseInitialContext(raw: unknown): InitialContext | null {
  if (raw === undefined) return DEFAULT_INITIAL_CONTEXT;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (normalized === "empty" || normalized === "parent") return normalized;
  return null;
}

function parseOptionalTimeoutMs(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > MAX_TIMER_SECONDS
  ) return null;
  return raw * 1000;
}

function buildParentSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseAgentStack(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((value) => typeof value === "string")) return null;
  return parsed
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-max-depth") {
      return argv[i + 1] ?? "";
    }
    if (arg.startsWith("--subagent-max-depth=")) {
      return arg.slice("--subagent-max-depth=".length);
    }
  }
  return null;
}

export function getProjectTrustOverrideFromArgv(argv: string[]): boolean | null {
  return parseInheritedCliArgs(argv).projectTrustOverride ?? null;
}

function shouldIncludeProjectAgents(cwd: string, contextTrusted: boolean): boolean {
  if (!contextTrusted) return false;

  const trustOverride = getProjectTrustOverrideFromArgv(inheritedPiArgv);
  if (trustOverride !== null) return trustOverride;

  try {
    return new ProjectTrustStore(getAgentDir()).get(cwd) === true;
  } catch (error) {
    console.warn(`[pi-subagent] Could not verify project trust; project agents are disabled: ${String(error)}`);
    return false;
  }
}

function getPreventCyclesFlagFromArgv(
  argv: string[],
): string | boolean | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-prevent-cycles") {
      const maybeValue = argv[i + 1];
      if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
        return maybeValue;
      }
      return true;
    }
    if (arg === "--no-subagent-prevent-cycles") return false;
    if (arg.startsWith("--subagent-prevent-cycles=")) {
      return arg.slice("--subagent-prevent-cycles=".length);
    }
  }
  return null;
}

function resolveDelegationDepthConfig(pi: ExtensionAPI): DelegationDepthConfig {
  const depthRaw = process.env[SUBAGENT_DEPTH_ENV];
  const parsedDepth = parseNonNegativeInt(depthRaw);
  if (depthRaw !== undefined && parsedDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
    );
  }
  const currentDepth = parsedDepth ?? 0;

  const stackRaw = process.env[SUBAGENT_STACK_ENV];
  const ancestorAgentStack = parseAgentStack(stackRaw);
  if (stackRaw !== undefined && ancestorAgentStack === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_STACK_ENV} value. Expected a JSON array of agent names.`,
    );
  }

  const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
  if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
    );
  }

  const argvFlagRaw = getMaxDepthFlagFromArgv(inheritedPiArgv);
  const argvFlagMaxDepth =
    argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
  if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
    );
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth =
    typeof runtimeFlagValue === "string"
      ? parseNonNegativeInt(runtimeFlagValue)
      : null;
  if (
    argvFlagRaw === null &&
    typeof runtimeFlagValue === "string" &&
    runtimeFlagMaxDepth === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
    );
  }

  const envPreventCyclesRaw = process.env[SUBAGENT_PREVENT_CYCLES_ENV];
  const envPreventCycles = parseBoolean(envPreventCyclesRaw);
  if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(inheritedPiArgv);
  const argvPreventCycles =
    typeof argvPreventCyclesRaw === "boolean"
      ? argvPreventCyclesRaw
      : parseBoolean(argvPreventCyclesRaw);
  if (
    typeof argvPreventCyclesRaw === "string" &&
    argvPreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (
    argvPreventCyclesRaw === null &&
    runtimePreventCyclesRaw !== undefined &&
    runtimePreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
    );
  }

  const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
  const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    argvPreventCycles ??
    runtimePreventCycles ??
    envPreventCycles ??
    DEFAULT_PREVENT_CYCLE_DELEGATION;

  return {
    currentDepth,
    maxDepth,
    canDelegate: currentDepth < maxDepth,
    ancestorAgentStack: ancestorAgentStack ?? [],
    preventCycles,
  };
}

function makeDetailsFactory(projectAgentsDir: string | null) {
  return (results: SingleResult[], failed = false): SubagentDetails => ({
    kind: "pi-subagent",
    projectAgentsDir,
    results,
    ...(failed ? { failed: true as const } : {}),
  });
}

export function resolveCallCwd(defaultCwd: string, rawCwd?: string): string {
  return fs.realpathSync(path.resolve(defaultCwd, rawCwd ?? "."));
}

export function normalizeCalls(rawCalls: unknown, defaultCwd: string): NormalizedCallsResult {
  if (!Array.isArray(rawCalls)) {
    return { error: `Invalid subagent parameters: missing calls array.\n${formatSubagentUsageErrorExample()}` };
  }
  if (rawCalls.length === 0) {
    return { error: `Invalid subagent parameters: calls must contain at least one call.\n${formatSubagentUsageErrorExample()}` };
  }
  if (rawCalls.length > MAX_CALLS) {
    return { error: `Too many subagent calls (${rawCalls.length}). Max is ${MAX_CALLS}.` };
  }

  const calls: NormalizedCall[] = [];
  for (let index = 0; index < rawCalls.length; index++) {
    const raw = rawCalls[index];
    if (!raw || typeof raw !== "object") {
      return { error: `calls[${index}] must be an object.` };
    }
    const call = raw as Record<string, unknown>;

    if (typeof call.agent !== "string" || call.agent.trim().length === 0) {
      return { error: `calls[${index}].agent must be a non-empty string.` };
    }
    const agent = call.agent.trim();

    if (typeof call.prompt !== "string" || call.prompt.trim().length === 0) {
      return { error: `calls[${index}].prompt must be a non-empty string.` };
    }
    const prompt = call.prompt;

    let model: string | undefined;
    if (call.model !== undefined) {
      if (typeof call.model !== "string") {
        return { error: `calls[${index}].model must be a string when provided.` };
      }
      model = call.model.trim();
      if (!model) {
        return { error: `calls[${index}].model must not be empty when provided.` };
      }
    }

    let thinking: CallThinkingLevel | undefined;
    if (call.thinking !== undefined) {
      if (typeof call.thinking !== "string" || !CALL_THINKING_LEVELS.includes(call.thinking as CallThinkingLevel)) {
        return { error: `calls[${index}].thinking must be one of: ${CALL_THINKING_LEVELS.join(", ")}.` };
      }
      thinking = call.thinking as CallThinkingLevel;
    }

    const initialContext = parseInitialContext(call.initialContext);
    if (!initialContext) {
      return { error: `calls[${index}].initialContext must be "empty" or "parent".` };
    }

    const inactivityTimeoutMs = parseOptionalTimeoutMs(call.inactivityTimeout);
    if (inactivityTimeoutMs === null) {
      return {
        error: `calls[${index}].inactivityTimeout must be an integer between 1 and ${MAX_TIMER_SECONDS} seconds when provided.`,
      };
    }

    const timeoutMs = parseOptionalTimeoutMs(call.timeout);
    if (timeoutMs === null) {
      return {
        error: `calls[${index}].timeout must be an integer between 1 and ${MAX_TIMER_SECONDS} seconds when provided.`,
      };
    }

    let background: boolean | undefined;
    if (call.background !== undefined) {
      if (typeof call.background !== "boolean") {
        return { error: `calls[${index}].background must be a boolean when provided.` };
      }
      background = call.background;
    }

    let effectiveCwd: string;
    if (call.cwd !== undefined) {
      if (typeof call.cwd !== "string" || call.cwd.trim().length === 0) {
        return { error: `calls[${index}].cwd must be a non-empty string when provided.` };
      }
      effectiveCwd = path.resolve(defaultCwd, call.cwd);
      try {
        if (!fs.statSync(effectiveCwd).isDirectory()) {
          return { error: `calls[${index}].cwd is not a directory: ${effectiveCwd}` };
        }
        effectiveCwd = resolveCallCwd(defaultCwd, call.cwd);
      } catch {
        return { error: `calls[${index}].cwd does not exist or is not accessible: ${effectiveCwd}` };
      }
    } else {
      try {
        effectiveCwd = resolveCallCwd(defaultCwd);
      } catch {
        return { error: `Parent cwd does not exist or is not accessible: ${path.resolve(defaultCwd)}` };
      }
    }

    let sessionHandle: string | undefined;
    if (call.session !== undefined) {
      if (typeof call.session !== "string") {
        return { error: `calls[${index}].session must be a string when provided.` };
      }
      sessionHandle = call.session.trim();
      if (!sessionHandle) {
        return { error: `calls[${index}].session must not be empty when provided.` };
      }
      if (sessionHandle.length > SESSION_HANDLE_MAX_LENGTH) {
        return {
          error: `calls[${index}].session must be at most ${SESSION_HANDLE_MAX_LENGTH} characters.`,
        };
      }
    }

    let worktree: boolean | undefined;
    if (call.worktree !== undefined) {
      if (typeof call.worktree !== "boolean") {
        return { error: `calls[${index}].worktree must be a boolean when provided.` };
      }
      worktree = call.worktree;
    }

    let landing: LandingPolicy | undefined;
    if (call.landing !== undefined) {
      if (call.landing !== "keep" && call.landing !== "patch" && call.landing !== "pr") {
        return { error: `calls[${index}].landing must be one of: keep, patch, pr.` };
      }
      if (!worktree) {
        return { error: `calls[${index}].landing requires worktree: true.` };
      }
      landing = call.landing;
    }
    if (worktree && !landing) landing = DEFAULT_LANDING_POLICY;

    calls.push({
      index,
      agent,
      prompt,
      model,
      thinking,
      effectiveCwd,
      initialContext,
      sessionHandle,
      inactivityTimeoutMs,
      timeoutMs,
      worktree,
      landing,
      background,
    });
  }

  return { calls };
}

function stableSessionSeed(values: unknown[]): string {
  return JSON.stringify(values);
}

function deriveSessionId(
  parentSessionId: string,
  effectiveCwd: string,
  agentName: string,
  sessionHandle: string,
): string {
  const digest = createHash("sha256")
    .update(stableSessionSeed([
      SESSION_ID_NAMESPACE,
      parentSessionId,
      effectiveCwd,
      agentName,
      sessionHandle,
    ]))
    .digest("hex")
    .slice(0, 16);
  return `${SESSION_ID_PREFIX}${digest}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatSessionDisplayName(agentName: string, sessionHandle: string): string {
  return `subagent: ${agentName} · ${oneLine(sessionHandle)}`;
}

function attachSessionIdentities(
  calls: NormalizedCall[],
  parentSessionId: string,
  resumeLookup: ResumableSessionLookup,
): void {
  for (const call of calls) {
    if (!call.sessionHandle) continue;
    // A raw child session id (as reported by a failed job) resumes that exact
    // session; every other handle derives its scoped id as before. Resolution
    // uses the call's own effective cwd — the scope the failed job's session
    // lives in — never the parent's cwd.
    const resumedId = resolveResumedSessionId(
      call.sessionHandle,
      resumeLookup,
      call.effectiveCwd,
    );
    const id = resumedId ?? deriveSessionId(
      parentSessionId,
      call.effectiveCwd,
      call.agent,
      call.sessionHandle,
    );
    call.session = {
      handle: call.sessionHandle,
      id,
      name: formatSessionDisplayName(call.agent, call.sessionHandle),
      cwd: call.effectiveCwd,
      created: false,
      initialContextApplied: null,
    };
  }
}

function getDuplicateSessionError(calls: NormalizedCall[]): string | null {
  const firstById = new Map<string, NormalizedCall>();
  for (const call of calls) {
    if (!call.session) continue;
    const first = firstById.get(call.session.id);
    if (first) {
      return `Invalid subagent calls: calls[${first.index}] and calls[${call.index}] resolve to the same persistent session (${call.session.id}).\nA persistent subagent session can only be used by one call at a time. Use different session handles or combine the prompts.`;
    }
    firstById.set(call.session.id, call);
  }
  return null;
}

function getActiveSessionError(
  calls: NormalizedCall[],
  activeSessionIds: Set<string>,
): string | null {
  for (const call of calls) {
    if (call.session && activeSessionIds.has(call.session.id)) {
      return `Invalid subagent calls: calls[${call.index}] uses persistent session ${call.session.id}, which is already running in another subagent call. Retry after that call finishes.`;
    }
  }
  return null;
}

/**
 * Resolve whether each named session exists and record existing session
 * files, so jobs can carry the child session file path from spawn time.
 */
async function resolveSessionCreationState(
  calls: NormalizedCall[],
  sessionDir: string | undefined,
): Promise<Map<string, string>> {
  const sessionsByListKey = new Map<string, Map<string, string>>();

  for (const call of calls) {
    if (!call.session) continue;
    const key = `${sessionDir ?? ""}\0${call.effectiveCwd}`;
    let byId = sessionsByListKey.get(key);
    if (!byId) {
      const sessions = await SessionManager.list(call.effectiveCwd, sessionDir);
      byId = new Map(sessions.map((session) => [session.id, session.path]));
      sessionsByListKey.set(key, byId);
    }

    const existingFile = byId.get(call.session.id);
    call.session.created = existingFile === undefined;
    call.session.initialContextApplied = existingFile ? null : call.initialContext;
  }

  const existingSessionFiles = new Map<string, string>();
  for (const byId of sessionsByListKey.values()) {
    for (const [id, file] of byId) existingSessionFiles.set(id, file);
  }
  return existingSessionFiles;
}

function needsParentSnapshot(calls: NormalizedCall[]): boolean {
  return calls.some(
    (call) => call.initialContext === "parent" && (!call.session || call.session.created),
  );
}

function getPersistentSessionDir(ctx: ExtensionExecutionContext): string | undefined {
  const manager = ctx.sessionManager as unknown as {
    usesDefaultSessionDir?: () => boolean;
  };

  if (typeof manager.usesDefaultSessionDir === "function") {
    return manager.usesDefaultSessionDir() ? undefined : ctx.sessionManager.getSessionDir();
  }

  try {
    const current = path.resolve(ctx.sessionManager.getSessionDir());
    const defaultDir = path.resolve(getDefaultSessionDirPath(ctx.cwd));
    return current === defaultDir ? undefined : ctx.sessionManager.getSessionDir();
  } catch {
    return undefined;
  }
}

function getNamedSessionParentError(
  calls: NormalizedCall[],
  ctx: ExtensionExecutionContext,
): string | null {
  if (!calls.some((call) => call.session)) return null;
  if (parseBoolean(process.env[SUBAGENT_TEMP_PARENT_SESSION_ENV]) === true) {
    return "Named subagent sessions are not available from temporary parent-seeded subagent sessions. Omit `session` or use a named parent subagent session first.";
  }
  if (ctx.sessionManager.getSessionFile()) return null;
  return "Named subagent sessions require a persisted parent Pi session. Omit `session` for ephemeral delegation, or run the parent without --no-session.";
}

function sessionBaseDir(call: NormalizedCall, sessionDir: string | undefined): string {
  return sessionDir ?? ensureDefaultSessionDir(call.effectiveCwd);
}

function getSessionLockTargets(
  calls: NormalizedCall[],
  sessionDir: string | undefined,
): SessionLockTarget[] {
  return calls
    .filter((call) => call.session)
    .map((call) => ({
      sessionId: call.session!.id,
      lockRoot: path.join(sessionBaseDir(call, sessionDir), ".pi-subagent-locks"),
      agent: call.agent,
      handle: call.session!.handle,
      cwd: call.effectiveCwd,
    }));
}

function getCycleViolations(
  requestedNames: Set<string>,
  ancestorAgentStack: string[],
): string[] {
  if (requestedNames.size === 0 || ancestorAgentStack.length === 0) return [];
  const stackSet = new Set(ancestorAgentStack);
  return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

function makePlaceholderResult(call: NormalizedCall, job?: JobRecord): SingleResult {
  return {
    callIndex: call.index,
    agent: call.agent,
    agentSource: "unknown",
    prompt: call.prompt,
    initialContext: call.initialContext,
    session: call.session,
    job,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: call.model,
  };
}

/** Terminal job status for a completed call: aborts stop, errors fail. */
function terminalJobStatus(result: SingleResult): JobStatus {
  if (result.stopReason === "aborted" || result.exitCode === 130) return "stopped";
  return isResultError(result) ? "failed" : "done";
}

/** Best-effort lookup of a child session file by session id. */
function findChildSessionFile(
  cwd: string,
  sessionId: string,
  sessionDir: string | undefined,
): string | undefined {
  try {
    return SessionManager.findById(cwd, sessionId, sessionDir);
  } catch {
    return undefined;
  }
}

/** Model configured for a job: call, then agent file, then the parent model. */
function resolveJobModel(
  call: NormalizedCall,
  agents: AgentConfig[],
  parentModel: ParentModel | undefined,
): string | null {
  const agentModel = agents.find((agent) => agent.name === call.agent)?.model;
  const configured = call.model ?? agentModel;
  if (configured) return configured;
  return parentModel ? `${parentModel.provider}/${parentModel.id}` : null;
}

/**
 * Fail-soft resume: attach partial-output, handle, and guidance info to a
 * failed result so the main agent's natural next move is one corrective call.
 * Ephemeral failures state explicitly that they cannot be resumed.
 */
function attachFailureResume(result: SingleResult): void {
  if (!isResultError(result)) return;
  result.resume = buildResumeInfo({
    agent: result.agent,
    handle: result.session?.id ?? result.job?.childSessionId ?? null,
    persisted: Boolean(result.job?.childSessionFile),
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });
  pi.registerFlag("no-subagent-prevent-cycles", {
    description: "Disable subagent delegation cycle prevention.",
    type: "boolean",
  });

  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;
  const activeSessionIds = new Set<string>();
  const outputArtifactDirs = new Set<string>();
  const jobRegistry = new JobRegistry();
  // Materialized worktrees whose jobs have not terminated yet. Landing
  // removes plans as jobs end; shutdown sweeps what is left best-effort.
  const pendingWorktrees = new Set<WorktreePlan>();
  const backgroundOutputLimit = resolveBackgroundOutputLimit();
  const steerChannels = new SteerChannelRegistry();
  const stopHandles = new StopHandleRegistry();
  const stopGraceMs = resolveStopGraceMs();

  /**
   * Completion promise per tracked job, settled once the job's result is
   * stored and its terminal status is recorded. `subagent_stop` awaits these
   * so a stop call reports the job's actual final state instead of racing the
   * detached completion paths (background delivery, session-lock release).
   */
  const jobCompletions = new Map<string, Promise<SingleResult | undefined>>();
  const jobCompletionSettlers = new Map<string, (result: SingleResult | undefined) => void>();

  const trackJobCompletion = (jobId: string): void => {
    if (jobCompletions.has(jobId)) return;
    let settle!: (result: SingleResult | undefined) => void;
    const completion = new Promise<SingleResult | undefined>((resolve) => {
      settle = resolve;
    });
    jobCompletions.set(jobId, completion);
    jobCompletionSettlers.set(jobId, settle);
  };

  const settleJobCompletion = (jobId: string, result: SingleResult | undefined): void => {
    const settle = jobCompletionSettlers.get(jobId);
    if (!settle) return;
    jobCompletionSettlers.delete(jobId);
    jobCompletions.delete(jobId);
    settle(result);
  };

  /**
   * Relay one child question or timeout notice into the parent session as a
   * queued user message with follow-up delivery, the same mechanism as
   * background result summaries. Best-effort: a session that cannot accept
   * queued messages still keeps the job running.
   */
  const deliverAskMessage = (message: string): void => {
    if (typeof pi.sendUserMessage !== "function") return;
    try {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch (error) {
      console.warn(
        `[pi-subagent] Could not deliver a subagent question message: ${String(error)}`,
      );
    }
  };

  /**
   * Parent-side relay for child questions: one hub watches every spawned
   * child's ask directory for the lifetime of its job and relays questions
   * (and timeout notices) into this session; `subagent_reply` answers through
   * the same hub.
   */
  const askParentHub = new AskParentHub({
    onQuestion: ({ job, question }) =>
      deliverAskMessage(formatAskQuestionMessage(job, question)),
    onTimeout: (event) => deliverAskMessage(formatAskTimeoutMessage(event.job, event)),
  });

  const saveFullOutput = (content: string): string | null => {
    try {
      const artifact = writeOutputArtifact(content);
      outputArtifactDirs.add(artifact.dir);
      return artifact.filePath;
    } catch (error) {
      console.warn(`[pi-subagent] Could not save truncated output: ${String(error)}`);
      return null;
    }
  };

  /**
   * Record job identity in the parent session JSONL as delegation-origin
   * entries. Only named sessions have durable origins; ephemeral calls are
   * tracked in the in-memory registry and tool result details only. Entries
   * are append-only and fail-soft: a session that cannot record them still
   * completes normally.
   */
  const appendDelegationOriginEntry = (
    call: NormalizedCall,
    job: JobRecord,
    parentSessionId: string,
  ): void => {
    if (!call.session) return;
    if (typeof pi.appendEntry !== "function") return;
    const data: DelegationOriginEntry = {
      version: 1,
      childSessionId: call.session.id,
      parentSessionId,
      agent: call.agent,
      handle: call.session.handle,
      jobId: job.id,
      status: job.status,
    };
    try {
      pi.appendEntry(DELEGATION_CUSTOM_TYPE, data);
    } catch (error) {
      console.warn(`[pi-subagent] Could not record delegation origin entry: ${String(error)}`);
    }
  };

  pi.on("session_shutdown", async () => {
    for (const dir of outputArtifactDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS temp directory remains the fallback lifecycle.
      }
    }
    outputArtifactDirs.clear();

    // Best-effort removal of worktrees whose landing policy removes them but
    // whose jobs never terminated (for example, the session ended mid-run).
    // Branches survive every policy; a locked directory (a child still holds
    // it as its cwd on Windows) is left to the OS temp lifecycle.
    const sweep = Array.from(pendingWorktrees);
    pendingWorktrees.clear();
    for (const plan of sweep) {
      if (plan.landing === "keep") continue;
      try {
        await removeWorktree(plan);
      } catch (error) {
        console.warn(`[pi-subagent] Could not remove worktree ${plan.path} during shutdown: ${String(error)}`);
      }
    }
  });

  let discoveredAgents: AgentConfig[] = [];

  // Auto-discover agents on session start.
  pi.on("session_start", async (_event, ctx) => {
    if (!canDelegate) return;

    const starterDiscovery = discoverAgentsWithStarter(
      ctx.cwd,
      shouldIncludeProjectAgents(ctx.cwd, ctx.isProjectTrusted()),
    );
    const discovery = starterDiscovery.discovery;
    discoveredAgents = discovery.agents;

    if (ctx.hasUI) {
      if (starterDiscovery.createdAgentPath) {
        ctx.ui.notify(
          `Created starter subagent "${STARTER_AGENT_NAME}" at:\n${starterDiscovery.createdAgentPath}\n\nEdit this file or add more agents in the same directory to customize delegation.`,
          "info",
        );
      } else if (starterDiscovery.error && discoveredAgents.length === 0) {
        ctx.ui.notify(
          `No subagents found. ${starterDiscovery.error}`,
          "info",
        );
      } else if (discoveredAgents.length > 0) {
        const list = discoveredAgents
          .map((a) => `  - ${a.name} (${a.source})`)
          .join("\n");
        ctx.ui.notify(
          `Found ${discoveredAgents.length} subagent(s):\n${list}`,
          "info",
        );
      }
    }
  });

  // Inject available agents into the system prompt.
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    return {
      systemPrompt:
        event.systemPrompt +
        formatAvailableSubagentsPrompt(discoveredAgents, {
          currentDepth,
          maxDepth,
          preventCycles,
          ancestorAgentStack,
        }),
    };
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "Agent") {
      const details = event.details as Partial<SubagentDetails> | undefined;
      if (details?.kind === "pi-subagent" && details.failed === true) {
        return { isError: true };
      }
      return;
    }
    if (event.toolName === "subagent_steer") {
      const details = event.details as Partial<SteerDetails> | undefined;
      if (details?.kind === "pi-subagent-steer" && details.failed === true) {
        return { isError: true };
      }
    }
    if (event.toolName === "subagent_status") {
      const details = event.details as Partial<StatusDetails> | undefined;
      if (details?.kind === "pi-subagent-status" && details.failed === true) {
        return { isError: true };
      }
    }
    if (event.toolName === "subagent_result") {
      const details = event.details as Partial<SubagentResultDetails> | undefined;
      if (details?.kind === "pi-subagent-result" && details.failed === true) {
        return { isError: true };
      }
    }
    if (event.toolName === "subagent_stop") {
      const details = event.details as Partial<StopDetails> | undefined;
      if (details?.kind === "pi-subagent-stop" && details.failed === true) {
        return { isError: true };
      }
    }
    if (event.toolName === "subagent_reply") {
      const details = event.details as Partial<ReplyDetails> | undefined;
      if (details?.kind === "pi-subagent-reply" && details.failed === true) {
        return { isError: true };
      }
    }
  });

  // Register the Agent tool. The name follows the Claude Code convention so
  // subagent-aware clients (roboco in particular) bind their UI to it.
  if (canDelegate) {
    pi.registerTool({
      name: "Agent",
      label: "Agent",
      description: formatSubagentToolDescription(),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const parentModel: ParentModel | undefined = ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : undefined;
        const starterDiscovery = discoverAgentsWithStarter(
          ctx.cwd,
          shouldIncludeProjectAgents(ctx.cwd, ctx.isProjectTrusted()),
        );
        const discovery = starterDiscovery.discovery;
        const { agents } = discovery;
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir);

        const normalized = normalizeCalls(params.calls, ctx.cwd);
        if (normalized.error || !normalized.calls) {
          return {
            content: [{ type: "text", text: normalized.error ?? "Invalid subagent parameters." }],
            details: makeDetails([], true),
          };
        }
        const calls = normalized.calls;

        const parentSessionId = ctx.sessionManager.getSessionId();
        // Plan worktree runs before session identities are derived: the
        // worktree path becomes the call's effective working directory
        // everywhere (child process cwd, session identity, locks, job
        // record). Planning is read-only; worktrees are materialized only
        // after every guard passes. The job id is reserved here so the
        // branch and directory can be named after it.
        let worktreePlans: WorktreePlan[] = [];
        const worktreeInputs = calls
          .filter((call) => call.worktree)
          .map((call) => ({
            callIndex: call.index,
            jobId: jobRegistry.reserveJobId(),
            cwd: call.effectiveCwd,
            landing: call.landing ?? DEFAULT_LANDING_POLICY,
          }));
        if (worktreeInputs.length > 0) {
          const planned = await planWorktrees(worktreeInputs);
          if (planned.error || !planned.plans) {
            return {
              content: [{ type: "text", text: planned.error ?? "Failed to plan subagent worktrees." }],
              details: makeDetails([], true),
            };
          }
          worktreePlans = planned.plans;
          for (const plan of worktreePlans) {
            const call = calls.find((candidate) => candidate.index === plan.callIndex);
            if (call) call.effectiveCwd = plan.path;
          }
        }

        // Session-scope resolution runs before handle derivation so raw child
        // session ids (failed-job resume handles) resolve to their session.
        const persistentSessionDir = getPersistentSessionDir(ctx as ExtensionExecutionContext);
        attachSessionIdentities(calls, parentSessionId, {
          jobs: jobRegistry.list(),
          findSessionFile: (cwd, sessionId) =>
            findChildSessionFile(cwd, sessionId, persistentSessionDir),
        });

        const duplicateSessionError = getDuplicateSessionError(calls);
        if (duplicateSessionError) {
          return {
            content: [{ type: "text", text: duplicateSessionError }],
            details: makeDetails([], true),
          };
        }

        const parentSessionError = getNamedSessionParentError(
          calls,
          ctx as ExtensionExecutionContext,
        );
        if (parentSessionError) {
          return {
            content: [{ type: "text", text: parentSessionError }],
            details: makeDetails([], true),
          };
        }

        const requested = new Set(calls.map((call) => call.agent));

        if (preventCycles) {
          const cycleViolations = getCycleViolations(
            requested,
            ancestorAgentStack,
          );
          if (cycleViolations.length > 0) {
            const stackText =
              ancestorAgentStack.length > 0
                ? ancestorAgentStack.join(" -> ")
                : "(root)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
                },
              ],
              details: makeDetails([], true),
            };
          }
        }

        const activeSessionError = getActiveSessionError(calls, activeSessionIds);
        if (activeSessionError) {
          return {
            content: [{ type: "text", text: activeSessionError }],
            details: makeDetails([], true),
          };
        }

        const lockResult = acquireSessionLocks(
          getSessionLockTargets(calls, persistentSessionDir),
        );
        if (lockResult.error) {
          return {
            content: [{ type: "text", text: lockResult.error }],
            details: makeDetails([], true),
          };
        }
        // Locks align with the calls that carry sessions; batch validation
        // guarantees the session ids are unique within this invocation.
        const locksBySessionId = new Map(
          lockResult.locks.map((lock) => [lock.sessionId, lock]),
        );

        const reservedSessionIds = calls
          .map((call) => call.session?.id)
          .filter((id): id is string => Boolean(id));
        for (const id of reservedSessionIds) activeSessionIds.add(id);

        // Background jobs outlive this tool call. Each takes ownership of its
        // session lock and reserved session id, releasing them when the job
        // finishes instead of when the invocation returns.
        const backgroundStarts: BackgroundJobStart[] = [];

        try {
          let existingSessionFiles: Map<string, string>;
          try {
            existingSessionFiles = await resolveSessionCreationState(calls, persistentSessionDir);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to inspect existing subagent sessions: ${message}`,
                },
              ],
              details: makeDetails([], true),
            };
          }

          let parentSessionSnapshotJsonl: string | undefined;
          if (needsParentSnapshot(calls)) {
            const snapshot = buildParentSessionSnapshotJsonl(ctx.sessionManager);
            if (!snapshot) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Cannot run subagent calls: failed to snapshot current parent session context for calls requiring initialContext=\"parent\".",
                  },
                ],
                details: makeDetails([], true),
              };
            }
            parentSessionSnapshotJsonl = snapshot;
          }

          // Materialize worktrees after every guard has passed. On failure
          // the partial state is rolled back and no job has been registered.
          if (worktreePlans.length > 0) {
            const materialized = await materializeWorktrees(worktreePlans);
            if (materialized.error) {
              return {
                content: [{ type: "text", text: materialized.error }],
                details: makeDetails([], true),
              };
            }
            for (const plan of worktreePlans) pendingWorktrees.add(plan);
          }

          // Every call that reaches execution is registered as a job. The
          // snapshot above is taken first so forked children never inherit
          // this parent's delegation-origin entries. Worktree jobs reuse the
          // id reserved during planning so the branch name matches. Each job
          // also exposes its completion promise so `subagent_stop` can await
          // the job's final state instead of racing it.
          const jobs = calls.map((call) => {
            const plan = worktreePlans.find((candidate) => candidate.callIndex === call.index);
            return jobRegistry.create({
              id: plan?.jobId,
              agent: call.agent,
              handle: call.session?.handle ?? null,
              childSessionId: call.session?.id ?? null,
              childSessionFile: call.session
                ? existingSessionFiles.get(call.session.id) ?? null
                : null,
              model: resolveJobModel(call, agents, parentModel),
              cwd: call.effectiveCwd,
              worktree: plan?.branch,
            });
          });
          for (const job of jobs) trackJobCompletion(job.id);

          // Split the invocation: background calls detach and the tool returns
          // immediately with their job ids; foreground calls stream and block
          // exactly as before. Mixed invocations do both.
          const foregroundIndices: number[] = [];
          const backgroundIndices: number[] = [];
          for (const [index, call] of calls.entries()) {
            (call.background ? backgroundIndices : foregroundIndices).push(index);
          }

          for (const index of backgroundIndices) {
            const call = calls[index];
            backgroundStarts.push(
              startBackgroundJob({
                call,
                job: jobs[index],
                lock: call.session ? locksBySessionId.get(call.session.id) : undefined,
                worktreePlan: worktreePlans.find(
                  (candidate) => candidate.callIndex === call.index,
                ),
                parentSessionId,
                parentSessionSnapshotJsonl,
                persistentSessionDir,
                parentModel,
                agents,
                defaultCwd: ctx.cwd,
                makeDetails,
              }),
            );
          }

          if (foregroundIndices.length === 0) {
            // Background-only invocation: return immediately. The detached
            // children keep running; their results arrive as queued messages.
            const placeholders = backgroundIndices.map((index) =>
              makePlaceholderResult(calls[index], jobs[index]),
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatBackgroundAck(placeholders),
                },
              ],
              details: makeDetails(placeholders),
            };
          }

          const foregroundCalls = foregroundIndices.map((index) => calls[index]);
          const foregroundJobs = foregroundIndices.map((index) => jobs[index]);
          const foregroundResult = await executeCalls(
            foregroundCalls,
            foregroundJobs,
            worktreePlans,
            parentSessionId,
            parentSessionSnapshotJsonl,
            persistentSessionDir,
            parentModel,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );

          if (backgroundIndices.length === 0) {
            return foregroundResult;
          }

          // Mixed invocation: the foreground part blocked and completed; the
          // background jobs detached earlier and are acknowledged alongside
          // the foreground summary.
          const backgroundPlaceholders = backgroundIndices.map((index) =>
            makePlaceholderResult(calls[index], jobs[index]),
          );
          const combinedResults = [
            ...foregroundResult.details.results,
            ...backgroundPlaceholders,
          ].sort((a, b) => (a.callIndex ?? 0) - (b.callIndex ?? 0));
          const summaryText = foregroundResult.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `${formatBackgroundAck(backgroundPlaceholders)}\n\n${summaryText}`,
              },
            ],
            details: makeDetails(
              combinedResults,
              foregroundResult.details.failed === true,
            ),
          };
        } finally {
          // Release only what the foreground path owned. Background jobs
          // release their own lock and reserved session id on completion.
          const backgroundSessionIds = new Set(
            backgroundStarts
              .map((start) => start.call.session?.id)
              .filter((id): id is string => Boolean(id)),
          );
          for (const id of reservedSessionIds) {
            if (!backgroundSessionIds.has(id)) activeSessionIds.delete(id);
          }
          const backgroundLocks = new Set(
            backgroundStarts
              .map((start) => start.lock)
              .filter((lock): lock is SessionLock => Boolean(lock)),
          );
          releaseSessionLocks(
            lockResult.locks.filter((lock) => !backgroundLocks.has(lock)),
          );
        }
      },

      renderCall: (args, theme) => renderCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderResult(result, expanded, theme),
    });

    // ---------------------------------------------------------------------
    // Mid-run steering
    // ---------------------------------------------------------------------

    const makeSteerErrorResult = (
      error: string,
      job: JobRecord | null,
      message: string,
    ): { content: [{ type: "text"; text: string }]; details: SteerDetails } => ({
      content: [{ type: "text", text: error }],
      details: {
        kind: "pi-subagent-steer",
        job,
        message,
        delivered: false,
        error,
        failed: true,
      },
    });

    // Sends a steering message into a running child over its existing RPC
    // channel. Returns as soon as the child acknowledges the queued message;
    // the child course-corrects asynchronously and is never restarted. Tool
    // calls in one assistant message run in parallel, so a steer issued
    // alongside the spawning Agent call finds its job via the bounded wait.
    pi.registerTool({
      name: "subagent_steer",
      label: "Subagent steer",
      description: formatSteerToolDescription(),
      parameters: SteerParams,

      async execute(_toolCallId, params) {
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!message) {
          return makeSteerErrorResult(
            "The steering message must be a non-empty string.",
            null,
            "",
          );
        }

        const jobId =
          typeof params.job === "string" && params.job.trim()
            ? params.job.trim()
            : undefined;
        const handle =
          typeof params.handle === "string" && params.handle.trim()
            ? params.handle.trim()
            : undefined;
        if (handle && handle.length > SESSION_HANDLE_MAX_LENGTH) {
          return makeSteerErrorResult(
            `The session handle must be at most ${SESSION_HANDLE_MAX_LENGTH} characters.`,
            null,
            message,
          );
        }
        if (!jobId && !handle) {
          return makeSteerErrorResult(
            "Provide `job` (the job id from the Agent tool result details) or `handle` (the session handle the call used) to identify the subagent to steer.",
            null,
            message,
          );
        }

        const outcome = await steerJob(jobRegistry, steerChannels, { jobId, handle }, message);
        if (!outcome.ok) {
          return makeSteerErrorResult(outcome.error, outcome.job, message);
        }
        const { job } = outcome;
        return {
          content: [
            {
              type: "text" as const,
              text: `Steering message delivered to subagent job ${job.id} (agent ${job.agent}): the message is queued in the child and will be delivered after its current tool call, before its next response. The child keeps running; it is not restarted.`,
            },
          ],
          details: {
            kind: "pi-subagent-steer" as const,
            job,
            message,
            delivered: true,
          },
        };
      },
    });

    // ---------------------------------------------------------------------
    // Companion tools: status, result, stop, reply
    //
    // Ordinary tools (not spawn tools): they observe and manage the jobs
    // this session started, so subagent-aware clients must not treat their
    // calls as new subagents.
    // ---------------------------------------------------------------------

    pi.registerTool({
      name: "subagent_status",
      label: "Subagent status",
      description: formatStatusToolDescription(),
      parameters: StatusParams,

      async execute(_toolCallId, params) {
        const job = typeof params.job === "string" ? params.job.trim() : "";
        const listing = formatStatusListing(jobRegistry, job ? { job } : {});
        return {
          content: [{ type: "text" as const, text: listing.text }],
          details: listing.details,
        };
      },
    });

    pi.registerTool({
      name: "subagent_result",
      label: "Subagent result",
      description: formatResultToolDescription(),
      parameters: ResultParams,

      async execute(_toolCallId, params) {
        const jobId = typeof params.job === "string" ? params.job.trim() : undefined;
        const handle = typeof params.handle === "string" ? params.handle.trim() : undefined;
        const view = collectJobResult(jobRegistry, {
          ...(jobId ? { jobId } : {}),
          ...(handle ? { handle } : {}),
        });
        return {
          content: [{ type: "text" as const, text: view.content[0].text }],
          details: view.details,
        };
      },
    });

    pi.registerTool({
      name: "subagent_stop",
      label: "Subagent stop",
      description: formatStopToolDescription(),
      parameters: StopParams,

      async execute(_toolCallId, params) {
        const jobId = typeof params.job === "string" ? params.job.trim() : undefined;
        const handle = typeof params.handle === "string" ? params.handle.trim() : undefined;
        if (!jobId && !handle) {
          const error = "Provide `job` (the job id from the Agent tool result details) or `handle` (the session handle the call used) to identify the subagent to stop.";
          return {
            content: [{ type: "text" as const, text: error }],
            details: {
              kind: "pi-subagent-stop" as const,
              job: null,
              outcome: "error" as const,
              error,
              failed: true as const,
            },
          };
        }
        const outcome = await stopJob(jobRegistry, stopHandles, jobCompletions, {
          ...(jobId ? { jobId } : {}),
          ...(handle ? { handle } : {}),
        });
        return formatStopView(outcome, { limitBytes: backgroundOutputLimit });
      },
    });

    pi.registerTool({
      name: "subagent_reply",
      label: "Subagent reply",
      description: formatReplyToolDescription(),
      parameters: ReplyParams,

      async execute(_toolCallId, params): Promise<AgentToolResult<ReplyDetails>> {
        const jobId = typeof params.job === "string" ? params.job.trim() : "";
        const answer = typeof params.answer === "string" ? params.answer.trim() : "";
        if (!jobId || !answer) {
          const error = "Provide `job` (the job id from the relayed question message) and a non-empty `answer` for the waiting child.";
          return {
            content: [{ type: "text" as const, text: error }],
            details: {
              kind: "pi-subagent-reply" as const,
              job: null,
              answer,
              delivered: false,
              error,
              failed: true as const,
            },
          };
        }
        const outcome = askParentHub.reply(jobId, answer);
        if (!outcome.ok) {
          return {
            content: [{ type: "text" as const, text: outcome.error }],
            details: {
              kind: "pi-subagent-reply" as const,
              job: null,
              answer,
              delivered: false,
              error: outcome.error,
              failed: true as const,
            } as ReplyDetails,
          };
        }
        const { job } = outcome;
        return {
          content: [{ type: "text" as const, text: formatReplyDeliveredMessage(job, answer) }],
          details: {
            kind: "pi-subagent-reply" as const,
            job,
            answer,
            delivered: true,
          },
        };
      },
    });
  }

  // -----------------------------------------------------------------------
  // Call execution
  // -----------------------------------------------------------------------

  /**
   * Track lifecycle transitions for one call's job and mirror them into the
   * parent session JSONL. Status is advanced before each entry is written, so
   * entries record the status at write time.
   */
  const advanceJob = (
    job: JobRecord,
    call: NormalizedCall,
    parentSessionId: string,
    status: JobStatus,
  ): void => {
    jobRegistry.setStatus(job.id, status);
    appendDelegationOriginEntry(call, job, parentSessionId);
  };

  /**
   * Inject a compact result summary for a finished background job as a queued
   * user message with follow-up delivery: Pi delivers it as a new turn when
   * the parent agent is idle, and queues it while the parent runs. The
   * included output is capped per child; the full result stays in the
   * registry. Best-effort: a session that cannot accept queued messages still
   * keeps the completed job and its stored output.
   */
  const deliverBackgroundResult = (job: JobRecord, result: SingleResult): void => {
    if (typeof pi.sendUserMessage !== "function") return;
    const message = formatBackgroundResultMessage(job, result, {
      limitBytes: backgroundOutputLimit,
    });
    try {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch (error) {
      console.warn(
        `[pi-subagent] Could not deliver background result for job ${job.id}: ${String(error)}`,
      );
    }
  };

  /**
   * Start one detached background job. The child runs independently of the
   * tool invocation: no per-call abort signal, no streaming updates — the
   * invocation's signal and progress callback belong to the tool call, not to
   * the job. On completion the full result is stored in the registry, the job
   * advances to its terminal status, a compact capped summary is injected as
   * a queued user message, and the job's session lock and reserved session id
   * are released.
   */
  const startBackgroundJob = (start: BackgroundJobStart): BackgroundJobStart => {
    const { call, job } = start;
    advanceJob(job, call, start.parentSessionId, "running");

    const finishBackgroundJob = (result: SingleResult): void => {
      jobRegistry.setResult(job.id, result);
      if (job.childSessionId && !job.childSessionFile) {
        const file = findChildSessionFile(
          call.effectiveCwd,
          job.childSessionId,
          start.persistentSessionDir,
        );
        if (file) jobRegistry.setChildSessionFile(job.id, file);
      }
      advanceJob(job, call, start.parentSessionId, terminalJobStatus(result));
      // The completion promise settles after the result is stored and the
      // terminal status is recorded, so a stop waiting on it observes the
      // job's final state.
      settleJobCompletion(job.id, result);
      const plan = start.worktreePlan;
      const settleBackgroundJob = async (): Promise<void> => {
        if (plan) {
          // Apply the landing policy on every exit path (success, failure,
          // and stop), mirroring the foreground path. Landing never throws:
          // failures surface as notes in the report and keep the worktree so
          // the work is recoverable.
          try {
            result.landing = await applyWorktreeLanding(plan, {
              jobId: job.id,
              agent: job.agent,
              status: job.status,
              prompt: call.prompt,
              childSessionId: job.childSessionId,
            });
          } catch (error) {
            console.warn(`[pi-subagent] Worktree landing failed for ${plan.branch}: ${String(error)}`);
            result.landing = {
              policy: plan.landing,
              branch: plan.branch,
              worktreePath: plan.path,
              worktreeRemoved: false,
              note: `Landing failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          pendingWorktrees.delete(plan);
        }
        deliverBackgroundResult(job, result);
        if (call.session) activeSessionIds.delete(call.session.id);
        if (start.lock) releaseSessionLocks([start.lock]);
      };
      void settleBackgroundJob();
    };

    runAgent({
      cwd: start.defaultCwd,
      agents: start.agents,
      callIndex: call.index,
      agentName: call.agent,
      prompt: call.prompt,
      callModel: call.model,
      callThinking: call.thinking,
      parentSessionId: start.parentSessionId,
      parentModel: start.parentModel,
      callCwd: call.effectiveCwd,
      initialContext: call.initialContext,
      parentSessionSnapshotJsonl: start.parentSessionSnapshotJsonl,
      session: call.session,
      persistentSessionDir: start.persistentSessionDir,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      inactivityTimeoutMs: call.inactivityTimeoutMs,
      timeoutMs: call.timeoutMs,
      signal: undefined,
      onUpdate: undefined,
      makeDetails: start.makeDetails,
      job,
      steerChannels,
      stopHandles,
      stopGraceMs,
      askParent: askParentHub,
    }).then(finishBackgroundJob, (error) => {
      // runAgent resolves rather than rejects, but a rejection must not
      // strand the job's lock or leave it without a completion notification.
      const message = error instanceof Error ? error.message : String(error);
      finishBackgroundJob({
        ...makePlaceholderResult(call, job),
        exitCode: 1,
        stderr: message,
        stopReason: "error",
        errorMessage: message,
        processError: true,
      });
    });
    return start;
  };

  async function executeCalls(
    calls: NormalizedCall[],
    jobs: JobRecord[],
    worktreePlans: WorktreePlan[],
    parentSessionId: string,
    parentSessionSnapshotJsonl: string | undefined,
    persistentSessionDir: string | undefined,
    parentModel: ParentModel | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    const allResults: SingleResult[] = calls.map((call, index) =>
      makePlaceholderResult(call, jobs[index]),
    );

    const emitProgress = () => {
      if (!onUpdate) return;
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      try {
        onUpdate({
          content: [
            {
              type: "text",
              text: `Subagents: ${done}/${allResults.length} done, ${running} running...`,
            },
          ],
          details: makeDetails([...allResults]),
        });
      } catch (error) {
        console.warn(`[pi-subagent] Progress callback failed: ${String(error)}`);
      }
    };

    let heartbeat: NodeJS.Timeout | undefined;
    if (onUpdate) {
      emitProgress();
      heartbeat = setInterval(() => {
        if (allResults.some((r) => r.exitCode === -1)) emitProgress();
      }, CALLS_HEARTBEAT_MS);
    }

    let results: SingleResult[];
    try {
      results = await mapConcurrent(
        calls,
        MAX_CONCURRENCY,
        async (call, workerIndex) => {
          const job = jobs[workerIndex];
          const plan = worktreePlans.find((candidate) => candidate.callIndex === call.index);
          advanceJob(job, call, parentSessionId, "running");
          let result: SingleResult;
          try {
            result = await runAgent({
              cwd: defaultCwd,
              agents,
              callIndex: call.index,
              agentName: call.agent,
              prompt: call.prompt,
              callModel: call.model,
              callThinking: call.thinking,
              parentSessionId,
              parentModel,
              callCwd: call.effectiveCwd,
              initialContext: call.initialContext,
              parentSessionSnapshotJsonl,
              session: call.session,
              persistentSessionDir,
              parentDepth: currentDepth,
              parentAgentStack: ancestorAgentStack,
              maxDepth,
              preventCycles,
              inactivityTimeoutMs: call.inactivityTimeoutMs,
              timeoutMs: call.timeoutMs,
              signal,
              job,
              steerChannels,
              stopHandles,
              stopGraceMs,
              askParent: askParentHub,
              onUpdate: (partial) => {
                if (partial.details?.results[0]) {
                  allResults[workerIndex] = partial.details.results[0];
                  emitProgress();
                }
              },
              makeDetails,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result = {
              ...makePlaceholderResult(call, job),
              exitCode: 1,
              stderr: message,
              stopReason: "error",
              errorMessage: message,
              processError: true,
            };
          }
          if (job.childSessionId && !job.childSessionFile) {
            const file = findChildSessionFile(
              call.effectiveCwd,
              job.childSessionId,
              persistentSessionDir,
            );
            if (file) jobRegistry.setChildSessionFile(job.id, file);
          }
          // Full output stays stored in the registry for on-demand retrieval
          // (subagent_result) in addition to the tool result details.
          jobRegistry.setResult(job.id, result);
          advanceJob(job, call, parentSessionId, terminalJobStatus(result));
          // The completion promise settles after the result is stored and the
          // terminal status is recorded (the same invariant as the background
          // path), so a concurrent stop observes the final state.
          settleJobCompletion(job.id, result);
          // Fail-soft: the failed result carries partial output, its session
          // handle, and guidance for one corrective resume call.
          attachFailureResume(result);
          if (plan) {
            // Apply the landing policy on every exit path (success, failure,
            // and stop). Landing never throws: failures surface as notes in
            // the report and keep the worktree so the work is recoverable.
            try {
              result.landing = await applyWorktreeLanding(plan, {
                jobId: job.id,
                agent: job.agent,
                status: job.status,
                prompt: call.prompt,
                childSessionId: job.childSessionId,
              });
            } catch (error) {
              console.warn(`[pi-subagent] Worktree landing failed for ${plan.branch}: ${String(error)}`);
              result.landing = {
                policy: plan.landing,
                branch: plan.branch,
                worktreePath: plan.path,
                worktreeRemoved: false,
                note: `Landing failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            pendingWorktrees.delete(plan);
          }
          allResults[workerIndex] = result;
          emitProgress();
          return result;
        },
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const hasErrors = results.some((r) => isResultError(r));
    const summary = formatCallsSummary(results, saveFullOutput);
    return {
      content: [
        {
          type: "text" as const,
          text: summary.text,
        },
      ],
      details: makeDetails(results, hasErrors),
    };
  }
}
