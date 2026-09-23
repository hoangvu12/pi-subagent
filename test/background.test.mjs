import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { JobRegistry } from "../jobs.ts";

const jiti = createJiti(import.meta.url);
const {
  BACKGROUND_OUTPUT_LIMIT_ENV,
  capBackgroundOutput,
  formatBackgroundAck,
  formatBackgroundElapsed,
  formatBackgroundResultMessage,
  resolveBackgroundOutputLimit,
} = await jiti.import("../background.ts");
const {
  default: registerSubagentExtension,
  normalizeCalls,
} = await jiti.import("../index.ts");

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

// ---------------------------------------------------------------------------
// Output limit resolution and capping
// ---------------------------------------------------------------------------

test("background output limit resolves from the environment with Pi's default fallback", () => {
  assert.equal(resolveBackgroundOutputLimit({}), DEFAULT_MAX_BYTES);
  assert.equal(resolveBackgroundOutputLimit({ [BACKGROUND_OUTPUT_LIMIT_ENV]: "" }), DEFAULT_MAX_BYTES);
  assert.equal(resolveBackgroundOutputLimit({ [BACKGROUND_OUTPUT_LIMIT_ENV]: "  " }), DEFAULT_MAX_BYTES);
  assert.equal(resolveBackgroundOutputLimit({ [BACKGROUND_OUTPUT_LIMIT_ENV]: "2048" }), 2048);
  for (const invalid of ["0", "-1", "10kb", "1.5", "abc"]) {
    assert.equal(
      resolveBackgroundOutputLimit({ [BACKGROUND_OUTPUT_LIMIT_ENV]: invalid }),
      DEFAULT_MAX_BYTES,
      `invalid value "${invalid}" falls back to the default`,
    );
  }
});

test("background output capping follows Pi's truncation conventions", () => {
  const small = capBackgroundOutput("hello", DEFAULT_MAX_BYTES);
  assert.deepEqual(small, { text: "hello", truncated: false, limitBytes: DEFAULT_MAX_BYTES });

  const multiLine = capBackgroundOutput(`${"line\n".repeat(100)}`, 100);
  assert.equal(multiLine.truncated, true);
  assert.ok(Buffer.byteLength(multiLine.text, "utf8") <= 100, "multi-line output stays within the byte cap");
  assert.match(multiLine.text, /(^|\n)line$/);

  const singleLine = capBackgroundOutput("x".repeat(1000), 100);
  assert.equal(singleLine.truncated, true, "single-line output that exceeds the cap is truncated");
  assert.equal(Buffer.byteLength(singleLine.text, "utf8"), 100, "the byte-slice fallback fills the cap exactly");

  const multiByte = capBackgroundOutput("é".repeat(200), 101);
  assert.equal(multiByte.truncated, true);
  assert.equal(multiByte.text, "é".repeat(50), "a dangling multi-byte sequence is dropped, not corrupted");
});

test("background elapsed formatting stays compact", () => {
  assert.equal(formatBackgroundElapsed(0), "0.0s");
  assert.equal(formatBackgroundElapsed(4500), "4.5s");
  assert.equal(formatBackgroundElapsed(130_000), "2m 10s");
  assert.equal(formatBackgroundElapsed(61_400_000), "17h 3m");
  assert.equal(formatBackgroundElapsed(7_200_000), "2h 0m");
  assert.equal(formatBackgroundElapsed(Number.NaN), "0.0s");
  assert.equal(formatBackgroundElapsed(-5), "0.0s");
});

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function fakeJob(overrides = {}) {
  return {
    id: "job-1a2b3c4d5e6f",
    agent: "worker",
    status: "running",
    childSessionId: null,
    childSessionFile: null,
    model: null,
    cwd: "/repo",
    spawnedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("background acknowledgment lists job ids with running status and retrieval guidance", () => {
  const single = formatBackgroundAck([{ agent: "worker", job: fakeJob() }]);
  assert.match(single, /^Background subagent started:/);
  assert.match(single, /- job-1a2b3c4d5e6f \(worker\): running/);
  assert.match(single, /This call returns immediately; the subagent keeps running detached/);
  assert.match(single, /subagent_result tool/);
  assert.doesNotMatch(single, /jobs\)/);

  const multiple = formatBackgroundAck([
    { agent: "worker", job: fakeJob() },
    { agent: "leaf", job: fakeJob({ id: "job-000000000009", agent: "leaf" }) },
  ]);
  assert.match(multiple, /^Background subagents started \(2 jobs\):/);
  assert.match(multiple, /- job-1a2b3c4d5e6f \(worker\): running\n- job-000000000009 \(leaf\): running/);
  assert.match(multiple, /the subagents keep running detached/);
});

test("background result summary reports job identity, status, elapsed, and capped output", () => {
  const job = fakeJob({ status: "done" });
  const result = { messages: [{ role: "assistant", content: [{ type: "text", text: "fixture:done" }] }] };
  const message = formatBackgroundResultMessage(job, result, {
    now: () => Date.parse("2026-01-01T00:00:04.500Z"),
  });
  assert.match(message, /^Background subagent job job-1a2b3c4d5e6f \(worker\) completed after 4\.5s\./);
  assert.match(message, /Output:\nfixture:done/);
  assert.match(message, /The full output of this job remains available on demand via the subagent_result tool\.$/);
  assert.doesNotMatch(message, /truncated/);

  const failedJob = fakeJob({ status: "failed", id: "job-9f8e7d6c5b4a" });
  const failedResult = { messages: [], stopReason: "error", errorMessage: "deliberate fixture failure" };
  const failure = formatBackgroundResultMessage(failedJob, failedResult, {
    now: () => Date.parse("2026-01-01T00:00:01.200Z"),
  });
  assert.match(failure, /^Background subagent job job-9f8e7d6c5b4a \(worker\) failed after 1\.2s\./);
  assert.match(failure, /Error:\nSubagent error: deliberate fixture failure/);
  assert.match(failure, /subagent_result tool/);

  const stopped = formatBackgroundResultMessage(fakeJob({ status: "stopped" }), { messages: [] });
  assert.match(stopped, /\(worker\) was stopped after/);
  assert.match(stopped, /\(no output\)/);
});

test("background result summary caps included output and says so", () => {
  const job = fakeJob({ status: "done" });
  const result = { messages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }] }] };
  const message = formatBackgroundResultMessage(job, result, { limitBytes: 200 });
  assert.match(message, /Output:\nx{200}\n/);
  assert.match(message, /\[Output truncated to the 200B per-child cap\.\]/);
  assert.match(message, /subagent_result tool/);
});

