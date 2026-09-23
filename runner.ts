/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_MAX_BYTES,
  getPackageDir,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { ASK_PARENT_DIR_ENV, ASK_PARENT_TOOL_NAME } from "./ask-parent.js";
import { DELEGATION_ENV, type DelegationMetadata } from "./delegation-metadata.js";
import type { JobRecord } from "./jobs.js";
import {
  getInheritedProjectTrustArgs,
  parseInheritedCliArgs,
  selectInheritedPiArgv,
} from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import {
  STOP_WRAPUP_COMMAND_ID,
  formatStopWrapUpInstruction,
  formatTimeoutWrapUpInstruction,
  resolveStopGraceMs,
  type StopHandleRegistry,
  type SubagentStopHandle,
} from "./stop.js";
import type { AskParentHub } from "./questions.js";
import { SteerChannel, type SteerChannelRegistry } from "./steering.js";
import {
  type CallThinkingLevel,
  type InitialContext,
  type SingleResult,
  type SubagentDetails,
  type SubagentSessionDetails,
  emptyUsage,
  getFinalOutput,
  markStoppedResult,
  normalizeCompletedResult,
} from "./types.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 500;
const TERMINATION_SETTLE_TIMEOUT_MS = SIGKILL_TIMEOUT_MS + 1000;
const AGENT_END_GRACE_MS = 250;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TEMP_PARENT_SESSION_ENV = "PI_SUBAGENT_TEMP_PARENT_SESSION";
const PI_OFFLINE_ENV = "PI_OFFLINE";
const PERSISTENT_SESSION_EXIT_TIMEOUT_MS = 30_000;
const MAX_JSON_LINE_BYTES = 25 * 1024 * 1024;
const MAX_STDERR_BYTES = DEFAULT_MAX_BYTES;

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export interface UnexpectedSignalFailure {
  exitCode: number;
  message: string;
}

/** Classify a signal exit that was not initiated by cancellation or a watchdog. */
export function getUnexpectedSignalFailure(
  code: number | null,
  signalName: NodeJS.Signals | null,
  wasAborted: boolean,
  forcedExitCode?: number,
): UnexpectedSignalFailure | null {
  if (code !== null || !signalName || wasAborted || forcedExitCode !== undefined) {
    return null;
  }

  const signalNumber = os.constants.signals[signalName];
  return {
    exitCode: typeof signalNumber === "number" ? 128 + signalNumber : 1,
    message: `Subagent terminated unexpectedly by ${signalName}.`,
  };
}

function resolvePiRpcEntry(): string {
  const packageDir = getPackageDir();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"),
  ) as {
    exports?: Record<string, string | { import?: string }>;
  };
  const rpcExport = manifest.exports?.["./rpc-entry"];
  const relativePath = typeof rpcExport === "string" ? rpcExport : rpcExport?.import;
  if (!relativePath) {
    throw new Error("The installed Pi package does not export an RPC entrypoint.");
  }
  return path.resolve(packageDir, relativePath);
}

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
export function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode) {
    return { command: process.execPath, prefixArgs: [resolvePiRpcEntry()] };
  }
  return { command: process.execPath, prefixArgs: ["--mode", "rpc"] };
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  try {
    fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    return { dir: tmpDir, filePath };
  } catch (error) {
    cleanupTempDir(tmpDir);
    throw error;
  }
}

function writeSessionSnapshotToTempFile(
  agentName: string,
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `parent-${safeName}.jsonl`);
  try {
    fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
    return { dir: tmpDir, filePath };
  } catch (error) {
    cleanupTempDir(tmpDir);
    throw error;
  }
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function rewriteSessionHeaderCwd(
  sessionJsonl: string,
  cwd: string,
): string | null {
  const newlineIndex = sessionJsonl.indexOf("\n");
  const firstLine = newlineIndex === -1 ? sessionJsonl : sessionJsonl.slice(0, newlineIndex);
  if (!firstLine.trim()) return null;

  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return null;
  }

  if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session") {
    return null;
  }

  const updatedHeader = { ...header, cwd };
  const rest = newlineIndex === -1 ? "" : sessionJsonl.slice(newlineIndex + 1);
  return `${JSON.stringify(updatedHeader)}\n${rest}`;
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(
  selectInheritedPiArgv(process.argv, process.env),
);

