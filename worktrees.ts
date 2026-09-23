/**
 * Git worktree management for delegated subagent runs.
 *
 * A call with `worktree: true` runs its child in an isolated git worktree on
 * a dedicated branch, so parallel implementation jobs never conflict. This
 * module owns the git plumbing and the landing policies:
 *
 * - Plan: resolve the repository root and base branch for a call's cwd.
 * - Materialize: `git worktree add <path> -b <branch>`.
 * - Land: `keep` (default) leaves the branch and worktree for review,
 *   `patch` writes a patch file and removes the worktree, `pr` pushes the
 *   branch, opens a PR via `gh`, then removes the worktree.
 * - Remove: idempotent `git worktree remove` with force and filesystem
 *   fallbacks, followed by `git worktree prune`.
 *
 * Conventions (documented in README):
 * - Branch: `pi-subagent/<job-id>`
 * - Worktree directory: `<realpath(os.tmpdir())>/pi-subagent-worktrees/<job-id>`
 *   — deliberately outside any repository the user cares about.
 * - Patch file: `<repo-root>/.pi-subagent-patches/<job-id>.patch`
 *
 * Branches are never deleted by landing: `patch` and `pr` remove only the
 * worktree; the branch survives for review or merging.
 *
 * The `gh` command is fakeable at the process seam: set `PI_SUBAGENT_GH` to
 * an executable path, or to a JavaScript file which then runs under the
 * current Node executable. Unset, the plain `gh` command from PATH is used.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** What happens to a worktree job when it terminates. */
export type LandingPolicy = "keep" | "patch" | "pr";

export const DEFAULT_LANDING_POLICY: LandingPolicy = "keep";

/** Every worktree branch starts with this prefix. */
export const WORKTREE_BRANCH_PREFIX = "pi-subagent/";

/** Directory (under the system temp dir) holding all job worktrees. */
export const WORKTREE_DIR_NAME = "pi-subagent-worktrees";

/** Directory (under the repository root) holding landing patch files. */
export const PATCH_DIR_NAME = ".pi-subagent-patches";

/** Environment variable overriding the `gh` command for PR landing. */
export const GH_ENV = "PI_SUBAGENT_GH";

const GIT_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 32 * 1024 * 1024;
const REMOVE_RETRY_DELAY_MS = 250;
const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export interface ProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (isWindows) {
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" }).unref();
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* best-effort */
    }
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      killProcessTree(proc.pid);
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    timer.unref();

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr, truncated });
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_PROCESS_OUTPUT_BYTES);
        truncated = true;
        killProcessTree(proc.pid);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < 64 * 1024) {
        stderr += chunk.toString("utf8");
      }
    });
    proc.on("error", (error) => {
      if (!stderr.trim()) stderr = error.message;
      finish(false);
    });
    proc.on("close", (code) => finish(code === 0));
  });
}

function runGit(dir: string, args: string[]): Promise<ProcessResult> {
  // `dir` is the directory git runs in: the repository root for repo-wide
  // operations, or the job worktree for working-tree diffs.
  return runCommand("git", ["-C", dir, ...args], { cwd: dir });
}

/**
 * Resolve the `gh` command from the environment seam. `PI_SUBAGENT_GH` may be
 * an executable path (spawned directly) or a JavaScript file (run under the
 * current Node executable, which keeps the seam fakeable on every platform).
 */
export function resolveGhCommand(
  env: NodeJS.ProcessEnv = process.env,
): { command: string; prefixArgs: string[] } {
  const raw = env[GH_ENV]?.trim();
  if (!raw) return { command: "gh", prefixArgs: [] };
  if (/\.(js|mjs|cjs)$/i.test(raw)) {
    return { command: process.execPath, prefixArgs: [path.resolve(raw)] };
  }
  return { command: raw, prefixArgs: [] };
}