// ---------------------------------------------------------------------------
// Job registry result store
// ---------------------------------------------------------------------------

test("job registry stores full results for on-demand retrieval", () => {
  const registry = new JobRegistry();
  const job = registry.create({ agent: "worker", cwd: "/repo" });
  assert.equal(registry.getResult(job.id), undefined);

  const result = { agent: "worker", exitCode: 0, messages: [{ role: "assistant", content: [] }] };
  registry.setResult(job.id, result);
  assert.equal(registry.getResult(job.id), result);

  const snapshot = registry.list()[0];
  assert.equal("result" in snapshot, false, "job records stay details-shaped; results are stored separately");
  assert.equal(registry.getResult("job-does-not-exist"), undefined);
});

// ---------------------------------------------------------------------------
// Extension-level background behavior (mocked pi, real factory)
// ---------------------------------------------------------------------------

function createBackgroundPiHarness() {
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-background-"));
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

test("background schema and normalization accept exactly a boolean per call", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createBackgroundPiHarness();
    const callItem = harness.tools.get("Agent").parameters.properties.calls.items;
    assert.equal(callItem.properties.background.type, "boolean");
    assert.equal(callItem.required.includes("background"), false);

    const enabled = normalizeCalls([{ agent: "a", prompt: "p", background: true }], projectDir);
    assert.equal(enabled.error, undefined);
    assert.equal(enabled.calls[0].background, true);

    const omitted = normalizeCalls([{ agent: "a", prompt: "p" }], projectDir);
    assert.equal(omitted.error, undefined);
    assert.equal(omitted.calls[0].background, undefined);

    const invalid = normalizeCalls([{ agent: "a", prompt: "p", background: "yes" }], projectDir);
    assert.match(invalid.error, /calls\[0\]\.background must be a boolean when provided/);
    assert.equal(invalid.calls, undefined);
  });
});

test("background calls return immediately with job ids and deliver failure summaries as queued messages", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createBackgroundPiHarness();
    const ctx = createContext(projectDir);

    const result = await harness.tools.get("Agent").execute(
      "bg-unknown-agent",
      { calls: [{ agent: "ghost", prompt: "hello", background: true }] },
      undefined,
      undefined,
      ctx,
    );

    // The invocation itself succeeded: it started a detached job.
    assert.equal(result.details.kind, "pi-subagent");
    assert.notEqual(result.details.failed, true);
    assert.equal(result.details.results.length, 1);

    const placeholder = result.details.results[0];
    const job = placeholder.job;
    assert.ok(job, "the detached call is tracked as a job");
    assert.match(job.id, /^job-[0-9a-f]{12}$/);
    assert.equal(placeholder.exitCode, -1, "the detached call has no completed result yet");
    assert.equal(job.agent, "ghost");

    // The returned text acknowledges the job and reports it as running at
    // return time (the frozen tool-result content).
    const text = result.content[0].text;
    assert.match(text, /Background subagent started:/);
    assert.match(text, new RegExp(`- ${job.id} \\(ghost\\): running`));
    assert.match(text, /This call returns immediately/);
    assert.match(text, /subagent_result tool/);

    // The detached job failed (unknown agent) after the invocation returned:
    // the failure is delivered as a queued user message with follow-up
    // delivery, phrased for the dead child.
    assert.equal(harness.sentUserMessages.length, 1, JSON.stringify(harness.sentUserMessages));
    const sent = harness.sentUserMessages[0];
    assert.deepEqual(sent.options, { deliverAs: "followUp" });
    assert.match(sent.content, new RegExp(`^Background subagent job ${job.id} \\(ghost\\) failed after`));
    assert.match(sent.content, /Error:\nSubagent error: Unknown agent: "ghost"/);
    assert.match(sent.content, /subagent_result tool/);
    assert.equal(job.status, "failed", "the live job record advanced to its terminal status");

    // Ephemeral calls record no delegation-origin entries in the parent session.
    assert.deepEqual(harness.entries, []);
  });
});

