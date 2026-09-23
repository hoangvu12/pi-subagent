import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { JobRegistry } from "../jobs.ts";

const jiti = createJiti(import.meta.url);
const {
  collectJobResult,
  formatStatusListing,
} = await jiti.import("../companion.ts");
const {
  DEFAULT_STOP_GRACE_MS,
  STOP_GRACE_ENV,
  formatStopView,
  formatStopWrapUpInstruction,
  formatTimeoutWrapUpInstruction,
  resolveStopGraceMs,
} = await jiti.import("../stop.ts");
const {
  default: registerSubagentExtension,
} = await jiti.import("../index.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides = {}) {
  return {
    agent: "worker",
    agentSource: "user",
    prompt: "secret task text",
    initialContext: "empty",
    exitCode: 0,
    stopReason: "stop",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "final output text" }] },
    ],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/** A registry with one finished job whose stored output is known. */
function finishedRegistry() {
  const jobs = new JobRegistry();
  const job = jobs.create({ agent: "worker", handle: null, cwd: "/repo" });
  jobs.setStatus(job.id, "done");
  const result = makeResult();
  jobs.setResult(job.id, result);
  return { jobs, job, result };
}

// ---------------------------------------------------------------------------
// Stop grace resolution and wrap-up instructions
// ---------------------------------------------------------------------------

test("stop grace resolves from the environment with a positive default", () => {
  assert.equal(resolveStopGraceMs({}), DEFAULT_STOP_GRACE_MS);
  assert.equal(DEFAULT_STOP_GRACE_MS, 10_000);
  assert.equal(resolveStopGraceMs({ [STOP_GRACE_ENV]: "" }), DEFAULT_STOP_GRACE_MS);
  assert.equal(resolveStopGraceMs({ [STOP_GRACE_ENV]: "   " }), DEFAULT_STOP_GRACE_MS);
  assert.equal(resolveStopGraceMs({ [STOP_GRACE_ENV]: "250" }), 250);
  assert.equal(resolveStopGraceMs({ [STOP_GRACE_ENV]: " 250 " }), 250);
  for (const invalid of ["0", "-1", "1.5", "abc", "10s", "1e3"]) {
    assert.equal(
      resolveStopGraceMs({ [STOP_GRACE_ENV]: invalid }),
      DEFAULT_STOP_GRACE_MS,
      `invalid value "${invalid}" falls back to the default`,
    );
  }
});

test("wrap-up instructions tell the child to report partial progress and stop", () => {
  const stop = formatStopWrapUpInstruction();
  assert.match(stop, /Stop working on this task now and wrap up/);
  assert.match(stop, /Report your partial progress/);
  assert.match(stop, /one final message, then stop/);

  const timeout = formatTimeoutWrapUpInstruction(30);
  assert.match(timeout, /exceeded your 30s run timeout/);
  assert.match(timeout, /Stop working on this task now and wrap up/);
  assert.match(timeout, /Report your partial progress/);
});

// ---------------------------------------------------------------------------
// subagent_status listing (module level)
// ---------------------------------------------------------------------------

test("status listing explains itself when no jobs have been started", () => {
  const listing = formatStatusListing(new JobRegistry());
  assert.equal(listing.error, undefined);
  assert.match(listing.text, /^No subagent jobs have been started in this session\./);
  assert.match(listing.text, /Every Agent call \(foreground or background\) is tracked as a job/);
  assert.deepEqual(listing.details, { kind: "pi-subagent-status", jobs: [] });
});

