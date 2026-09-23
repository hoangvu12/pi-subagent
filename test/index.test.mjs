import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const {
  default: registerSubagentExtension,
  getProjectTrustOverrideFromArgv,
  resolveCallCwd,
  normalizeCalls,
} = await jiti.import("../index.ts");

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

function writeAgent(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\nYou are ${name}.\n`,
  );
}

function createContext(cwd, trusted, { sessionFile } = {}) {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
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

test("canonicalizes symlinked per-call working directories", {
  skip: process.platform === "win32",
}, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cwd-"));
  const physical = path.join(tmpDir, "physical");
  const alias = path.join(tmpDir, "alias");
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias, "dir");
  try {
    assert.equal(resolveCallCwd(tmpDir, "alias"), fs.realpathSync(physical));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("subagent schema uses a Google-compatible initialContext enum", () => {
  const harness = createPiHarness();
  const schema = harness.tools.get("Agent").parameters;
  assert.equal(schema.properties.calls.minItems, 1);
  assert.equal(schema.properties.calls.maxItems, 8);
  assert.equal(schema.properties.calls.items.properties.agent.minLength, 1);
  assert.equal(schema.properties.calls.items.properties.prompt.minLength, 1);
  assert.equal(schema.properties.calls.items.properties.session.minLength, 1);
  assert.equal(schema.properties.calls.items.properties.session.maxLength, 120);

  const initialContext = schema.properties.calls.items.properties.initialContext;

  assert.equal(initialContext.type, "string");
  assert.deepEqual(initialContext.enum, ["empty", "parent"]);
  assert.equal(initialContext.default, "empty");
  assert.equal(initialContext.anyOf, undefined);
  assert.equal(initialContext.oneOf, undefined);

  const inactivityTimeout = schema.properties.calls.items.properties.inactivityTimeout;
  assert.equal(inactivityTimeout.type, "integer");
  assert.equal(inactivityTimeout.minimum, 1);
  assert.equal(inactivityTimeout.maximum > 1, true);

  const timeout = schema.properties.calls.items.properties.timeout;
  assert.equal(timeout.type, "integer");
  assert.equal(timeout.minimum, 1);
  assert.equal(timeout.maximum > 1, true);
});

test("thinking schema and normalization accept exactly the supported per-call levels", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const schema = createPiHarness().tools.get("Agent").parameters.properties.calls.items;
  const thinking = schema.properties.thinking;
  assert.equal(thinking.type, "string");
  assert.deepEqual(thinking.enum, levels);
  assert.equal(thinking.anyOf, undefined);
  assert.equal(thinking.oneOf, undefined);
  assert.equal(thinking.default, undefined);
  assert.equal(schema.required.includes("thinking"), false);

  const calls = levels.map((thinking) => ({ agent: "review", prompt: "Review", thinking }));
  calls.push({ agent: "review", prompt: "Review" });
  const result = normalizeCalls(calls, process.cwd());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls.map((call) => call.thinking), [...levels, undefined]);
});

test("thinking normalization rejects invalid values before executing a batch", () => {
  for (const thinking of ["", "HIGH", " high ", "invalid", null, false, 0, [], {}]) {
    const result = normalizeCalls([
      { agent: "review", prompt: "Valid", thinking: "off" },
      { agent: "review", prompt: "Invalid", thinking },
    ], process.cwd());
    assert.match(result.error, /calls\[1\]\.thinking must be one of: off, minimal, low, medium, high, xhigh, max/);
    assert.equal(result.calls, undefined);
  }
});

test("recognizes only parsed project approval flags", () => {
  assert.equal(getProjectTrustOverrideFromArgv(["node", "pi", "--approve"]), true);
  assert.equal(getProjectTrustOverrideFromArgv(["node", "pi", "--no-approve"]), false);
  assert.equal(getProjectTrustOverrideFromArgv(["node", "pi", "--model", "--approve"]), null);
  assert.equal(getProjectTrustOverrideFromArgv(["node", "pi", "--", "--approve"]), null);
});

test("registers both cycle-prevention CLI flag forms", () => {
  const harness = createPiHarness();
  assert.equal(harness.flags.get("subagent-prevent-cycles").type, "boolean");
  assert.equal(harness.flags.get("no-subagent-prevent-cycles").type, "boolean");
});

test("implicit Pi trust does not enable project-only agents", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-"));
  const configDir = path.join(tmpDir, "config");
  const projectDir = path.join(tmpDir, "project");
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  writeAgent(path.join(projectDir, ".pi", "agents"), "project-only");

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, true);
    await harness.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    const promptPatch = await harness.handlers.get("before_agent_start")[0](
      { systemPrompt: "base" },
      ctx,
    );

    assert.match(promptPatch.systemPrompt, /\*\*explore\*\* \(user\)/);
    assert.doesNotMatch(promptPatch.systemPrompt, /project-only/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("saved project trust enables project-only agents", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-"));
  const configDir = path.join(tmpDir, "config");
  const projectDir = path.join(tmpDir, "project");
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  writeAgent(path.join(projectDir, ".pi", "agents"), "project-only");
  new ProjectTrustStore(configDir).set(projectDir, true);

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, true);
    await harness.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    const promptPatch = await harness.handlers.get("before_agent_start")[0](
      { systemPrompt: "base" },
      ctx,
    );

    assert.match(promptPatch.systemPrompt, /\*\*project-only\*\* \(project\)/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("extension lifecycle excludes untrusted project agents consistently", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-"));
  const configDir = path.join(tmpDir, "config");
  const projectDir = path.join(tmpDir, "project");
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  writeAgent(path.join(projectDir, ".pi", "agents"), "project-only");

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, false);

    await harness.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    const promptPatch = await harness.handlers.get("before_agent_start")[0](
      { systemPrompt: "base" },
      ctx,
    );

    assert.match(promptPatch.systemPrompt, /\*\*explore\*\* \(user\)/);
    assert.doesNotMatch(promptPatch.systemPrompt, /project-only/);

    const invalidTimeout = await harness.tools.get("Agent").execute(
      "invalid-timeout",
      { calls: [{ agent: "project-only", prompt: "hello", timeout: 0 }] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(invalidTimeout.details.failed, true);
    assert.match(invalidTimeout.content[0].text, /timeout must be an integer/);

    const invalidInactivityTimeout = await harness.tools.get("Agent").execute(
      "invalid-inactivity-timeout",
      { calls: [{ agent: "project-only", prompt: "hello", inactivityTimeout: 1.5 }] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(invalidInactivityTimeout.details.failed, true);
    assert.match(invalidInactivityTimeout.content[0].text, /inactivityTimeout must be an integer/);

    const result = await harness.tools.get("Agent").execute(
      "call-1",
      { calls: [{ agent: "project-only", prompt: "hello" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.kind, "pi-subagent");
    assert.equal(result.details.failed, true);
    assert.equal(result.details.projectAgentsDir, null);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].agentSource, "unknown");
    assert.match(result.content[0].text, /Unknown agent: "project-only"/);

    // The call that reached execution is tracked as a job even though it failed
    // before spawning a child.
    const job = result.details.results[0].job;
    assert.ok(job, "unknown-agent results carry a job record");
    assert.match(job.id, /^job-[0-9a-f]{12}$/);
    assert.equal(job.agent, "project-only");
    assert.equal(job.status, "failed");
    assert.equal(job.childSessionId, null, "ephemeral call has no child session id");
    assert.equal(job.childSessionFile, null);
    assert.equal(job.model, null);
    assert.ok(job.spawnedAt);
    assert.deepEqual(harness.entries, [], "ephemeral calls record no parent-session entries");

    const errorPatch = await harness.handlers.get("tool_result")[0](
      {
        toolName: "Agent",
        content: result.content,
        details: result.details,
        isError: false,
      },
      ctx,
    );
    assert.deepEqual(errorPatch, { isError: true });

    const successPatch = await harness.handlers.get("tool_result")[0](
      {
        toolName: "Agent",
        content: [{ type: "text", text: "ok" }],
        details: { kind: "pi-subagent", projectAgentsDir: null, results: [] },
        isError: false,
      },
      ctx,
    );
    assert.equal(successPatch, undefined);

    const foreignPatch = await harness.handlers.get("tool_result")[0](
      {
        toolName: "subagent",
        content: [{ type: "text", text: "ok" }],
        details: { kind: "pi-subagent", projectAgentsDir: null, results: [], failed: true },
        isError: false,
      },
      ctx,
    );
    assert.equal(foreignPatch, undefined, "the isError flip only matches the Agent tool name");
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session arguments naming a child session id resolve to that session", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-resume-"));
  const projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionDir = path.join(projectDir, ".sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const rawId = "subagent.0123456789abcdef";
  // A session file that already exists on disk with the exact child id, as a
  // failed job would have left behind. The header cwd must match the call.
  const sessionFile = path.join(sessionDir, `20250101T000000_${rawId}.jsonl`);
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: rawId, timestamp: "2025-01-01T00:00:00.000Z", cwd: projectDir })}\n`,
  );

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, false, { sessionFile: path.join(tmpDir, "parent.jsonl") });
    // The agent is unknown so runAgent fails fast without spawning a child;
    // session resolution happens before that and is what is under test.
    const result = await harness.tools.get("Agent").execute(
      "resume-disk",
      { calls: [{ agent: "ghost", prompt: "resume", session: rawId }] },
      undefined,
      undefined,
      ctx,
    );

    const [call] = result.details.results;
    assert.equal(call.session.id, rawId, "the raw id resolves to itself, not a derived id");
    assert.equal(call.session.handle, rawId);
    assert.equal(call.session.created, false, "the existing session file is detected");
    assert.equal(call.session.initialContextApplied, null);
    assert.equal(call.job.childSessionId, rawId);
    assert.equal(call.job.childSessionFile, sessionFile);
    assert.equal(call.job.status, "failed");
    assert.equal(call.resume.handle, rawId, "the failed result carries the handle");
    assert.match(call.resume.guidance, new RegExp(`session "${rawId}"`));
    assert.match(call.resume.guidance, /retaining its earlier context/, "persisted session guidance");
    assert.match(result.content[0].text, new RegExp(`session "${rawId}"`));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session ids tracked by the job registry resolve even before persistence", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-resume-registry-"));
  const projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, false, { sessionFile: path.join(tmpDir, "parent.jsonl") });
    // First call derives a session id from the handle; its job is tracked in
    // the registry even though no child ever ran and nothing was persisted.
    const first = await harness.tools.get("Agent").execute(
      "registry-first",
      { calls: [{ agent: "ghost", prompt: "hello", session: "auth" }] },
      undefined,
      undefined,
      ctx,
    );
    const derivedId = first.details.results[0].session.id;
    assert.match(derivedId, /^subagent\.[0-9a-f]{16}$/);
    assert.equal(first.details.results[0].resume.handle, derivedId);
    assert.match(first.details.results[0].resume.guidance, /before its session was persisted/, "nothing was flushed");

    // Resuming with that id resolves through the registry rather than hashing
    // the id into a different session.
    const second = await harness.tools.get("Agent").execute(
      "registry-resume",
      { calls: [{ agent: "ghost", prompt: "resume", session: derivedId }] },
      undefined,
      undefined,
      ctx,
    );
    const [call] = second.details.results;
    assert.equal(call.session.id, derivedId, "the registry resolves the id directly");
    assert.equal(call.session.handle, derivedId);
    assert.equal(call.session.created, true, "no persisted session exists yet");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ephemeral failures report that they cannot be resumed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-resume-ephemeral-"));
  const projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, false, { sessionFile: path.join(tmpDir, "parent.jsonl") });
    const result = await harness.tools.get("Agent").execute(
      "ephemeral-failure",
      { calls: [{ agent: "ghost", prompt: "hello" }] },
      undefined,
      undefined,
      ctx,
    );

    const [call] = result.details.results;
    assert.equal(call.job.status, "failed");
    assert.equal(call.job.childSessionId, null);
    assert.equal(call.resume.handle, null, "no session to resume");
    assert.match(call.resume.guidance, /cannot be resumed/);
    assert.match(call.resume.guidance, /Rerun the Agent call/);
    assert.match(result.content[0].text, /cannot be resumed/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("named-session calls record job identity as delegation entries in the parent session", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-jobs-"));
  const projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "config");
  const sessionFile = path.join(tmpDir, "parent-session.jsonl");

  try {
    const harness = createPiHarness();
    const ctx = createContext(projectDir, false, { sessionFile });
    const result = await harness.tools.get("Agent").execute(
      "job-entries",
      { calls: [{ agent: "worker", prompt: "hello", session: "auth" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.failed, true);
    assert.match(result.content[0].text, /Unknown agent: "worker"/);
    const job = result.details.results[0].job;
    assert.ok(job, "the executed call is tracked as a job");
    assert.match(job.id, /^job-[0-9a-f]{12}$/);
    assert.ok(job.childSessionId.startsWith("subagent."), "named calls carry the derived child session id");
    assert.equal(job.childSessionId, result.details.results[0].session.id);
    assert.equal(job.childSessionFile, null, "session file unknown before the child runs");
    assert.equal(job.model, null);
    assert.equal(job.status, "failed");

    assert.equal(harness.entries.length, 2, "one entry per lifecycle transition (running, failed)");
    for (const { customType, data } of harness.entries) {
      assert.equal(customType, "pi-subagent:delegation");
      assert.deepEqual(
        {
          version: data.version,
          childSessionId: data.childSessionId,
          parentSessionId: data.parentSessionId,
          agent: data.agent,
          handle: data.handle,
          jobId: data.jobId,
        },
        {
          version: 1,
          childSessionId: job.childSessionId,
          parentSessionId: "parent-session",
          agent: "worker",
          handle: "auth",
          jobId: job.id,
        },
      );
    }
    assert.deepEqual(harness.entries.map(({ data }) => data.status), ["running", "failed"]);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