/**
 * Tool flags for one child. When the ask-parent extension is loaded, the
 * `ask_parent` tool is kept available regardless of the agent's tool
 * restrictions: asking the parent is runtime plumbing, not a work tool. A
 * `--tools` allowlist gains the tool; a `--no-tools` child gets exactly the
 * ask tool (an allowlist of one disables everything else, matching the
 * no-tools semantics).
 */
function buildToolArgs(agent: AgentConfig, askExtensionPath: string | undefined): string[] {
  let toolArgs: string[] | undefined;
  if (agent.noTools === true) {
    toolArgs = ["--no-tools"];
  } else if (agent.tools && agent.tools.length > 0) {
    toolArgs = ["--tools", agent.tools.join(",")];
  } else if (agent.tools === undefined) {
    if (inheritedCliArgs.fallbackTools !== undefined) {
      toolArgs = ["--tools", inheritedCliArgs.fallbackTools];
    } else if (inheritedCliArgs.fallbackNoTools) {
      toolArgs = ["--no-tools"];
    }
  }
  if (!toolArgs) return [];
  if (!askExtensionPath) return toolArgs;
  if (toolArgs[0] === "--tools") {
    const names = toolArgs[1].split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (!names.includes(ASK_PARENT_TOOL_NAME)) names.push(ASK_PARENT_TOOL_NAME);
    return ["--tools", names.join(",")];
  }
  return ["--tools", ASK_PARENT_TOOL_NAME];
}

export interface ParentModel {
  provider: string;
  id: string;
}

function formatParentModel(parentModel: ParentModel | undefined): string | undefined {
  return parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
}

export function buildModelArgs(
  callModel: string | undefined,
  agentModel: string | undefined,
  parentModel: ParentModel | undefined,
  fallbackProvider: string | undefined,
  fallbackModel: string | undefined,
): string[] {
  const configuredModel = callModel ?? agentModel;
  if (configuredModel) {
    return [
      ...(fallbackProvider ? ["--provider", fallbackProvider] : []),
      "--model",
      configuredModel,
    ];
  }

  const inheritedModel = formatParentModel(parentModel);
  if (inheritedModel) return ["--model", inheritedModel];

  return [
    ...(fallbackProvider ? ["--provider", fallbackProvider] : []),
    ...(fallbackModel ? ["--model", fallbackModel] : []),
  ];
}