test("background named-session jobs release their session lock and reserved id on completion", async () => {
  await withTempProject(async (projectDir) => {
    const sessionFile = path.join(projectDir, "parent-session.jsonl");
    fs.writeFileSync(sessionFile, "");
    const harness = createBackgroundPiHarness();
    const ctx = createContext(projectDir, { sessionFile });

    const first = await harness.tools.get("Agent").execute(
      "bg-named",
      { calls: [{ agent: "ghost", prompt: "hello", background: true, session: "auth" }] },
      undefined,
      undefined,
      ctx,
    );
    const job = first.details.results[0].job;
    assert.ok(job.childSessionId.startsWith("subagent."), "named calls carry the derived child session id");
    const lockPath = path.join(
      projectDir,
      ".sessions",
      ".pi-subagent-locks",
      `${job.childSessionId}.lock`,
    );
    assert.equal(fs.existsSync(lockPath), false, "the background job released its session lock after finishing");
    assert.equal(harness.sentUserMessages.length, 1, "the failure summary was still delivered");

    // The reserved session id was released too: the next call with the same
    // handle proceeds to execution instead of an "already running" rejection.
    const second = await harness.tools.get("Agent").execute(
      "bg-named-again",
      { calls: [{ agent: "ghost", prompt: "hello again", background: true, session: "auth" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(second.details.failed, true);
    assert.match(second.content[0].text, /Background subagent started:/);
    assert.equal(harness.sentUserMessages.length, 2);

    // Named background jobs record their lifecycle in the parent session.
    assert.deepEqual(
      harness.entries.map(({ data }) => data.status),
      ["running", "failed", "running", "failed"],
    );
    assert.ok(harness.entries.every(({ data }) => data.jobId && data.handle === "auth"));
  });
});

test("mixed invocations block on foreground calls and detach background calls", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createBackgroundPiHarness();
    const ctx = createContext(projectDir);

    const result = await harness.tools.get("Agent").execute(
      "mixed-unknown-agents",
      {
        calls: [
          { agent: "ghost", prompt: "foreground" },
          { agent: "phantom", prompt: "background", background: true },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    // Foreground results complete and are reported as before.
    assert.deepEqual(result.details.results.map((entry) => entry.callIndex), [0, 1]);
    const [foreground, background] = result.details.results;
    assert.equal(foreground.exitCode, 1, "the foreground call completed with its error result");
    assert.equal(foreground.job.status, "failed");
    assert.equal(background.exitCode, -1, "the background call detached");
    assert.notEqual(background.job.id, foreground.job.id);

    // The invocation failed overall (foreground error) and carries both the
    // background acknowledgment and the foreground summary. The acknowledged
    // status is read from the live job record, so a job that already finished
    // (this one fails before the foreground await completes) reports its
    // terminal status instead of "running".
    assert.equal(result.details.failed, true);
    const text = result.content[0].text;
    assert.match(text, /Background subagent started:/);
    assert.match(text, new RegExp(`- ${background.job.id} \\(phantom\\): (running|failed)`));
    assert.match(text, /0\/1 succeeded/);
    assert.match(text, /Unknown agent: "ghost"/);

    // Only the background job delivers a queued summary; the foreground
    // failure is reported in the tool result itself.
    assert.equal(harness.sentUserMessages.length, 1);
    assert.match(harness.sentUserMessages[0].content, /\(phantom\) failed after/);
    assert.equal(background.job.status, "failed");
  });
});

test("foreground calls keep their existing result shape alongside the new field", async () => {
  await withTempProject(async (projectDir) => {
    const harness = createBackgroundPiHarness();
    const ctx = createContext(projectDir);

    const result = await harness.tools.get("Agent").execute(
      "fg-unknown-agent",
      { calls: [{ agent: "ghost", prompt: "hello" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.failed, true);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].exitCode, 1);
    assert.match(result.content[0].text, /^0\/1 succeeded/);
    assert.match(result.content[0].text, /Unknown agent: "ghost"/);
    assert.doesNotMatch(result.content[0].text, /Background subagent/);
    assert.deepEqual(harness.sentUserMessages, [], "foreground calls never inject queued messages");
  });
});
