import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  DEFAULT_LANDING_POLICY,
  GH_ENV,
  PATCH_DIR_NAME,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_DIR_NAME,
  applyWorktreeLanding,
  materializeWorktrees,
  patchFileForJob,
  planWorktrees,
  removeWorktree,
  resolveGhCommand,
  worktreeBranchForJob,
  worktreePathForJob,
} from "../worktrees.ts";
import { JobRegistry } from "../jobs.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fakeGh = path.join(root, "test", "fixtures", "fake-gh.mjs");

const jiti = createJiti(import.meta.url);
const { default: registerSubagentExtension, normalizeCalls } = await jiti.import("../index.ts");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createPiHarness() {
  const handlers = new Map();
  const tools = new Map();
  const flags = new Map();
  const entries = [];
  const pi = {
    registerFlag(name, definition) {
      flags.set(name, definition);
    },
    getFlag() {
      return undefined;
    },
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
  registerSubagentExtension(pi);
  return { handlers, tools, flags, entries };
}

function createContext(cwd) {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => false,
    ui: { notify() {} },
    sessionManager: {
      getHeader: () => ({ type: "session", version: 3, id: "parent", cwd }),
      getBranch: () => [],
      getSessionId: () => "parent-session",
      getSessionDir: () => path.join(cwd, ".sessions"),
      getSessionFile: () => undefined,
    },
  };
}

