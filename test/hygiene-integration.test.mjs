import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const rpcEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const cliEntry = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const customType = "pi-subagent:delegation";
const provider = path.join(root, "test/fixtures/delegation-provider.ts");
const helper = path.join(root, "delegation-metadata.ts");

function jsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertJobId(job) {
  assert.ok(job, "every executed call is tracked as a job");
  assert.match(job.id, /^job-[0-9a-f]{12}$/);
}

function childCall(tag, options = {}) {
  return { agent: "worker", prompt: JSON.stringify({ tag }), timeout: 25, inactivityTimeout: 20, ...options };
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("");
  }
  return "";
}

/** The Agent tool result of a turn, without foreground-completion assumptions. */
function agentTool(event) {
  const tool = event.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(tool, "real Pi executed the production Agent tool");
  return tool;
}

function results(event) {
  const tool = event.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(tool, "real Pi executed the production Agent tool");
  assert.equal(tool.isError, false, JSON.stringify(tool));
  assert.notEqual(tool.details.failed, true, JSON.stringify(tool));
  for (const result of tool.details.results) {
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stopReason, "stop", JSON.stringify(result));
  }
  return tool.details.results;
}

/** Poll the observation log until a child's provider request appears. */
async function waitForObservation(fixture, tag, { lastRole = "user", timeoutMs = 30_000 } = {}) {
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

class Rpc {
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

function setup(t, { workerThinking, env: extraEnv } = {}) {
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
    start({ rootId = "delegation-test-root", thinking } = {}) {
      const client = new Rpc(cwd, env, [
        ...commonArgs(),
        ...(rootId !== "delegation-test-root" ? ["--session-id", rootId] : []),
        ...(thinking ? ["--thinking", thinking] : []),
      ]);
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
function runPrint(fixture, message) {
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

test("print mode reports still-running background jobs at exit", { timeout: 90_000 }, async (t) => {
  const fixture = setup(t);
  const plan = {
    tag: "print-bg",
    calls: [
      // A quick foreground sibling: the invocation waits for it to complete,
      // which gives the background child time to boot and start its task
      // before the print-mode session exits and cleanup wraps it up —
      // without it the wrap-up steer can land in the background child's very
      // first model call, replacing its task instead of interrupting it.
      childCall("print-fg", { prompt: JSON.stringify({ tag: "print-fg" }) }),
      // The background child delegates to a slow grandchild: its first turn
      // (the delegation tool call) completes and flushes its session file,
      // and it stays mid-run — waiting on the grandchild — when print mode
      // exits, so cleanup's wrap-up interrupts real work and the stopped
      // session is resumable with its progress on disk.
      childCall("print-bg-child", {
        background: true,
        session: "print-bg",
        timeout: 120,
        inactivityTimeout: 110,
        prompt: JSON.stringify({
          tag: "print-bg-child",
          calls: [childCall("print-bg-grandchild", {
            prompt: JSON.stringify({ tag: "print-bg-grandchild", delayMs: 15_000 }),
          })],
        }),
      }),
    ],
  };

  const { code, stdout, stderr } = await runPrint(fixture, JSON.stringify(plan));

  assert.equal(code, 0, `print mode exits cleanly\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(stdout, /fixture:print-bg/, "stdout stays the answer, not the report");
  assert.match(stderr, /pi-subagent: 1 background job\(s\) were still running when this print-mode session exited\./);
  assert.match(stderr, /Each was stopped \(wrap-up instruction, bounded grace, then process-tree termination\)\. Child sessions persist on disk and stay resumable\./);
  assert.match(stderr, /- job-[0-9a-f]{12} \(agent worker\): (stopped|still terminating at the exit deadline)/);
  assert.match(stderr, /session subagent\./);
  assert.match(stderr, /Resume a job's session by its session id with a new Agent call\./);

  // The still-running child's session file is persisted on disk for resume.
  const child = fixture.observation("print-bg-child");
  assert.ok(child.file, "the background child flushed a session file");
  assert.equal(fs.existsSync(child.file), true, "the child session file survives the print-mode exit");
});

test("session lifecycle events run bounded cleanup without breaking the session, twice", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();
  const parent = await rpc.command("get_state");

  // One named background child makes real progress (a note and a completed
  // grandchild delegation, both flushed to its session file), then stalls on
  // its follow-up model request — a live owned child at the lifecycle event.
  const turn = await rpc.prompt({
    tag: "shutdown-start",
    calls: [childCall("shutdown-child", {
      background: true,
      session: "shutdown",
      timeout: 120,
      inactivityTimeout: 110,
      prompt: JSON.stringify({
        tag: "shutdown-child",
        note: "progress before the session switch",
        hang: true,
        calls: [childCall("shutdown-grandchild", { agent: "leaf" })],
      }),
    })],
  });
  const [bg] = agentTool(turn).details.results;
  assertJobId(bg.job);
  assert.equal(bg.job.status, "running");
  assert.equal(bg.exitCode, -1);

  // The child is mid-run with its progress already persisted.
  await waitForObservation(fixture, "shutdown-child", { lastRole: "toolResult" });
  const child = fixture.observation("shutdown-child");
  assert.ok(child.file && fs.existsSync(child.file), "the running child flushed a session file");

  // The parent session records the job's lifecycle entries.
  const jobEntries = () => jsonl(parent.sessionFile)
    .filter((entry) => entry.type === "custom" && entry.customType === customType && entry.data.jobId === bg.job.id);
  assert.deepEqual(jobEntries().map((entry) => entry.data.status), ["running"]);

  // The lifecycle event: `new_session` tears the current session down
  // (session_shutdown) and binds a fresh one. Cleanup must stay bounded so
  // the command responds.
  let from = rpc.events.length;
  await rpc.command("new_session");
  assert.deepEqual(
    rpc.events.slice(from).filter((event) => event.type === "extension_error"),
    [],
    "no extension errors during shutdown cleanup",
  );

  // Cleanup is idempotent: a second lifecycle event is a no-op (nothing left
  // live in the freshly bound session) and never errors.
  from = rpc.events.length;
  await rpc.command("new_session");
  assert.deepEqual(
    rpc.events.slice(from).filter((event) => event.type === "extension_error"),
    [],
    "repeated cleanup is a no-op",
  );

  // The replaced session stays fully usable.
  const after = await rpc.prompt({ tag: "after-shutdown" });
  assert.match(messageText(after.messages.at(-1)), /fixture:after-shutdown/);

  // The running child's session file persists on disk for later resume.
  assert.equal(fs.existsSync(child.file), true, "shutdown cleanup never deletes child session files");
  assert.ok(
    jsonl(child.file).some((entry) => entry.type === "message" &&
      JSON.stringify(entry).includes("progress before the session switch")),
    "the persisted session carries the child's partial progress",
  );
});

test("aborting the parent invocation stops the foreground child and releases its session lock", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();

  // Start a turn whose only call is a foreground child that makes progress
  // (note + grandchild) and then stalls mid-run; the turn must not complete
  // before the abort.
  const from = rpc.events.length;
  await rpc.command("prompt", { message: JSON.stringify({
    tag: "abort-start",
    calls: [childCall("abort-child", {
      session: "abort",
      timeout: 120,
      inactivityTimeout: 110,
      prompt: JSON.stringify({
        tag: "abort-child",
        note: "progress before the abort",
        hang: true,
        calls: [childCall("abort-grandchild", { agent: "leaf" })],
      }),
    })],
  }) });

  // The child is live and mid-run: its follow-up model request is logged.
  const child = await waitForObservation(fixture, "abort-child", { lastRole: "toolResult" });

  // Abort the parent's current operation (Esc / Ctrl+C in interactive modes).
  await rpc.command("abort");

  const end = await rpc.wait((event) => event.type === "agent_end", from);
  await rpc.wait((event) => event.type === "agent_settled", from);

  // The aborted invocation records the child as stopped (terminal state):
  // the result surfaces as a tool error carrying the partial state, exactly
  // like any failed call, but the job's terminal status is "stopped".
  const tool = end.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(tool, "the aborted Agent call still produced a tool result");
  assert.equal(tool.isError, true, "an aborted foreground call surfaces as a tool error");
  const [aborted] = tool.details.results;
  assertJobId(aborted.job);
  assert.equal(aborted.job.status, "stopped", "the aborted child lands in a terminal state");
  assert.equal(aborted.exitCode, 130, JSON.stringify(aborted));
  assert.equal(aborted.stopReason, "aborted", JSON.stringify(aborted));
  assert.ok(aborted.session.id, "the aborted child's session identity is reported");

  // No stray child: the process is gone.
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "the child process exited");

  // The session lock was released: the same handle runs again immediately.
  const [resumed] = results(await rpc.prompt({
    tag: "abort-resume",
    calls: [childCall("abort-resume-child", { session: "abort" })],
  }));
  assert.equal(resumed.session.created, false);
  assert.equal(resumed.session.id, aborted.session.id);
  const lockRoot = path.join(fixture.sessionDir, ".pi-subagent-locks");
  assert.deepEqual(
    fs.readdirSync(lockRoot).filter((name) => name.endsWith(".lock")),
    [],
    "the aborted child's session lock was released",
  );

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("the per-run call cap rejects an oversized batch before any child spawns", { timeout: 120_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();

  const turn = await rpc.prompt({
    tag: "budget",
    calls: Array.from({ length: 9 }, (_unused, index) => childCall(`budget-child-${index}`)),
  });

  const tool = turn.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(tool, "the oversized Agent call produced a tool result");
  assert.equal(tool.isError, true, "the oversized batch is rejected as a tool error");
  assert.match(messageText(tool), /must not have more than 8 items/, "the rejection names the per-run cap");

  const childProcesses = fixture
    .processRecords()
    .filter((record) => record.kind === "process" && record.pid !== rpc.proc.pid);
  assert.deepEqual(
    childProcesses,
    [],
    "no child process was started for the rejected batch",
  );

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("excess background calls queue at the session-wide concurrency cap and drain in order", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t, { env: { PI_SUBAGENT_MAX_CONCURRENCY: "1" } });
  const rpc = fixture.start();

  // Two background calls in one invocation: the first is deliberately slow
  // (3.5s inside the provider), the second fast. With a concurrency cap of 1
  // the second must wait for the first to settle before its child spawns.
  const turn = await rpc.prompt({
    tag: "queue",
    calls: [
      childCall("queue-first", {
        background: true,
        session: "queue-first",
        prompt: JSON.stringify({ tag: "queue-first", delayMs: 3500 }),
      }),
      childCall("queue-second", {
        background: true,
        session: "queue-second",
        prompt: JSON.stringify({ tag: "queue-second" }),
      }),
    ],
  });
  const tool = turn.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(tool, "the Agent call produced a tool result");
  const [first, second] = tool.details.results;
  assert.ok(first.job && second.job, "both background jobs are registered");

  // Both jobs complete and deliver their summaries.
  const from = rpc.events.length;
  const firstSummary = await backgroundSummaryWait(rpc, from);
  assert.match(
    messageText(firstSummary.message),
    new RegExp(`^Background subagent job ${first.job.id} \\(worker\\) completed`),
  );
  const secondSummary = await backgroundSummaryWait(rpc, rpc.events.length);
  assert.match(
    messageText(secondSummary.message),
    new RegExp(`^Background subagent job ${second.job.id} \\(worker\\) completed`),
  );

  // FIFO evidence from the provider log: the queued child's only request
  // lands well after the first child's slow request started — impossible
  // without the gate, where both would start within ~1s of each other.
  const requests = jsonl(fixture.log).filter((record) => record.kind === "request");
  const firstRequest = requests.find((record) => record.tag === "queue-first");
  const secondRequest = requests.find((record) => record.tag === "queue-second");
  assert.ok(firstRequest && secondRequest, "both children made provider requests");
  assert.ok(
    secondRequest.timestamp - firstRequest.timestamp >= 3000,
    `the queued child started ${secondRequest.timestamp - firstRequest.timestamp}ms after the first (cap 1, delay 3.5s)`,
  );

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("the per-session job budget rejects further delegation before any child spawns", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t, { env: { PI_SUBAGENT_MAX_SESSION_JOBS: "2" } });
  const rpc = fixture.start();

  // Two foreground calls fill the session budget.
  const okTurn = await rpc.prompt({
    tag: "session-budget-ok",
    calls: [
      childCall("session-budget-1", { prompt: JSON.stringify({ tag: "session-budget-1" }) }),
      childCall("session-budget-2", { prompt: JSON.stringify({ tag: "session-budget-2" }) }),
    ],
  });
  const okTool = okTurn.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(okTool, "the budget-filling Agent call produced a tool result");
  assert.equal(okTool.isError, false, "the first two jobs run within the budget");
  assert.equal(
    fixture.processRecords().filter((record) => record.kind === "process" && record.pid !== rpc.proc.pid).length,
    2,
    "two children ran",
  );

  // The third call is rejected before spawning anything.
  const rejectedTurn = await rpc.prompt({
    tag: "session-budget-reject",
    calls: [childCall("session-budget-3", { prompt: JSON.stringify({ tag: "session-budget-3" }) })],
  });
  const rejectedTool = rejectedTurn.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "Agent",
  );
  assert.ok(rejectedTool, "the rejected Agent call produced a tool result");
  assert.equal(rejectedTool.isError, true, "the over-budget call is rejected as a tool error");
  const rejectedText = messageText(rejectedTool);
  assert.match(rejectedText, /Subagent session budget exceeded/);
  assert.match(rejectedText, /already created 2 subagent job\(s\)/);
  assert.match(rejectedText, /PI_SUBAGENT_MAX_SESSION_JOBS/);
  assert.equal(
    fixture.processRecords().filter((record) => record.kind === "process" && record.pid !== rpc.proc.pid).length,
    2,
    "no child process was started for the rejected call",
  );

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

/** Wait for a background job's injected summary to arrive as a queued user message. */
function backgroundSummaryWait(rpc, from) {
  return rpc.wait(
    (event) => event.type === "message_end" && event.message.role === "user" &&
      messageText(event.message).includes("Background subagent job"),
    from,
  );
}