test("status listing reflects live registry state from queued through terminal", () => {
  const jobs = new JobRegistry();
  const queued = jobs.create({ agent: "worker", cwd: "/repo" });
  const running = jobs.create({ agent: "worker", handle: "docs", cwd: "/repo" });
  jobs.setStatus(running.id, "running");
  const done = jobs.create({ agent: "leaf", cwd: "/repo" });
  jobs.setStatus(done.id, "done");
  jobs.setResult(done.id, makeResult());
  const stopped = jobs.create({ agent: "leaf", cwd: "/repo" });
  jobs.setStatus(stopped.id, "stopped");
  const failed = jobs.create({ agent: "leaf", cwd: "/repo" });
  jobs.setStatus(failed.id, "failed");

  const listing = formatStatusListing(jobs);
  assert.equal(listing.error, undefined);
  assert.match(listing.text, /^Subagent jobs \(5 total: 1 queued, 1 running, 1 done, 1 failed, 1 stopped\):/);
  assert.match(listing.text, new RegExp(`- ${queued.id} \\(worker\\): queued, [0-9.]+s elapsed`));
  assert.match(listing.text, new RegExp(`- ${running.id} \\(worker\\): running, [0-9.]+s elapsed`));
  assert.match(listing.text, new RegExp(`- ${done.id} \\(leaf\\): done, ran [0-9.]+s`));
  assert.match(listing.text, new RegExp(`- ${failed.id} \\(leaf\\): failed after [0-9.]+s`));
  assert.match(listing.text, new RegExp(`- ${stopped.id} \\(leaf\\): stopped after [0-9.]+s`));

  // Privacy filter: no task text, prompts, or output anywhere in the listing.
  assert.ok(!listing.text.includes("secret task text"), "no prompt text leaks");
  assert.ok(!listing.text.includes("final output text"), "no output leaks");
  assert.match(listing.text, /privacy-filtered: it carries no prompts or output/);

  assert.equal(listing.details.kind, "pi-subagent-status");
  assert.equal(listing.details.jobs.length, 5);
  const ids = listing.details.jobs.map((entry) => entry.id);
  assert.deepEqual(ids, [queued.id, running.id, done.id, stopped.id, failed.id]);
  for (const entry of listing.details.jobs) {
    assert.ok(entry.agent && typeof entry.agent === "string");
    assert.ok(["queued", "running", "done", "failed", "stopped"].includes(entry.status));
    assert.equal(typeof entry.age, "number");
    assert.ok(entry.age >= 0);
    assert.ok(entry.elapsedMs === undefined || typeof entry.elapsedMs === "number");
    assert.ok(!("prompt" in entry), "listing entries carry no prompt");
    assert.ok(!("output" in entry), "listing entries carry no output");
  }
  const display = Object.fromEntries(listing.details.jobs.map((entry) => [entry.status, entry.id]));
  assert.equal(display.queued, queued.id, "spawned jobs list as queued");
});

test("status listing measures live elapsed against the provided clock", () => {
  const jobs = new JobRegistry();
  const job = jobs.create({ agent: "worker", cwd: "/repo" });
  jobs.setStatus(job.id, "running");
  const nowMs = Date.parse(job.spawnedAt) + 4_500;
  const listing = formatStatusListing(jobs, { now: () => nowMs });
  const entry = listing.details.jobs.find((candidate) => candidate.id === job.id);
  assert.equal(entry.elapsedMs, 4_500);
  assert.equal(entry.age, 4_500);
  assert.match(listing.text, new RegExp(`- ${job.id} \\(worker\\): running, 4\\.5s elapsed`));
});

test("status listing filters to one job and errors on an unknown job id", () => {
  const jobs = new JobRegistry();
  const first = jobs.create({ agent: "worker", cwd: "/repo" });
  const second = jobs.create({ agent: "leaf", cwd: "/repo" });

  const filtered = formatStatusListing(jobs, { job: second.id });
  assert.equal(filtered.error, undefined);
  assert.match(filtered.text, /^Subagent jobs \(1 total: 1 queued\):/);
  assert.match(filtered.text, new RegExp(`- ${second.id} \\(leaf\\): queued`));
  assert.ok(!filtered.text.includes(first.id), "the filtered listing omits other jobs");

  const unknown = formatStatusListing(jobs, { job: "job-ffffffffffff" });
  assert.match(unknown.error, /Unknown subagent job "job-ffffffffffff"/);
  assert.match(unknown.text, /Unknown subagent job "job-ffffffffffff"/);
  assert.deepEqual(unknown.details, { kind: "pi-subagent-status", jobs: [], failed: true });
});

// ---------------------------------------------------------------------------
// subagent_result collection (module level)
// ---------------------------------------------------------------------------

test("result collection errors clearly for an unknown job id", () => {
  const { jobs } = finishedRegistry();
  const view = collectJobResult(jobs, { jobId: "job-ffffffffffff" });
  assert.match(view.content[0].text, /Unknown subagent job "job-ffffffffffff"/);
  assert.match(view.content[0].text, /Use the job id from the Agent tool result details/);
  assert.deepEqual(view.details, {
    kind: "pi-subagent-result",
    job: null,
    ready: false,
    failed: true,
  });
});