function runGh(args: string[], cwd: string): Promise<ProcessResult> {
  const { command, prefixArgs } = resolveGhCommand();
  return runCommand(command, [...prefixArgs, ...args], { cwd, timeoutMs: GH_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Path and branch conventions
// ---------------------------------------------------------------------------

/** Root directory holding all job worktrees, under the canonical temp dir. */
export function worktreesRoot(): string {
  try {
    return path.join(fs.realpathSync(os.tmpdir()), WORKTREE_DIR_NAME);
  } catch {
    return path.join(os.tmpdir(), WORKTREE_DIR_NAME);
  }
}

/** Branch name for a job: `pi-subagent/<job-id>`. */
export function worktreeBranchForJob(jobId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${jobId}`;
}

/** Worktree directory for a job: `<tmp>/pi-subagent-worktrees/<job-id>`. */
export function worktreePathForJob(jobId: string): string {
  return path.join(worktreesRoot(), jobId);
}

/** Patch file path for a job: `<repo-root>/.pi-subagent-patches/<job-id>.patch`. */
export function patchFileForJob(repoRoot: string, jobId: string): string {
  return path.join(repoRoot, PATCH_DIR_NAME, `${jobId}.patch`);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** A planned or materialized worktree for one call. */
export interface WorktreePlan {
  /** Index of the call in the tool invocation. */
  callIndex: number;
  /** Reserved job id; names the branch and the worktree directory. */
  jobId: string;
  /** Branch created for the job: `pi-subagent/<job-id>`. */
  branch: string;
  /** Absolute worktree directory path. */
  path: string;
  /** Repository root the worktree was created from. */
  repoRoot: string;
  /** Branch HEAD was on at creation time; undefined when detached. */
  baseBranch?: string;
  /** Commit the worktree branch started from. */
  baseCommit?: string;
  /** Landing policy applied when the job terminates. */
  landing: LandingPolicy;
  /** True once `git worktree add` succeeded. */
  created: boolean;
}

export interface WorktreePlanInput {
  callIndex: number;
  jobId: string;
  cwd: string;
  landing: LandingPolicy;
}

/** Resolve the repository root containing `cwd`, or null when not a git repo. */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  const result = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const top = result.stdout.trim();
  return result.ok && top ? top : null;
}

async function captureBase(repoRoot: string): Promise<{ baseBranch?: string; baseCommit?: string }> {
  const [ref, sha] = await Promise.all([
    runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(repoRoot, ["rev-parse", "HEAD"]),
  ]);
  const refName = ref.stdout.trim();
  return {
    baseBranch: ref.ok && refName && refName !== "HEAD" ? refName : undefined,
    baseCommit: sha.ok ? sha.stdout.trim() : undefined,
  };
}

/**
 * Plan worktrees for the given calls. Planning resolves the repository and
 * base branch (deduplicated by cwd) and computes the deterministic worktree
 * path and branch, but performs no writes: the caller overrides each call's
 * effective cwd with the planned path before session identities are derived,
 * and materializes the worktrees only after all guards pass.
 */
export async function planWorktrees(
  inputs: WorktreePlanInput[],
): Promise<{ plans?: WorktreePlan[]; error?: string }> {
  const plans: WorktreePlan[] = [];
  const reposByCwd = new Map<string, { repoRoot: string; baseBranch?: string; baseCommit?: string }>();

  for (const input of inputs) {
    let repo = reposByCwd.get(input.cwd);
    if (!repo) {
      const repoRoot = await resolveRepoRoot(input.cwd);
      if (!repoRoot) {
        return {
          error: `calls[${input.callIndex}].worktree requires a git repository at ${input.cwd}.`,
        };
      }
      repo = { repoRoot, ...(await captureBase(repoRoot)) };
      reposByCwd.set(input.cwd, repo);
    }

    plans.push({
      callIndex: input.callIndex,
      jobId: input.jobId,
      branch: worktreeBranchForJob(input.jobId),
      path: worktreePathForJob(input.jobId),
      repoRoot: repo.repoRoot,
      baseBranch: repo.baseBranch,
      baseCommit: repo.baseCommit,
      landing: input.landing,
      created: false,
    });
  }

  return { plans };
}

// ---------------------------------------------------------------------------
// Materialization and removal
// ---------------------------------------------------------------------------

/** List registered worktree paths (forward slashes, as git prints them). */
async function registeredWorktreePaths(repoRoot: string): Promise<string[]> {
  const result = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .map((entry) => entry.replace(/\\/g, "/"));
}

/**
 * Create the planned worktrees with `git worktree add`; rolls back on failure.
 * A stale unregistered directory at the planned path (left by a crashed run)
 * is swept first — job ids are random, so the path is ours by construction.
 */
export async function materializeWorktrees(plans: WorktreePlan[]): Promise<{ error?: string }> {
  const created: WorktreePlan[] = [];
  for (const plan of plans) {
    try {
      fs.mkdirSync(path.dirname(plan.path), { recursive: true });
      if (fs.existsSync(plan.path)) {
        const registered = await registeredWorktreePaths(plan.repoRoot);
        const target = plan.path.replace(/\\/g, "/");
        if (!registered.includes(target)) {
          fs.rmSync(plan.path, { recursive: true, force: true });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await rollbackWorktrees(created);
      return { error: `Failed to create git worktree directory for ${plan.branch}: ${message}` };
    }
    const result = await runGit(plan.repoRoot, ["worktree", "add", plan.path, "-b", plan.branch]);
    if (!result.ok) {
      await rollbackWorktrees(created);
      const detail = (result.stderr || result.stdout).trim();
      return {
        error: `Failed to create git worktree ${plan.branch} at ${plan.path}${detail ? `: ${detail}` : ""}`,
      };
    }
    plan.created = true;
    created.push(plan);
  }
  return {};
}

/** Remove an already-removed or never-created worktree without touching branches. */
export async function removeWorktree(plan: WorktreePlan): Promise<boolean> {
  if (!fs.existsSync(plan.path)) {
    await runGit(plan.repoRoot, ["worktree", "prune"]);
    return true;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let result = await runGit(plan.repoRoot, ["worktree", "remove", plan.path]);
    if (!result.ok) {
      result = await runGit(plan.repoRoot, ["worktree", "remove", "--force", plan.path]);
    }
    if (!result.ok && fs.existsSync(plan.path)) {
      try {
        fs.rmSync(plan.path, { recursive: true, force: true });
      } catch {
        /* best-effort; retry or leave the directory to the OS temp lifecycle */
      }
    }
    if (!fs.existsSync(plan.path)) break;
    await sleep(REMOVE_RETRY_DELAY_MS);
  }

  await runGit(plan.repoRoot, ["worktree", "prune"]);
  return !fs.existsSync(plan.path);
}

/**
 * Roll back worktrees created for calls that never ran (worktree creation
 * failure or pre-execution rejection). Branches were just created from HEAD
 * with no child work, so deleting them discards nothing.
 */
export async function rollbackWorktrees(plans: WorktreePlan[]): Promise<void> {
  for (const plan of plans) {
    if (!plan.created) continue;
    await removeWorktree(plan);
    await runGit(plan.repoRoot, ["branch", "-D", plan.branch]);
    plan.created = false;
  }
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

/** Job context referenced by landing reports and PR bodies. */
export interface LandingInfo {
  jobId: string;
  agent: string;
  status: string;
  prompt: string;
  childSessionId: string | null;
}

/** Machine-readable landing outcome, embedded in the call's result. */
export interface LandingReport {
  policy: LandingPolicy;
  branch: string;
  worktreePath: string;
  worktreeRemoved: boolean;
  patchFile?: string;
  prUrl?: string;
  note?: string;
}

function truncatePrompt(prompt: string): string {
  const capped = prompt.length > 2000 ? `${prompt.slice(0, 2000)}\n[prompt truncated]` : prompt;
  return capped;
}

async function resolveMergeBase(plan: WorktreePlan): Promise<string | null> {
  if (!plan.baseCommit) return null;
  const result = await runGit(plan.repoRoot, ["merge-base", plan.baseCommit, plan.branch]);
  const base = result.stdout.trim();
  return result.ok && base ? base : plan.baseCommit;
}

async function writePatch(plan: WorktreePlan): Promise<{ patchFile?: string; note?: string }> {
  const mergeBase = await resolveMergeBase(plan);
  if (!mergeBase) {
    return { note: "Patch landing could not resolve a merge base with the parent branch." };
  }
  // Run the diff inside the worktree so uncommitted tracked changes are
  // captured alongside committed work. Untracked files are not included.
  const diff = await runGit(plan.path, ["diff", "--binary", mergeBase]);
  if (!diff.ok) {
    const detail = (diff.stderr || diff.stdout).trim();
    return { note: `Patch landing failed to diff ${plan.branch}: ${detail || "git diff failed"}` };
  }
  try {
    const patchFile = patchFileForJob(plan.repoRoot, plan.jobId);
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, diff.stdout, "utf8");
    return diff.truncated
      ? { patchFile, note: "Patch diff exceeded the capture limit and was truncated." }
      : { patchFile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { note: `Patch landing failed to write the patch file: ${message}` };
  }
}

async function openPullRequest(
  plan: WorktreePlan,
  info: LandingInfo,
): Promise<{ prUrl?: string; note?: string }> {
  const push = await runGit(plan.repoRoot, ["push", "-u", "origin", plan.branch]);
  if (!push.ok) {
    const detail = (push.stderr || push.stdout).trim();
    return { note: `PR landing skipped because git push failed: ${detail || "push failed"}` };
  }

  const title = `pi-subagent ${plan.jobId}: ${info.agent}`;
  const body = [
    `Created by pi-subagent job ${plan.jobId} (agent: ${info.agent}, status: ${info.status}).`,
    info.childSessionId ? `Child Pi session: ${info.childSessionId}` : null,
    `Base: ${plan.baseBranch ?? plan.baseCommit ?? "repository default branch"}.`,
    `Prompt:\n\n${truncatePrompt(info.prompt)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const args = ["pr", "create", "--head", plan.branch, "--title", title, "--body", body];
  if (plan.baseBranch) args.push("--base", plan.baseBranch);

  const gh = await runGh(args, plan.repoRoot);
  if (!gh.ok) {
    const detail = (gh.stderr || gh.stdout).trim();
    return { note: `PR landing failed: gh pr create failed: ${detail || "gh failed"}` };
  }
  const lines = gh.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const prUrl = lines.at(-1);
  return prUrl ? { prUrl } : { note: "PR landing succeeded but gh printed no PR URL." };
}

/**
 * Apply the landing policy after a job terminates (success, failure, or
 * stop). Never throws: landing failures are reported as notes and leave the
 * worktree in place so the work is not lost.
 */
export async function applyWorktreeLanding(
  plan: WorktreePlan,
  info: LandingInfo,
): Promise<LandingReport> {
  const base: Omit<LandingReport, "worktreeRemoved"> = {
    policy: plan.landing,
    branch: plan.branch,
    worktreePath: plan.path,
  };

  if (plan.landing === "keep") {
    return { ...base, worktreeRemoved: false };
  }

  if (plan.landing === "patch") {
    const { patchFile, note } = await writePatch(plan);
    // On a patch failure keep the worktree so the work is recoverable.
    if (note && !patchFile) return { ...base, worktreeRemoved: false, note };
    const worktreeRemoved = await removeWorktree(plan);
    return { ...base, worktreeRemoved, ...(patchFile ? { patchFile } : {}), ...(note ? { note } : {}) };
  }

  const { prUrl, note } = await openPullRequest(plan, info);
  if (!prUrl) {
    return { ...base, worktreeRemoved: false, ...(note ? { note } : {}) };
  }
  const worktreeRemoved = await removeWorktree(plan);
  return { ...base, worktreeRemoved, prUrl };
}
