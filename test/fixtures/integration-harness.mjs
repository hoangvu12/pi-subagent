/**
 * Shared integration harness for the real-Pi delegation tests.
 *
 * Spawns real `pi` RPC processes against the deterministic delegation-test
 * provider fixture, in an isolated temp home/project/session layout, with an
 * allowlisted environment. Owns the process lifecycle: every spawned client is
 * closed and every runner child still alive after a failed assertion is
 * process-group-killed in the test's after hook, then the temp tree is
 * removed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const rpcEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const cliEntry = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const provider = path.join(root, "test/fixtures/delegation-provider.ts");
const helper = path.join(root, "delegation-metadata.ts");

/** Custom-entry type the delegation test fixtures write into session JSONL. */
export const customType = "pi-subagent:delegation";

export function jsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function assertJobId(job) {
  assert.ok(job, "every executed call is tracked as a job");
  assert.match(job.id, /^job-[0-9a-f]{12}$/);
}

export function childCall(tag, options = {}) {
  return { agent: "worker", prompt: JSON.stringify({ tag }), timeout: 25, inactivityTimeout: 20, ...options };
}

export function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("");
  }
  return "";
}

/** Poll the observation log until a child's provider request appears. */
export async function waitForObservation(fixture, tag, { lastRole = "user", timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const matches = jsonl(fixture.log).filter(
      (record) => record.kind === "request" && record.tag === tag && record.lastRole === lastRole,
    );
    if (matches.length > 0) return matches[0];
    if (Date.now() >= deadline) {
      throw new Error(`no provider request for ${tag} (lastRole ${lastRole}) within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export class Rpc {
  constructor(cwd, env, args, cli = false) {
    this.events = [];
    this.waiters = new Set();
    this.stderr = "";
    this.proc = spawn(process.execPath, [...(cli ? [cliEntry, "--mode", "rpc"] : [rpcEntry]), ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.closed = new Promise((resolve) => this.proc.once("close", (code, signal) => {
      this.exit = { code, signal };
      for (const waiter of this.waiters) waiter();
      resolve(this.exit);
    }));
    this.proc.on("error", (error) => { this.error = error; });
    this.proc.stdin.on("error", (error) => { this.error = error; });
    this.proc.stderr.setEncoding("utf8").on("data", (chunk) => { this.stderr += chunk; });
    let buffer = "";
    this.proc.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line)); }
        catch { this.error = new Error(`Non-JSON RPC output: ${line}`); }
      }
      for (const waiter of this.waiters) waiter();
    });
  }

  wait(predicate, from = 0, timeout = 40_000) {
    return new Promise((resolve, reject) => {
      const finish = (error, event) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error);
        else resolve(event);
      };
      const check = () => {
        const event = this.events.slice(from).find(predicate);
        if (event) return finish(null, event);
        if (this.error || this.exit) finish(new Error(`RPC exited/failed: ${this.error ?? JSON.stringify(this.exit)}\n${this.stderr}`));
      };
      const timer = setTimeout(() => finish(new Error(`RPC deadline exceeded\n${this.stderr}\n${JSON.stringify(this.events.slice(-3))}`)), timeout);
      this.waiters.add(check);
      check();
    });
  }

  async command(type, data = {}, timeout = 40_000) {
    const id = `${type}-${this.events.length}`;
    const from = this.events.length;
    this.proc.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    const response = await this.wait((event) => event.type === "response" && event.id === id, from, timeout);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }

  async prompt(plan) {
    const from = this.events.length;
    await this.command("prompt", { message: JSON.stringify(plan) });
    const end = await this.wait((event) => event.type === "agent_end", from);
    await this.wait((event) => event.type === "agent_settled", from);
    assert.deepEqual(this.events.slice(from).filter((event) => event.type === "extension_error"), []);
    const errors = end.messages.filter((message) => message.role === "assistant" && message.stopReason === "error");
    assert.deepEqual(errors, [], JSON.stringify(errors));
    return end;
  }

  async close() {
    if (!this.exit) {
      try { await this.command("abort", {}, 5000); } catch { /* Fall through to process cleanup. */ }
      this.proc.stdin.end();
      const timer = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
      await this.closed;
      clearTimeout(timer);
    }
  }
}

/**
 * Isolated integration environment for one test: temp home/project/session
 * tree, allowlisted environment, two fixture agents (worker, leaf), and the
 * observation log. Closes every spawned client and kills any runner child
 * still alive in the after hook, then removes the tree.
 */
export function setup(t, { workerThinking, stopGraceMs, env: extraEnv } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-integration-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  const sessionDir = path.join(dir, "sessions");
  const tmp = path.join(dir, "tmp");
  const log = path.join(dir, "observations.jsonl");
  for (const subdir of [cwd, agentDir, sessionDir, tmp, path.join(dir, "home"), path.join(agentDir, "agents")]) {
    fs.mkdirSync(subdir, { recursive: true });
  }
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  for (const agent of ["worker", "leaf"]) {
    const thinking = agent === "worker" && workerThinking ? `thinking: ${workerThinking}\n` : "";
    fs.writeFileSync(path.join(agentDir, "agents", `${agent}.md`), `---\nname: ${agent}\ndescription: Integration fixture\n${thinking}---\nUse the deterministic test provider.\n`);
  }
  // Allowlist rather than inherit API keys, auth locations, NODE_OPTIONS, or the harness's delegation guards.
  const env = {
    PATH: path.dirname(process.execPath),
    HOME: path.join(dir, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_SUBAGENT_MAX_DEPTH: "2",
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    DELEGATION_TEST_LOG: log,
    ...extraEnv,
  };
  if (stopGraceMs !== undefined) env.PI_SUBAGENT_STOP_GRACE_MS = String(stopGraceMs);
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  // Windows child termination uses `taskkill /T /F`, which lives in System32 —
  // absent from the bare node-only PATH the allowlist starts from. Real user
  // environments always have it; mirror that here so the extension's own
  // process-tree termination path is exercisable.
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.PATH = `${env.PATH}${path.delimiter}${path.join(process.env.SystemRoot, "System32")}`;
  }
  const clients = [];
  t.after(async () => {
    try {
      for (const client of clients) await client.close();
      // Runner children use separate process groups. Clean up any still running after a failed assertion/deadline.
      const records = jsonl(log);
      const exited = new Set(records.filter((record) => record.kind === "exit").map((record) => record.pid));
      const remaining = records.filter((record) => record.kind === "process" && !exited.has(record.pid));
      for (const { pid } of remaining) {
        try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const commonArgs = () => [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools",
    "--extension", provider,
    "--extension", path.join(root, "index.ts"),
    "--extension", helper,
    "--provider", "delegation-test", "--model", "deterministic",
    "--session-id", "delegation-test-root", "--session-dir", sessionDir,
  ];
  return {
    cwd, sessionDir, tmp, log, dir, env, commonArgs,
    start({ rootOnly = false, rootId = "delegation-test-root", launchPayload, thinking, model = "deterministic", cli = false } = {}) {
      const launchEnv = { ...env };
      if (launchPayload) launchEnv.PI_SUBAGENT_DELEGATION = JSON.stringify(launchPayload);
      const client = new Rpc(cwd, launchEnv, [
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools",
        "--extension", provider,
        "--extension", rootOnly ? path.join(root, "test/fixtures/delegation-root-only.ts") : path.join(root, "index.ts"),
        // Deliberately omit the helper in the root-only case: runner.ts must supply it.
        ...(rootOnly ? [] : ["--extension", helper]),
        "--provider", "delegation-test", "--model", model,
        ...(thinking ? ["--thinking", thinking] : []),
        "--session-id", rootId, "--session-dir", sessionDir,
      ], cli);
      clients.push(client);
      return client;
    },
    observation(tag) {
      const matches = jsonl(log).filter((record) => record.kind === "request" && record.tag === tag && record.lastRole === "user");
      assert.equal(matches.length, 1, `one real provider request for ${tag}`);
      return matches[0];
    },
    processRecords() {
      return jsonl(log).filter((record) => record.kind === "process" || record.kind === "exit");
    },
  };
}

/** Run the packaged CLI in print mode (`pi -p`) against the fixture provider. */
export function runPrint(fixture, message) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cliEntry, "--print", ...fixture.commonArgs(), message], {
      cwd: fixture.cwd,
      env: fixture.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    proc.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