test("result collection reports a still-running job as not done without blocking", () => {
  const jobs = new JobRegistry();
  const job = jobs.create({ agent: "worker", handle: "docs", cwd: "/repo" });
  jobs.setStatus(job.id, "running");

  const view = collectJobResult(jobs, { jobId: job.id });
  assert.match(view.content[0].text, new RegExp(`Subagent job ${job.id} \\(agent worker\\) is still running`));
  assert.match(view.content[0].text, /Its result is not ready yet\. This call never blocks/);
  assert.match(view.content[0].text, /subagent_status to monitor progress/);
  assert.equal(view.details.kind, "pi-subagent-result");
  assert.equal(view.details.ready, false);
  assert.equal(view.details.failed, undefined);
  assert.equal(view.details.job.id, job.id);
  assert.equal(view.details.job.status, "running");
  assert.equal(view.details.result, undefined);
});

test("result collection returns a finished job's full stored output", () => {
  const { jobs, job, result } = finishedRegistry();
  const view = collectJobResult(jobs, { jobId: job.id });
  assert.match(view.content[0].text, new RegExp(`Subagent job ${job.id} \\(agent worker\\) completed after [0-9.]+s\\.`));
  assert.match(view.content[0].text, /^Status: done \(exit code 0, stop reason "stop"\)$/m);
  assert.match(view.content[0].text, /Session: none \(ephemeral call; it cannot be resumed\)/);
  assert.match(view.content[0].text, /Output:\nfinal output text/);
  assert.equal(view.details.kind, "pi-subagent-result");
  assert.equal(view.details.ready, true);
  assert.equal(view.details.failed, undefined);
  assert.equal(view.details.job.id, job.id);
  assert.equal(view.details.job.status, "done");
  assert.equal(view.details.result, result, "the full stored result travels in details");
});