// A real temporary git repository for direct worktrees.ts exercises.
function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-wt-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  run(repo, ["init", "-q"]);
  run(repo, ["config", "user.name", "Test"]);
  run(repo, ["config", "user.email", "test@example.invalid"]);
  run(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "hello.txt"), "hello\n");
  run(repo, ["add", "-A"]);
  run(repo, ["commit", "-qm", "initial"]);
  return { dir, repo, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function worktreeList(repo) {
  return run(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function branches(repo, pattern) {
  return run(repo, ["branch", "--list", pattern])
    .split("\n")
    .map((line) => line.trim().replace(/^[*+] /, ""))
    .filter(Boolean);
}

function normalized(p) {
  return path.resolve(p).replace(/\\/g, "/");
}

async function commitInWorktree(plan, message, file) {
  fs.writeFileSync(path.join(plan.path, file), "child work\n");
  run(plan.path, ["add", "-A"]);
  run(plan.path, ["commit", "-qm", message]);
}

async function materialize(jobId, cwd, landing) {
  const planned = await planWorktrees([{ callIndex: 0, jobId, cwd, landing }]);
  assert.equal(planned.error, undefined);
  const materialized = await materializeWorktrees(planned.plans);
  assert.equal(materialized.error, undefined);
  return planned.plans[0];
}

function landingInfo(plan, overrides = {}) {
  return {
    jobId: plan.jobId,
    agent: "review",
    status: "done",
    prompt: "P",
    childSessionId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema and normalization
// ---------------------------------------------------------------------------

test("Agent schema exposes worktree and landing fields", () => {
  const schema = createPiHarness().tools.get("Agent").parameters;
  const item = schema.properties.calls.items.properties;

  assert.equal(item.worktree.type, "boolean");
  assert.equal(item.worktree.anyOf, undefined);
  assert.equal(schema.properties.calls.items.required.includes("worktree"), false);
  assert.match(item.worktree.description, /isolated git worktree/);

  assert.equal(item.landing.type, "string");
  assert.deepEqual(item.landing.enum, ["keep", "patch", "pr"]);
  assert.equal(item.landing.anyOf, undefined);
  assert.equal(item.landing.oneOf, undefined);
  assert.equal(schema.properties.calls.items.required.includes("landing"), false);
  assert.match(item.landing.description, /removes the worktree/);
});

test("normalizeCalls accepts worktree and landing with a keep default", () => {
  const result = normalizeCalls([
    { agent: "review", prompt: "P", worktree: true },
    { agent: "review", prompt: "P", worktree: true, landing: "pr" },
    { agent: "review", prompt: "P", worktree: false },
  ], process.cwd());

  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls.map((call) => call.worktree), [true, true, false]);
  assert.deepEqual(result.calls.map((call) => call.landing), ["keep", "pr", undefined]);
});

test("normalizeCalls rejects invalid worktree and landing values before any spawn", () => {
  const cases = [
    { agent: "a", prompt: "P", worktree: "yes" },
    { agent: "a", prompt: "P", worktree: 1 },
    { agent: "a", prompt: "P", landing: "patch" },
    { agent: "a", prompt: "P", landing: "rebase" },
    { agent: "a", prompt: "P", worktree: true, landing: "rebase" },
  ];
  for (const [index, call] of cases.entries()) {
    const result = normalizeCalls([call], process.cwd());
    assert.ok(result.error, `case ${index} rejected`);
    assert.equal(result.calls, undefined);
  }
  assert.match(
    normalizeCalls([{ agent: "a", prompt: "P", landing: "rebase" }], process.cwd()).error,
    /landing must be one of: keep, patch, pr/,
  );
  assert.match(
    normalizeCalls([{ agent: "a", prompt: "P", landing: "patch" }], process.cwd()).error,
    /landing requires worktree: true/,
  );
});

test("worktree call in a non-git directory fails the tool result without running a child", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-nogit-"));
  const projectDir = path.join(tmpDir, "plain");
  fs.mkdirSync(projectDir);
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "config");

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir);
    const result = await harness.tools.get("Agent").execute(
      "nogit",
      { calls: [{ agent: "review", prompt: "P", worktree: true }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.failed, true);
    assert.equal(result.details.results.length, 0, "no job is registered for an unplannable worktree call");
    assert.match(result.content[0].text, /requires a git repository/);
    assert.deepEqual(harness.entries, []);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// worktrees module against real temporary git repositories
// ---------------------------------------------------------------------------

test("worktree conventions: branch, directory, and patch file are deterministic", () => {
  const jobId = "job-001122334455";
  assert.equal(worktreeBranchForJob(jobId), "pi-subagent/job-001122334455");
  assert.equal(
    worktreePathForJob(jobId),
    path.join(fs.realpathSync(os.tmpdir()), WORKTREE_DIR_NAME, jobId),
  );
  assert.equal(
    patchFileForJob("/repo", jobId),
    path.join("/repo", PATCH_DIR_NAME, `${jobId}.patch`),
  );
  assert.equal(WORKTREE_BRANCH_PREFIX, "pi-subagent/");
  assert.equal(DEFAULT_LANDING_POLICY, "keep");
});

test("resolveGhCommand honors the PI_SUBAGENT_GH process seam", () => {
  assert.deepEqual(resolveGhCommand({}), { command: "gh", prefixArgs: [] });
  assert.deepEqual(resolveGhCommand({ [GH_ENV]: "  " }), { command: "gh", prefixArgs: [] });
  assert.deepEqual(
    resolveGhCommand({ [GH_ENV]: fakeGh }),
    { command: process.execPath, prefixArgs: [path.resolve(fakeGh)] },
  );
  assert.deepEqual(
    resolveGhCommand({ [GH_ENV]: "C:/tools/gh.exe" }),
    { command: "C:/tools/gh.exe", prefixArgs: [] },
  );
});

test("plan and materialize a worktree on a dedicated branch", async () => {
  const { repo, cleanup } = createTempRepo();
  let worktreeDir = null;
  try {
    const registry = new JobRegistry();
    const jobId = registry.reserveJobId();
    const plan = await materialize(jobId, repo, "keep");
    worktreeDir = plan.path;

    assert.equal(plan.branch, `pi-subagent/${jobId}`);
    assert.equal(plan.path, worktreePathForJob(jobId));
    assert.equal(normalized(plan.repoRoot), normalized(fs.realpathSync(repo)));
    assert.ok(fs.statSync(plan.path).isDirectory());
    assert.ok(worktreeList(repo).some((entry) => entry.endsWith(`/${jobId}`)));
    assert.deepEqual(branches(repo, `${WORKTREE_BRANCH_PREFIX}*`), [plan.branch]);
  } finally {
    if (worktreeDir) fs.rmSync(worktreeDir, { recursive: true, force: true });
    cleanup();
  }
});

test("planWorktrees rejects a cwd outside any git repository", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-wt-"));
  try {
    const planned = await planWorktrees([{ callIndex: 0, jobId: "job-x", cwd: tmpDir, landing: "keep" }]);
    assert.match(planned.error, /requires a git repository/);
    assert.equal(planned.plans, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("keep landing leaves the branch and worktree in place", async () => {
  const { repo, cleanup } = createTempRepo();
  try {
    const plan = await materialize("job-keep00000001", repo, "keep");
    await commitInWorktree(plan, "child work", "work.txt");

    const report = await applyWorktreeLanding(plan, landingInfo(plan));

    assert.equal(report.policy, "keep");
    assert.equal(report.worktreeRemoved, false);
    assert.ok(fs.existsSync(path.join(plan.path, "work.txt")), "worktree content survives");
    assert.deepEqual(branches(repo, `${WORKTREE_BRANCH_PREFIX}*`), [plan.branch]);
    assert.ok(worktreeList(repo).length >= 2);
  } finally {
    cleanup();
  }
});

test("patch landing writes the patch file and removes the worktree, keeping the branch", async () => {
  const { repo, cleanup } = createTempRepo();
  try {
    const plan = await materialize("job-patch000001", repo, "patch");
    await commitInWorktree(plan, "child work", "work.txt");

    const report = await applyWorktreeLanding(plan, landingInfo(plan));

    assert.equal(report.policy, "patch");
    assert.equal(report.worktreeRemoved, true);
    assert.equal(report.patchFile, patchFileForJob(repo, plan.jobId));
    assert.equal(report.note, undefined);

    const patch = fs.readFileSync(report.patchFile, "utf8");
    assert.match(patch, /diff --git/);
    assert.match(patch, /work\.txt/);
    assert.match(patch, /\+child work/);
    assert.equal(fs.existsSync(plan.path), false, "worktree removed");
    assert.equal(worktreeList(repo).length, 1, "only the main worktree remains");
    assert.deepEqual(branches(repo, `${WORKTREE_BRANCH_PREFIX}*`), [plan.branch], "branch kept");

    // Removing an already-removed worktree is an idempotent no-op.
    assert.equal(await removeWorktree(plan), true);
    assert.equal(worktreeList(repo).length, 1);
  } finally {
    cleanup();
  }
});

test("patch landing captures uncommitted work left in the worktree", async () => {
  const { repo, cleanup } = createTempRepo();
  try {
    const plan = await materialize("job-patch000002", repo, "patch");
    fs.appendFileSync(path.join(plan.path, "hello.txt"), "uncommitted work\n");
    fs.writeFileSync(path.join(plan.path, "staged.txt"), "staged work\n");
    run(plan.path, ["add", "staged.txt"]);

    const report = await applyWorktreeLanding(plan, landingInfo(plan, { status: "failed" }));

    assert.equal(report.worktreeRemoved, true);
    const patch = fs.readFileSync(report.patchFile, "utf8");
    assert.match(patch, /\+uncommitted work/);
    assert.match(patch, /staged\.txt/);
    assert.match(patch, /\+staged work/);
  } finally {
    cleanup();
  }
});

test("pr landing pushes the branch, opens a PR through the faked gh seam, and removes the worktree", async () => {
  const { dir, repo, cleanup } = createTempRepo();
  const bare = path.join(dir, "remote.git");
  run(dir, ["init", "--bare", "-q", bare]);
  run(repo, ["remote", "add", "origin", bare]);
  const base = run(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const ghLog = path.join(dir, "ghlog.jsonl");
  const previousGh = process.env[GH_ENV];
  const previousGhLog = process.env.FAKE_GH_LOG;
  process.env[GH_ENV] = fakeGh;
  process.env.FAKE_GH_LOG = ghLog;

  try {
    const plan = await materialize("job-pr00000001", repo, "pr");
    await commitInWorktree(plan, "child work", "work.txt");

    const report = await applyWorktreeLanding(plan, landingInfo(plan, { prompt: "Implement the thing." }));

    assert.equal(report.policy, "pr");
    assert.equal(report.prUrl, "https://pr.example.invalid/pi-subagent-fake-pr");
    assert.equal(report.worktreeRemoved, true);
    assert.equal(fs.existsSync(plan.path), false);
    assert.deepEqual(branches(repo, `${WORKTREE_BRANCH_PREFIX}*`), [plan.branch]);

    // The branch was really pushed to the (local bare) remote.
    assert.deepEqual(branches(bare, `${WORKTREE_BRANCH_PREFIX}*`), [plan.branch]);

    // The gh invocation ran at the process seam with the expected arguments.
    const records = fs.readFileSync(ghLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    const [record] = records;
    assert.deepEqual(record.args.slice(0, 2), ["pr", "create"]);
    assert.equal(record.args[record.args.indexOf("--head") + 1], plan.branch);
    assert.equal(record.args[record.args.indexOf("--base") + 1], base);
    const title = record.args[record.args.indexOf("--title") + 1];
    assert.match(title, new RegExp(`pi-subagent ${plan.jobId}: review`));
    const body = record.args[record.args.indexOf("--body") + 1];
    assert.match(body, new RegExp(`job ${plan.jobId}`));
    assert.match(body, /agent: review/);
    assert.match(body, /Implement the thing\./);
    assert.equal(record.cwd.replace(/\\/g, "/"), normalized(repo));
  } finally {
    if (previousGh === undefined) delete process.env[GH_ENV];
    else process.env[GH_ENV] = previousGh;
    if (previousGhLog === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = previousGhLog;
    cleanup();
  }
});

test("pr landing without a remote keeps the worktree and reports the failure", async () => {
  const { repo, cleanup } = createTempRepo();
  const previousGh = process.env[GH_ENV];
  process.env[GH_ENV] = fakeGh;
  try {
    const plan = await materialize("job-pr00000002", repo, "pr");
    await commitInWorktree(plan, "child work", "work.txt");

    const report = await applyWorktreeLanding(plan, landingInfo(plan));

    assert.equal(report.prUrl, undefined);
    assert.equal(report.worktreeRemoved, false);
    assert.match(report.note, /git push failed/);
    assert.ok(fs.existsSync(plan.path), "worktree kept so the work is recoverable");
  } finally {
    if (previousGh === undefined) delete process.env[GH_ENV];
    else process.env[GH_ENV] = previousGh;
    fs.rmSync(worktreePathForJob("job-pr00000002"), { recursive: true, force: true });
    cleanup();
  }
});

test("jobs registry reuses reserved ids and records the worktree branch", () => {
  const registry = new JobRegistry();
  const reserved = registry.reserveJobId();
  const job = registry.create({
    id: reserved,
    agent: "review",
    cwd: "/tmp",
    worktree: `pi-subagent/${reserved}`,
  });

  assert.equal(job.id, reserved);
  assert.equal(job.worktree, `pi-subagent/${reserved}`);
  assert.equal(registry.get(reserved).id, reserved);
  assert.notEqual(registry.reserveJobId(), reserved);

  const plain = registry.create({ agent: "explore", cwd: "/tmp" });
  assert.equal(plain.worktree, undefined);
  assert.notEqual(plain.id, reserved);
});

// ---------------------------------------------------------------------------
// /implement-spec prompt template
// ---------------------------------------------------------------------------

test("/implement-spec prompt template ships with package wiring and full instructions", () => {
  const templatePath = path.join(root, "prompts", "implement-spec.md");
  const content = fs.readFileSync(templatePath, "utf8").replace(/\r\n/g, "\n");

  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "template has frontmatter");
  const frontmatter = match[1];
  assert.match(frontmatter, /description: Split a spec into tasks/);
  assert.match(frontmatter, /argument-hint: <spec-file-or-text> \[landing\]/);

  const body = content.slice(match[0].length);
  assert.match(body, /\$\{1:-/);
  assert.match(body, /`Agent` tool invocation/);
  assert.match(body, /"worktree":\s*true/);
  assert.match(body, /"landing":\s*"<landing policy>"/);
  assert.match(body, /pi-subagent\/<job-id>/);
  assert.match(body, /subagent_status/);
  assert.match(body, /subagent_result/);
  assert.match(body, /landing status/);
  assert.match(body, /commit its changes/);

  // Package wiring: Pi discovers the template and npm ships it.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.prompts, ["./prompts/*.md"]);
  assert.ok(pkg.files.includes("prompts/*.md"));
  assert.ok(pkg.files.includes("worktrees.ts"));
});