export function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  _prompt: string,
  initialContext: InitialContext,
  parentSessionPath: string | null,
  session: SubagentSessionDetails | undefined,
  persistentSessionDir: string | undefined,
  callModel?: string,
  parentModel?: ParentModel,
  inheritProjectApproval = true,
  callThinking?: CallThinkingLevel,
  askExtensionPath?: string,
): string[] {
  const projectTrustArgs = getInheritedProjectTrustArgs(
    inheritedCliArgs.projectTrustOverride,
    inheritProjectApproval,
  );
  const args: string[] = [
    ...inheritedCliArgs.extensionArgs,
    ...inheritedCliArgs.alwaysProxy,
    ...projectTrustArgs,
  ];

  if (session && persistentSessionDir && !inheritedCliArgs.sessionDir) {
    args.push("--session-dir", persistentSessionDir);
  }

  if (askExtensionPath) {
    // Explicit loading also works when discovery is disabled or cwd changes.
    // The child-side tool stays dormant unless the ask-directory marker env
    // is present, which the runner sets alongside this flag.
    args.push("--extension", askExtensionPath);
  }

  if (session) {
    // Explicit loading also works when discovery is disabled or cwd changes.
    args.push("--extension", fileURLToPath(new URL("./delegation-metadata.ts", import.meta.url)));
    if (session.created && initialContext === "parent") {
      if (parentSessionPath) args.push("--fork", parentSessionPath);
    }
    args.push("--session-id", session.id);
    if (session.created) args.push("--name", session.name);
  } else if (initialContext === "parent") {
    if (parentSessionPath) args.push("--session", parentSessionPath);
  } else {
    args.push("--no-session");
  }

  args.push(...buildModelArgs(
    callModel,
    agent.model,
    parentModel,
    inheritedCliArgs.fallbackProvider,
    inheritedCliArgs.fallbackModel,
  ));

  const thinking = callThinking ?? agent.thinking ?? inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  args.push(...buildToolArgs(agent, askExtensionPath));

  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Fallback working directory when the call doesn't specify one. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Original call index in the tool invocation. */
  callIndex: number;
  /** Name of the agent to run. */
  agentName: string;
  /** Prompt sent verbatim to the subagent. */
  prompt: string;
  /** Per-call model override. */
  callModel?: string;
  /** Per-call thinking override. */
  callThinking?: CallThinkingLevel;
  /** Actual delegator identity captured before any temporary parent snapshot. */
  parentSessionId: string;
  /** Parent session model captured when the tool invocation started. */
  parentModel?: ParentModel;
  /** Effective working directory for this process. */
  callCwd?: string;
  /** Initial context for newly-created child conversations. */
  initialContext: InitialContext;
  /** Serialized parent session snapshot, used when initialContext is "parent". */
  parentSessionSnapshotJsonl?: string;
  /** Optional named persistent subagent session. */
  session?: SubagentSessionDetails;
  /** Optional persistent session directory inherited from the parent runtime. */
  persistentSessionDir?: string;
  /** Current delegation depth of the caller process. */
  parentDepth: number;
  /** Delegation stack from the caller process (ancestor agent names). */
  parentAgentStack: string[];
  /** Maximum allowed delegation depth to propagate to child processes. */
  maxDepth: number;
  /** Whether cycle prevention should be enforced in child processes. */
  preventCycles: boolean;
  /** Optional per-call inactivity timeout. Overrides the agent default. */
  inactivityTimeoutMs?: number;
  /** Optional exceptional wall-clock deadline for the child run. */
  timeoutMs?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  /** Parent-side job record tracking this call; embedded in the result. */
  job?: JobRecord;
  /** Live steering channels by job id; this child's channel attaches here. */
  steerChannels?: SteerChannelRegistry;
  /** Live graceful-stop handles by job id; this child's handle attaches here. */
  stopHandles?: StopHandleRegistry;
  /** Grace period for graceful stops and timeout wrap-ups, in milliseconds. */
  stopGraceMs?: number;
  /** Parent-side hub relaying this child's ask_parent questions. */
  askParent?: AskParentHub;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export function isSameWorkingDirectory(left: string, right: string): boolean {
  return fs.realpathSync(left) === fs.realpathSync(right);
}

export function resolveInactivityTimeoutMs(
  callInactivityTimeoutMs: number | undefined,
  agentTimeoutSeconds: number | undefined,
): number | undefined {
  return callInactivityTimeoutMs ??
    (agentTimeoutSeconds === undefined ? undefined : agentTimeoutSeconds * 1000);
}

export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agents,
    callIndex,
    agentName,
    prompt,
    callModel,
    callThinking,
    parentSessionId,
    parentModel,
    callCwd,
    initialContext,
    parentSessionSnapshotJsonl,
    session,
    persistentSessionDir,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    inactivityTimeoutMs: callInactivityTimeoutMs,
    timeoutMs,
    signal,
    onUpdate,
    makeDetails,
    job,
    steerChannels,
    stopHandles,
    stopGraceMs,
    askParent,
  } = opts;

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      callIndex,
      agent: agentName,
      agentSource: "unknown",
      prompt,
      initialContext,
      session,
      job,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: `Unknown agent: "${agentName}". Available agents: ${available}.`,
    };
  }

  const needsParentSnapshot = initialContext === "parent" && (!session || session.created);
  if (needsParentSnapshot && (!parentSessionSnapshotJsonl || !parentSessionSnapshotJsonl.trim())) {
    const message =
      "Cannot run with initialContext=\"parent\": missing parent session snapshot context.";
    return {
      callIndex,
      agent: agentName,
      agentSource: agent.source,
      prompt,
      initialContext,
      session,
      job,
      exitCode: 1,
      messages: [],
      stderr: message,
      usage: emptyUsage(),
      model: callModel ?? agent.model,
      stopReason: "error",
      errorMessage: message,
    };
  }

  const inactivityTimeoutMs = resolveInactivityTimeoutMs(
    callInactivityTimeoutMs,
    agent.inactivityTimeout,
  );

  const result: SingleResult = {
    callIndex,
    agent: agentName,
    agentSource: agent.source,
    prompt,
    initialContext,
    session,
    job,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: callModel ?? agent.model,
  };

  if (signal?.aborted) {
    return normalizeCompletedResult(result, true);
  }

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages) || "(running...)",
        },
      ],
      details: makeDetails([result]),
    });
  };

  let wasAborted = false;
  // Reason recorded on the result when the run is stopped by request; the
  // graceful-stop expiry path applies it after abort normalization.
  let stopRequestedReason: string | undefined;
  const gracefulStopGraceMs = stopGraceMs ?? resolveStopGraceMs();
  // Append agent instructions and runtime guidance without replacing Pi's base prompt.
  let promptTmpDir: string | null = null;
  let promptTmpPath: string | null = null;
  let parentSessionTmpDir: string | null = null;
  let parentSessionTmpPath: string | null = null;
  let askDir: string | null = null;

  try {
    const childSystemPrompt = [
      agent.systemPrompt,
      "## Subagent runtime\n\n" +
        "Your runtime shuts down after your final response. Finish required commands and inspect their results before returning. " +
        "Use explicit or blocking waits where available; do not rely on notifications after your final response. " +
        "Stop temporary services you started for your own work before returning. " +
        "For a test server: start it, wait for readiness (not exit), run tests, wait for test completion and inspect results, stop the server, then respond.",
    ].filter(Boolean).join("\n\n");
    const promptFile = writePromptToTempFile(agent.name, childSystemPrompt);
    promptTmpDir = promptFile.dir;
    promptTmpPath = promptFile.filePath;

    // Write parent session snapshot if this call needs one.
    if (needsParentSnapshot && parentSessionSnapshotJsonl) {
      const snapshotCwd = path.resolve(callCwd ?? cwd);
      const snapshotJsonl =
        rewriteSessionHeaderCwd(parentSessionSnapshotJsonl, snapshotCwd) ??
        parentSessionSnapshotJsonl;
      const tmp = writeSessionSnapshotToTempFile(agent.name, snapshotJsonl);
      parentSessionTmpDir = tmp.dir;
      parentSessionTmpPath = tmp.filePath;
    }

    // Child questions (ask_parent): the child gets a private ask directory
    // and the child-side extension, which stays dormant unless the ask
    // directory marker env is present. The parent-side hub watches the
    // directory for questions while the child runs.
    if (askParent && job) {
      askDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    }
    const askExtensionPath = askDir
      ? fileURLToPath(new URL("./ask-parent.ts", import.meta.url))
      : undefined;

    const piArgs = buildPiArgs(
      agent,
      promptTmpPath,
      prompt,
      initialContext,
      parentSessionTmpPath,
      session,
      persistentSessionDir,
      callModel,
      parentModel,
      isSameWorkingDirectory(callCwd ?? cwd, cwd),
      callThinking,
      askExtensionPath,
    );

    const delegation: DelegationMetadata | undefined = session?.created ? {
      version: 1,
      childSessionId: session.id,
      parentSessionId,
      agent: agentName,
      handle: session.handle,
    } : undefined;

    const exitCode = await new Promise<number>((resolve) => {
      const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
      const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
      const propagatedStack = [...parentAgentStack, agentName];
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd: callCwd ?? cwd,
        shell: false,
        detached: !isWindows,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Never inherit the caller's origin, including for temporary snapshots
          // that retain the caller's header ID. Continuations are not backfilled.
          [DELEGATION_ENV]: delegation ? JSON.stringify(delegation) : undefined,
          [SUBAGENT_DEPTH_ENV]: String(nextDepth),
          [SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
          [SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
          [SUBAGENT_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
          [SUBAGENT_TEMP_PARENT_SESSION_ENV]: !session && initialContext === "parent" ? "1" : "0",
          // Children never inherit an older sibling's ask directory: the marker
          // is set only by the runner that owns this child, and cleared otherwise.
          [ASK_PARENT_DIR_ENV]: askDir ?? undefined,
          [PI_OFFLINE_ENV]: "1",
        },
      });

      proc.stdin.on("error", () => {
        /* ignore broken pipe on fast exits */
      });
      // RPC preserves prompt bytes exactly. Print-mode stdin trims leading and
      // trailing whitespace, while argv reinterprets leading "-" and "@".
      proc.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);

      // Mid-run steering: the child's RPC stdin stays writable for the whole
      // run, so steer commands can be sent while the child works. The channel
      // is published to the registry once the child's agent run starts (its
      // `agent_start` event) and torn down when the run settles, so steering
      // can only target a child that is actually running.
      const steerChannel = new SteerChannel((line, onWritten) => {
        if (proc.stdin.destroyed || proc.stdin.writableEnded) {
          onWritten(new Error("the child's RPC stdin is no longer writable (the run may have just finished)"));
          return;
        }
        proc.stdin.write(line, (error) => onWritten(error ?? null));
      });
      let steerChannelAttached = false;
      const attachSteerChannel = () => {
        if (steerChannelAttached || !steerChannels || !job?.id) return;
        steerChannelAttached = true;
        steerChannels.attach(job.id, steerChannel);
      };

      // Child questions: the hub watches the child's ask directory from
      // spawn until the run finishes, relaying questions and timeouts.
      if (askDir && askParent && job) {
        askParent.watch(job, askDir);
      }

      let buffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let didClose = false;
      let settled = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;
      let persistentSessionExitTimer: NodeJS.Timeout | undefined;
      let inactivityTimeoutTimer: NodeJS.Timeout | undefined;
      let runTimeoutTimer: NodeJS.Timeout | undefined;
      let rpcHandledTimer: NodeJS.Timeout | undefined;
      let sigkillTimer: NodeJS.Timeout | undefined;
      let terminationSettleTimer: NodeJS.Timeout | undefined;
      let terminationStarted = false;
      let forcedExitCode: number | undefined;
      let gracefulStopStarted = false;
      let gracefulStopTimer: NodeJS.Timeout | undefined;

      const appendStderr = (text: string) => {
        const combined = `${result.stderr}${text}`;
        const truncation = truncateTail(combined, {
          maxBytes: MAX_STDERR_BYTES,
          maxLines: Number.MAX_SAFE_INTEGER,
        });
        result.stderr = truncation.content;
        if (truncation.truncated) result.stderrTruncated = true;
      };

      const clearSemanticCompletionTimer = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
      };

      const clearPersistentSessionExitTimer = () => {
        if (persistentSessionExitTimer) {
          clearTimeout(persistentSessionExitTimer);
          persistentSessionExitTimer = undefined;
        }
      };

      const clearInactivityTimeoutTimer = () => {
        if (inactivityTimeoutTimer) {
          clearTimeout(inactivityTimeoutTimer);
          inactivityTimeoutTimer = undefined;
        }
      };

      const clearRunTimeoutTimer = () => {
        if (runTimeoutTimer) {
          clearTimeout(runTimeoutTimer);
          runTimeoutTimer = undefined;
        }
      };

      const clearRunWatchdogs = () => {
        clearInactivityTimeoutTimer();
        clearRunTimeoutTimer();
      };

      const clearRpcHandledTimer = () => {
        if (rpcHandledTimer) {
          clearTimeout(rpcHandledTimer);
          rpcHandledTimer = undefined;
        }
      };

      const isProcessGroupAlive = () => {
        if (isWindows || proc.pid === undefined) return false;
        try {
          process.kill(-proc.pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const signalProcessTree = (signalName: NodeJS.Signals) => {
        if (proc.pid === undefined) return;
        try {
          // Detached Unix children lead their own process group. A negative PID
          // signals Pi and every descendant that has not deliberately escaped.
          process.kill(-proc.pid, signalName);
        } catch {
          try {
            proc.kill(signalName);
          } catch {
            // The process may already have exited between checks.
          }
        }
      };

      const terminateChild = () => {
        if (terminationStarted) return;
        terminationStarted = true;
        clearRunWatchdogs();

        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.once("error", (error) => {
              recordProcessFailure(`Could not start Windows taskkill: ${error.message}`);
              try {
                proc.kill();
              } catch {
                // The process may already have exited between checks.
              }
            });
            killer.unref();
          }
        } else {
          signalProcessTree("SIGTERM");
          sigkillTimer = setTimeout(() => {
            signalProcessTree("SIGKILL");
          }, SIGKILL_TIMEOUT_MS);
        }

        terminationSettleTimer = setTimeout(() => {
          if (settled) return;
          proc.stdout.removeListener("data", onStdoutData);
          proc.stderr.removeListener("data", onStderrData);
          if (forcedExitCode === undefined) forcedExitCode = wasAborted ? 130 : 1;
          finish(forcedExitCode);
        }, TERMINATION_SETTLE_TIMEOUT_MS);
      };

      const recordProcessFailure = (message: string) => {
        if (!result.processError) {
          result.processError = true;
          result.stopReason = "error";
          result.errorMessage = message;
        }
        if (!result.stderr.includes(message)) {
          appendStderr(`${result.stderr ? "\n" : ""}${message}`);
        }
        forcedExitCode = 1;
      };

      const failAndTerminate = (message: string) => {
        recordProcessFailure(message);
        terminateChild();
      };

      // ---------------------------------------------------------------------
      // Graceful stop
      //
      // The shared wrap-up -> grace -> terminate sequence. `subagent_stop`
      // and wall-clock timeout expiry both begin here: the child gets a
      // steer-style wrap-up instruction and a bounded grace period to report
      // partial progress, then the process tree is terminated. A child that
      // settles during the grace period flows through the normal settlement
      // path, so its output and session file are complete rather than
      // cut off mid-stream.
      // ---------------------------------------------------------------------

      const sendWrapUpInstruction = (message: string) => {
        if (proc.stdin.destroyed || proc.stdin.writableEnded) return;
        try {
          // A steer command queues in the child whether or not it is
          // streaming, so the wrap-up lands after its current tool call.
          proc.stdin.write(`${JSON.stringify({ type: "steer", id: STOP_WRAPUP_COMMAND_ID, message })}\n`);
        } catch {
          // The grace period bounds the stop; a failed write only means the
          // child cannot heed the wrap-up.
        }
      };

      const beginGracefulStop = (
        wrapUpMessage: string,
        onGraceExpired: () => void,
        graceMsOverride?: number,
      ): boolean => {
        if (gracefulStopStarted || terminationStarted || settled || didClose) return false;
        gracefulStopStarted = true;
        clearRunWatchdogs();
        sendWrapUpInstruction(wrapUpMessage);
        const graceMs = graceMsOverride !== undefined && Number.isFinite(graceMsOverride) && graceMsOverride > 0
          ? graceMsOverride
          : gracefulStopGraceMs;
        gracefulStopTimer = setTimeout(() => {
          gracefulStopTimer = undefined;
          if (didClose || settled) return;
          onGraceExpired();
        }, graceMs);
        gracefulStopTimer.unref();
        return true;
      };

      // The stop handle publishes this child's graceful-stop sequence from
      // the moment the process exists: a stop may target a job whose agent
      // run has not started yet. Detached on finish, like the steer channel.
      if (job?.id && stopHandles) {
        const stopHandle: SubagentStopHandle = {
          jobId: job.id,
          get requested() {
            return gracefulStopStarted;
          },
          requestStop(reason: string, graceMs?: number): boolean {
            return beginGracefulStop(formatStopWrapUpInstruction(), () => {
              stopRequestedReason = reason;
              wasAborted = true;
              terminateChild();
            }, graceMs);
          },
        };
        stopHandles.attach(job.id, stopHandle);
      }

      const resetInactivityTimeout = () => {
        if (
          inactivityTimeoutMs === undefined ||
          result.sawAgentSettled ||
          didClose ||
          settled ||
          terminationStarted ||
          gracefulStopStarted
        ) return;
        clearInactivityTimeoutTimer();
        inactivityTimeoutTimer = setTimeout(() => {
          if (didClose || settled || terminationStarted) return;
          const timeoutSeconds = inactivityTimeoutMs / 1000;
          failAndTerminate(
            `Subagent produced no child RPC stdout activity for ${timeoutSeconds}s and exceeded its inactivity timeout.`,
          );
        }, inactivityTimeoutMs);
        inactivityTimeoutTimer.unref();
      };

      resetInactivityTimeout();

      if (timeoutMs !== undefined) {
        runTimeoutTimer = setTimeout(() => {
          if (didClose || settled) return;
          const timeoutSeconds = timeoutMs / 1000;
          // The run is a failure from the moment the deadline passes: the
          // wrap-up sequence below only decides how it terminates, giving
          // the child a grace period to report clean partial output.
          recordProcessFailure(`Subagent exceeded its configured ${timeoutSeconds}s run timeout.`);
          beginGracefulStop(
            formatTimeoutWrapUpInstruction(timeoutSeconds),
            () => terminateChild(),
          );
        }, timeoutMs);
        runTimeoutTimer.unref();
      }

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearSemanticCompletionTimer();
        clearPersistentSessionExitTimer();
        clearRunWatchdogs();
        clearRpcHandledTimer();
        if (gracefulStopTimer) clearTimeout(gracefulStopTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (terminationSettleTimer) clearTimeout(terminationSettleTimer);
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        if (job?.id) steerChannels?.detach(job.id);
        if (job?.id) stopHandles?.detach(job.id);
        if (job?.id) askParent?.stopWatch(job.id);
        steerChannel.close("the subagent run finished");
        resolve(forcedExitCode ?? code);
      };

      const flushLine = (line: string) => {
        if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
          failAndTerminate(
            `Subagent emitted a JSON event larger than ${MAX_JSON_LINE_BYTES} bytes.`,
          );
          return;
        }
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          event = undefined;
        }
        if (event?.type === "extension_ui_request" && typeof event.id === "string") {
          proc.stdin.write(`${JSON.stringify({
            type: "extension_ui_response",
            id: event.id,
            cancelled: true,
          })}\n`);
        }

        if (event?.type === "agent_start") attachSteerChannel();
        if (event?.type === "response") steerChannel.handleResponse(event);

        if (processPiJsonLine(line, result)) emitUpdate();
        if (result.sawAgentStart) clearRpcHandledTimer();
        if (
          result.rpcPromptIdle &&
          !result.sawAgentStart &&
          !result.sawAgentSettled
        ) {
          result.handledWithoutAgent = true;
          result.sawAgentSettled = true;
        }
        if (
          result.rpcPromptAccepted &&
          !result.sawAgentStart &&
          !result.sawAgentSettled &&
          !rpcHandledTimer
        ) {
          rpcHandledTimer = setTimeout(() => {
            if (result.sawAgentStart || result.sawAgentSettled || settled) return;
            proc.stdin.write(`${JSON.stringify({
              type: "get_state",
              id: "pi-subagent-prompt-state",
            })}\n`);
          }, AGENT_END_GRACE_MS);
        }
        maybeFinishFromSettlement();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const maybeFinishFromSettlement = () => {
        if (!result.sawAgentSettled || didClose || settled) return;
        clearInactivityTimeoutTimer();
        if (!proc.stdin.destroyed) proc.stdin.end();
        if (session) {
          // Named sessions persist child history. Let Pi exit naturally so its
          // session file is fully flushed before the parent reports completion.
          if (!persistentSessionExitTimer) {
            persistentSessionExitTimer = setTimeout(() => {
              if (didClose || settled || !result.sawAgentSettled) return;
              failAndTerminate(
                `Named subagent session did not exit within ${PERSISTENT_SESSION_EXIT_TIMEOUT_MS}ms after settling; terminated to avoid hanging.`,
              );
            }, PERSISTENT_SESSION_EXIT_TIMEOUT_MS);
            persistentSessionExitTimer.unref();
          }
          return;
        }
        clearSemanticCompletionTimer();
        semanticCompletionTimer = setTimeout(() => {
          if (didClose || settled || !result.sawAgentSettled) return;
          if (buffer.trim()) {
            flushBufferedLines(buffer);
            buffer = "";
          }
          proc.stdout.removeListener("data", onStdoutData);
          proc.stderr.removeListener("data", onStderrData);
          forcedExitCode = 0;
          terminateChild();
        }, AGENT_END_GRACE_MS);
        semanticCompletionTimer.unref();
      };

      const onStdoutData = (chunk: Buffer) => {
        resetInactivityTimeout();
        buffer += stdoutDecoder.write(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
        if (Buffer.byteLength(buffer, "utf8") > MAX_JSON_LINE_BYTES) {
          flushLine(buffer);
          buffer = "";
        }
      };

      const onStderrData = (chunk: Buffer) => {
        appendStderr(stderrDecoder.write(chunk));
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      proc.on("close", (code, signalName) => {
        didClose = true;
        buffer += stdoutDecoder.end();
        const stderrRemainder = stderrDecoder.end();
        if (stderrRemainder) appendStderr(stderrRemainder);
        if (buffer.trim()) flushBufferedLines(buffer);

        const signalFailure = getUnexpectedSignalFailure(
          code,
          signalName,
          wasAborted,
          forcedExitCode,
        );
        if (signalFailure && !settled) {
          recordProcessFailure(signalFailure.message);
          forcedExitCode = signalFailure.exitCode;
          terminateChild();
        }

        if (terminationStarted && !isWindows && isProcessGroupAlive()) {
          return;
        }
        finish(code ?? signalFailure?.exitCode ?? 1);
      });

      proc.on("error", (err) => {
        recordProcessFailure(err.message);
        finish(1);
      });

      // Abort handling.
      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    const completed = normalizeCompletedResult(result, wasAborted);
    if (stopRequestedReason !== undefined) {
      // A run stopped by request ends "stopped" with its partial output
      // preserved, whether the child heeded the wrap-up or was terminated.
      return markStoppedResult(completed, stopRequestedReason);
    }
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.exitCode = 1;
    result.processError = true;
    result.stopReason = "error";
    result.errorMessage = message;
    if (!result.stderr.trim()) result.stderr = message;
    const failed = normalizeCompletedResult(result, wasAborted);
    if (stopRequestedReason !== undefined) return markStoppedResult(failed, stopRequestedReason);
    return failed;
  } finally {
    cleanupTempDir(promptTmpDir);
    cleanupTempDir(parentSessionTmpDir);
    // The ask directory outlives the child only until the run ends; the hub's
    // watch was already stopped, so no reply can arrive for a dead child.
    cleanupTempDir(askDir);
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapConcurrent<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