test("result collection caps oversized output in text but keeps it whole in details", () => {
  const jobs = new JobRegistry();
  const job = jobs.create({ agent: "worker", cwd: "/repo" });
  jobs.setStatus(job.id, "done");
  const big = "x".repeat(2_000);
  const result = makeResult({
    messages: [{ role: "assistant", content: [{ type: "text", text: big }] }],
  });
  jobs.setResult(job.id, result);

  const view = collectJobResult(jobs, { jobId: job.id }, { limitBytes: 100 });
  assert.match(view.content[0].text, /\[Output truncated to the 100B per-child cap\. The full output remains in the child's session file on disk\.\]/);
  const included = view.content[0].text.match(/Output:\n([\s\S]*)\n\n\[Output truncated/)[1];
  assert.ok(Buffer.byteLength(included, "utf8") <= 100, "included output stays within the cap");
  assert.equal(view.details.ready, true);
  assert.equal(view.details.result, result);
  assert.equal(messageText(view.details.result.messages.at(-1)), big, "the full output stays available in details");
});

test("result collection names a finished job whose stored output is missing", () => {
  const jobs = new JobRegistry();
  const job = jobs.create({ agent: "worker", cwd: "/repo" });
  jobs.setStatus(job.id, "done");

  const view = collectJobResult(jobs, { jobId: job.id });
  assert.match(view.content[0].text, new RegExp(`Subagent job ${job.id} \\(agent worker\\) finished with status "done", but no stored output is available for it`));
  assert.equal(view.details.ready, false);
  assert.equal(view.details.failed, undefined);
});

test("result collection resolves a session handle to its latest job", () => {
  const jobs = new JobRegistry();
  const earlier = jobs.create({ agent: "worker", handle: "docs", cwd: "/repo" });
  jobs.setStatus(earlier.id, "done");
  jobs.setResult(earlier.id, makeResult());
  const later = jobs.create({ agent: "worker", handle: "docs", cwd: "/repo" });
  jobs.setStatus(later.id, "done");
  const laterResult = makeResult({
    messages: [{ role: "assistant", content: [{ type: "text", text: "latest run output" }] }],
  });
  jobs.setResult(later.id, laterResult);

  const view = collectJobResult(jobs, { handle: "docs" });
  assert.equal(view.details.job.id, later.id);
  assert.match(view.content[0].text, /Output:\nlatest run output/);

  // A handle whose only job is still running reports not-done: the handle
  // resolves to its most recent job.
  const otherJobs = new JobRegistry();
  const running = otherJobs.create({ agent: "worker", handle: "notes", cwd: "/repo" });
  otherJobs.setStatus(running.id, "running");
  const live = collectJobResult(otherJobs, { handle: "notes" });
  assert.equal(live.details.ready, false);
  assert.equal(live.details.job.id, running.id);

  // An unknown handle errors clearly.
  const unknown = collectJobResult(jobs, { handle: "ghost" });
  assert.match(unknown.content[0].text, /No subagent job found for session handle "ghost"/);
  assert.equal(unknown.details.failed, true);
});

test("result collection rejects a job id and handle that disagree", () => {
  const jobs = new JobRegistry();
  const first = jobs.create({ agent: "worker", handle: "docs", cwd: "/repo" });
  const second = jobs.create({ agent: "leaf", handle: "notes", cwd: "/repo" });

  const view = collectJobResult(jobs, { jobId: second.id, handle: "docs" });
  assert.match(view.content[0].text, new RegExp(`Subagent job ${second.id} does not use session handle "docs"`));
  assert.equal(view.details.failed, true);
  assert.equal(view.details.job.id, second.id);
  assert.ok(first, "the first job exists");
});

test("result collection demands an identifier", () => {
  const { jobs } = finishedRegistry();
  const view = collectJobResult(jobs, {});
  assert.match(view.content[0].text, /Provide `job` \(the job id from the Agent tool result details\) or `handle`/);
  assert.equal(view.details.failed, true);
  assert.equal(view.details.job, null);
});

// ---------------------------------------------------------------------------
// subagent_stop result formatting (module level)
// ---------------------------------------------------------------------------

function stopOutcome(overrides) {
  const jobs = new JobRegistry();
  const job = jobs.create({ agent: "worker", handle: null, cwd: "/repo" });
  jobs.setStatus(job.id, "stopped");
  const result = makeResult({
    exitCode: 130,
    stopReason: "aborted",
    stopped: true,
    errorMessage: "Subagent was stopped by request.",
  });
  return { ok: true, outcome: "stopped", job: { ...job }, result, reason: "Subagent was stopped by request.", ...overrides };
}

test("stop view reports a stopped job with its partial output preserved", () => {
  const view = formatStopView(stopOutcome({}));
  assert.match(view.content[0].text, new RegExp(`Subagent job \\S+ \\(agent worker\\) stopped after [0-9.]+s\\.`));
  assert.match(view.content[0].text, /wrap-up instruction \(report partial progress\), then a bounded grace period, then process-tree termination/);
  assert.match(view.content[0].text, /its partial output is preserved and retrievable via the subagent_result tool/);
  assert.match(view.content[0].text, /Partial output:\nfinal output text/);
  assert.equal(view.details.kind, "pi-subagent-stop");
  assert.equal(view.details.outcome, "stopped");
  assert.equal(view.details.job.status, "stopped");
  assert.equal(view.details.failed, undefined);
});

test("stop view states when no partial output was captured", () => {
  const view = formatStopView(stopOutcome({ result: undefined }));
  assert.match(view.content[0].text, /Partial output: \(none captured before the stop\)\./);
  assert.equal(view.details.outcome, "stopped");
});

test("stop view reports an already-finished job as a message, not an error", () => {
  const jobs = new JobRegistry();
  const job = jobs.create({ agent: "worker", cwd: "/repo" });
  jobs.setStatus(job.id, "done");
  const view = formatStopView({ ok: true, outcome: "already-finished", job: { ...job } });
  assert.match(view.content[0].text, new RegExp(`Subagent job ${job.id} \\(agent worker\\) is already finished with status "done"\\.`));
  assert.match(view.content[0].text, /Nothing to stop: only running jobs can be stopped, and stopping is idempotent\./);
  assert.equal(view.details.outcome, "already-finished");
  assert.equal(view.details.failed, undefined);
});

test("stop view surfaces stop errors and pending stops distinctly", () => {
  const jobs = new JobRegistry();
  const job = jobs.create({ agent: "worker", cwd: "/repo" });
  jobs.setStatus(job.id, "running");

  const error = formatStopView({
    ok: false,
    job: { ...job },
    error: `Unknown subagent job "${job.id}".`,
  });
  assert.match(error.content[0].text, new RegExp(`Unknown subagent job "${job.id}"`));
  assert.equal(error.details.outcome, "error");
  assert.equal(error.details.failed, true);

  const pending = formatStopView({
    ok: true,
    outcome: "pending",
    job: { ...job },
    reason: "Subagent was stopped by request.",
    note: "The stop was initiated, but the job had not fully terminated within 400ms.",
  });
  assert.match(pending.content[0].text, /stop initiated but not yet complete/);
  assert.match(pending.content[0].text, /The wrap-up instruction was sent and the grace period started/);
  assert.match(pending.content[0].text, /Check subagent_status, or call subagent_result once it finishes/);
  assert.equal(pending.details.outcome, "pending");
  assert.equal(pending.details.failed, undefined);

  const finished = formatStopView({
    ok: true,
    outcome: "finished",
    job: { ...jobs.setStatus(job.id, "done") },
    result: makeResult(),
    note: "The job finished with status \"done\" while the stop was being applied.",
  });
  assert.match(finished.content[0].text, /The job finished with status "done" while the stop was being applied/);
  assert.match(finished.content[0].text, /Partial output:\nfinal output text/);
  assert.equal(finished.details.outcome, "finished");
});

// ---------------------------------------------------------------------------
// Companion tool registration and error surfaces (mocked pi, real factory)
// ---------------------------------------------------------------------------

function createPiHarness() {
  const handlers = new Map();
  const tools = new Map();
  const flags = new Map();
  const entries = [];
  const sentUserMessages = [];

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
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
  };

  registerSubagentExtension(pi);
  return { handlers, tools, flags, entries, sentUserMessages };
}

function createContext(cwd, { sessionFile } = {}) {
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
      getSessionFile: () => sessionFile,
    },
  };
}

function withTempProject(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-companion-"));
  const projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "config");
  return Promise.resolve()
    .then(() => fn(projectDir))
    .finally(() => {
      if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
}

async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

test("companion tools register with identifying schemas", () => {
  const harness = createPiHarness();

  const status = harness.tools.get("subagent_status");
  assert.ok(status, "subagent_status registers");
  assert.equal(status.parameters.properties.job.minLength, 1);
  assert.equal(status.parameters.properties.job.type, "string");
  assert.equal(status.parameters.required, undefined);
  assert.ok(status.description.length > 0);

  const result = harness.tools.get("subagent_result");
  assert.ok(result, "subagent_result registers");
  assert.equal(result.parameters.properties.job.minLength, 1);
  assert.equal(result.parameters.properties.handle.maxLength, 120);
  assert.equal(result.parameters.required, undefined);

  const stop = harness.tools.get("subagent_stop");
  assert.ok(stop, "subagent_stop registers");
  assert.equal(stop.parameters.properties.job.minLength, 1);
  assert.equal(stop.parameters.properties.handle.maxLength, 120);
  assert.equal(stop.parameters.required, undefined);

  const reply = harness.tools.get("subagent_reply");
  assert.ok(reply, "subagent_reply registers");
  assert.deepEqual(reply.parameters.required, ["job", "answer"]);
  assert.equal(reply.parameters.properties.job.minLength, 1);
  assert.equal(reply.parameters.properties.answer.minLength, 1);
});

test("subagent_status tool returns the empty listing and errors for unknown filters", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createPiHarness();
    const ctx = createContext(projectDir);
    const status = harness.tools.get("subagent_status");

    const empty = await status.execute("call-1", {}, undefined, undefined, ctx);
    assert.equal(empty.content[0].text, formatStatusListing(new JobRegistry()).text);
    assert.deepEqual(empty.details, { kind: "pi-subagent-status", jobs: [] });

    const unknown = await status.execute("call-2", { job: "job-ffffffffffff" }, undefined, undefined, ctx);
    assert.match(unknown.content[0].text, /Unknown subagent job "job-ffffffffffff"/);
    assert.equal(unknown.details.jobs.length, 0);
    assert.equal(unknown.details.failed, true);
  });
});

test("subagent_result tool errors clearly for an unknown job id", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createPiHarness();
    const ctx = createContext(projectDir);
    const collect = harness.tools.get("subagent_result");

    const view = await collect.execute("call-1", { job: "job-ffffffffffff" }, undefined, undefined, ctx);
    assert.match(view.content[0].text, /Unknown subagent job "job-ffffffffffff"/);
    assert.equal(view.details.kind, "pi-subagent-result");
    assert.equal(view.details.failed, true);
    assert.equal(view.details.job, null);
  });
});

test("subagent_stop tool reports an already-finished job as a plain message", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createPiHarness();
    const ctx = createContext(projectDir);

    // A background call for an unknown agent fails fast without spawning a
    // child, leaving a terminal job in the registry.
    const start = await harness.tools.get("Agent").execute(
      "call-start",
      { calls: [{ agent: "ghost", prompt: "hello", background: true }] },
      undefined,
      undefined,
      ctx,
    );
    const [placeholder] = start.details.results;
    const jobId = placeholder.job.id;
    const finished = await waitFor(() => placeholder.job.status === "failed" ? placeholder.job : undefined);
    assert.ok(finished, `the ghost job reached a terminal status (got ${placeholder.job.status})`);

    const stop = await harness.tools.get("subagent_stop").execute(
      "call-stop",
      { job: jobId },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(stop.details.kind, "pi-subagent-stop");
    assert.equal(stop.details.outcome, "already-finished");
    assert.equal(stop.details.failed, undefined);
    assert.match(stop.content[0].text, new RegExp(`Subagent job ${jobId} \\(agent ghost\\) is already finished with status "failed"`));
    assert.match(stop.content[0].text, /Nothing to stop: only running jobs can be stopped/);
  });
});

test("subagent_stop tool demands a job id or handle", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createPiHarness();
    const ctx = createContext(projectDir);
    const stop = await harness.tools.get("subagent_stop").execute("call-1", {}, undefined, undefined, ctx);
    assert.match(stop.content[0].text, /Provide `job` \(the job id from the Agent tool result details\) or `handle`/);
    assert.equal(stop.details.outcome, "error");
    assert.equal(stop.details.failed, true);
    assert.equal(stop.details.job, null);
  });
});

test("subagent_reply tool errors when no question is waiting for the job", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createPiHarness();
    const ctx = createContext(projectDir);
    const reply = harness.tools.get("subagent_reply");

    const missing = await reply.execute("call-1", { job: "job-ffffffffffff", answer: "late answer" }, undefined, undefined, ctx);
    assert.match(missing.content[0].text, /Subagent job job-ffffffffffff has no question waiting for an answer/);
    assert.match(missing.content[0].text, /check the job's latest messages/);
    assert.equal(missing.details.kind, "pi-subagent-reply");
    assert.equal(missing.details.delivered, false);
    assert.equal(missing.details.failed, true);

    const empty = await reply.execute("call-2", { job: "", answer: "" }, undefined, undefined, ctx);
    assert.match(empty.content[0].text, /Provide `job` \(the job id from the relayed question message\) and a non-empty `answer`/);
    assert.equal(empty.details.failed, true);
  });
});

test("tool_result flips isError for failed companion tool results only", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createPiHarness();
    const ctx = createContext(projectDir);
    const handler = harness.handlers.get("tool_result")[0];

    for (const [toolName, details] of [
      ["subagent_status", { kind: "pi-subagent-status", jobs: [], failed: true }],
      ["subagent_result", { kind: "pi-subagent-result", job: null, ready: false, failed: true }],
      ["subagent_stop", { kind: "pi-subagent-stop", job: null, outcome: "error", failed: true }],
      ["subagent_reply", { kind: "pi-subagent-reply", job: null, answer: "", delivered: false, failed: true }],
    ]) {
      const patch = await handler({ toolName, details, isError: false }, ctx);
      assert.deepEqual(patch, { isError: true }, `${toolName} failed details flip isError`);
    }

    for (const [toolName, details] of [
      ["subagent_status", { kind: "pi-subagent-status", jobs: [] }],
      ["subagent_result", { kind: "pi-subagent-result", job: null, ready: false }],
      ["subagent_stop", { kind: "pi-subagent-stop", job: null, outcome: "stopped" }],
      ["subagent_reply", { kind: "pi-subagent-reply", job: null, answer: "a", delivered: true }],
      ["subagent_result", { kind: "pi-subagent-result", job: null, ready: false, failed: false }],
    ]) {
      const patch = await handler({ toolName, details, isError: false }, ctx);
      assert.equal(patch, undefined, `${toolName} success details leave isError alone`);
    }

    const foreign = await handler(
      { toolName: "bash", details: { kind: "pi-subagent-status", jobs: [], failed: true }, isError: false },
      ctx,
    );
    assert.equal(foreign, undefined, "the flip only matches companion tool names");
  });
});
