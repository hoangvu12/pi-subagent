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

function origins(entries) {
  return entries.filter((entry) => entry.type === "custom" && entry.customType === customType);
}

function ownOrigins(entries) {
  return origins(entries).filter((entry) => entry.data.childSessionId === entries[0].id);
}

function assertOrigin(entries, parentSessionId, agent, handle) {
  assert.equal(entries[0].type, "session");
  assert.equal(entries.filter((entry) => entry.type === "session").length, 1);
  const own = ownOrigins(entries);
  assert.equal(own.length, 1, `one origin owned by header ${entries[0].id}`);
  assert.deepEqual(own[0].data, {
    version: 1, childSessionId: entries[0].id, parentSessionId, agent, handle,
  });
  const ids = new Set(entries.slice(1).map((entry) => entry.id));
  assert.equal(ids.size, entries.length - 1, "entry IDs remain unique");
  for (const entry of entries.slice(1)) {
    assert.ok(entry.parentId === null || ids.has(entry.parentId), `valid parent link for ${entry.id}`);
  }
  return own[0];
}

function assertJobId(job) {
  assert.ok(job, "every executed call is tracked as a job");
  assert.match(job.id, /^job-[0-9a-f]{12}$/);
}

function childCall(tag, options = {}) {
  return { agent: "worker", prompt: JSON.stringify({ tag }), timeout: 25, inactivityTimeout: 20, ...options };
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

function setup(t, { workerThinking } = {}) {
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
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
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
  return {
    cwd, sessionDir, tmp, log,
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
  };
}

test("real Pi persists only new named origins, bound to the child header and immediate parent", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const ancestor = {
    version: 1, childSessionId: "copied-ancestor", parentSessionId: "older-ancestor", agent: "ancestor", handle: "copied",
  };
  const rpc = fixture.start({ launchPayload: ancestor });
  const parent = await rpc.command("get_state");
  assert.equal(parent.model.provider, "delegation-test");
  assert.equal(fs.existsSync(parent.sessionFile), false, "Pi has not flushed an assistant-free root");
  assert.deepEqual(origins((await rpc.command("get_entries")).entries), [], "helper rejects payloads for a different header identity");
  await rpc.command("prompt", { message: `/delegation-test-seed ${JSON.stringify(ancestor)}` });
  // Matches the temporary parent's header exactly, so identity checks alone cannot hide a leaked payload.
  const inherited = {
    version: 1, childSessionId: parent.sessionId, parentSessionId: "outer-parent", agent: "outer-agent", handle: "outer-handle",
  };
  await rpc.command("prompt", { message: `/delegation-test-payload ${JSON.stringify(inherited)}` });

  const firstTurn = await rpc.prompt({ tag: "first", calls: [childCall("first-child", { agent: " worker ", session: " work " })] });
  const [first] = results(firstTurn);
  assert.equal(first.session.created, true);
  const beforeFirst = fixture.observation("first-child");
  assert.equal(first.session.id, beforeFirst.header.id);

  // The model-facing tool call is named Agent on the wire; roboco's subagent
  // genus gate (ToolCall::is_subagent_spawn) matches exactly this name.
  const agentToolCall = firstTurn.messages.find(
    (message) => message.role === "assistant" &&
      message.content.some((part) => part.type === "toolCall" && part.name === "Agent"),
  );
  assert.ok(agentToolCall, "the assistant emits the tool call under the name Agent");
  assert.ok(beforeFirst.tools.includes("Agent"), "a delegating child sees the Agent tool");

  // Job details contract: every result carries job identity, status, child
  // session correlation, and model.
  assertJobId(first.job);
  assert.equal(first.job.agent, "worker");
  assert.equal(first.job.status, "done");
  assert.equal(first.job.childSessionId, first.session.id);
  assert.equal(first.job.childSessionFile, beforeFirst.file, "the job resolves the flushed child session file");
  assert.equal(first.job.model, "delegation-test/deterministic");
  assert.equal(first.job.cwd, fixture.cwd);
  assert.ok(!Number.isNaN(Date.parse(first.job.spawnedAt)));

  // The parent session JSONL records the job's lifecycle as delegation-origin entries.
  const parentOriginEntries = () => jsonl(parent.sessionFile)
    .filter((entry) => entry.type === "custom" && entry.customType === customType);

  assert.equal(beforeFirst.diskEntries.length, 0, "appendEntry remains buffered until a real assistant response");
  assert.deepEqual(beforeFirst.entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role), ["system", "user"]);
  assert.equal(beforeFirst.entries.some((entry) => entry.type === "custom_message"), false, "no placeholder custom messages");
  assert.equal(origins(beforeFirst.entries).length, 1, "child appended metadata before its first model response");
  assert.equal(JSON.stringify(beforeFirst.contextMessages).includes(customType), false, "metadata is not model context");
  const firstEntries = jsonl(beforeFirst.file);
  const firstOrigin = assertOrigin(firstEntries, parent.sessionId, "worker", "work");
  assert.equal(firstEntries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 1);

  const firstJobEntries = parentOriginEntries().filter((entry) => entry.data.jobId === first.job.id);
  assert.equal(firstJobEntries.length, 2, "one parent-session entry per lifecycle transition (running, done)");
  for (const entry of firstJobEntries) {
    assert.deepEqual(
      { ...entry.data, jobId: undefined, status: undefined },
      { ...firstOrigin.data, jobId: undefined, status: undefined },
      "parent entries share the versioned origin shape plus job identity",
    );
  }
  assert.deepEqual(firstJobEntries.map((entry) => entry.data.status), ["running", "done"]);
  assert.ok(firstJobEntries.every((entry) => entry.id && entry.timestamp), "entries carry Pi-assigned id and timestamp");

  const [continued] = results(await rpc.prompt({ tag: "continue", calls: [childCall("continued-child", { session: "work", initialContext: "parent" })] }));
  assert.equal(continued.session.created, false);
  assert.equal(continued.session.id, first.session.id);
  assert.equal(continued.session.initialContextApplied, null);
  assertJobId(continued.job);
  assert.notEqual(continued.job.id, first.job.id, "each delegation is its own job");
  assert.equal(continued.job.status, "done");
  assert.equal(continued.job.childSessionId, first.session.id);
  assert.equal(continued.job.childSessionFile, beforeFirst.file, "continued jobs resolve the session file at spawn time");
  assert.equal(
    parentOriginEntries().filter((entry) => entry.data.jobId === continued.job.id).length,
    2,
    "continuations also record job identity in the parent session",
  );
  const beforeContinue = fixture.observation("continued-child");
  assert.equal(beforeContinue.launchPayload, null, "continuation clears the inherited payload");
  assert.deepEqual(jsonl(beforeFirst.file).slice(0, firstEntries.length), firstEntries, "continuation preserves existing history verbatim");
  assert.deepEqual(assertOrigin(jsonl(beforeFirst.file), parent.sessionId, "worker", "work"), firstOrigin);

  const nestedPrompt = JSON.stringify({ tag: "seeded-child", calls: [childCall("nested-child", { agent: "leaf", session: "nested", initialContext: "parent" })] });
  const [seeded] = results(await rpc.prompt({ tag: "seeded", calls: [childCall("unused", { session: "seeded", initialContext: "parent", prompt: nestedPrompt })] }));
  assert.equal(seeded.session.created, true);
  const beforeSeeded = fixture.observation("seeded-child");
  const seededEntries = jsonl(beforeSeeded.file);
  assertOrigin(seededEntries, parent.sessionId, "worker", "seeded");
  const seededOrigins = origins(seededEntries);
  assert.deepEqual(seededOrigins[0].data, ancestor, "the seeded ancestor is copied verbatim");
  assert.equal(
    seededOrigins.filter((entry) => entry.data.childSessionId === beforeSeeded.header.id).length,
    1,
    "copied ancestors and inherited job entries do not suppress this child's origin",
  );
  assert.equal(
    seededOrigins.some((entry) => entry.data.jobId === first.job.id),
    true,
    "the parent snapshot carries earlier job entries into the fork",
  );
  assert.notEqual(beforeSeeded.header.id, parent.sessionId, "Pi fork uses a new header identity");
  assert.ok(beforeSeeded.header.parentSession.startsWith(fixture.tmp), "fork source is the temporary parent snapshot");
  assert.equal(fs.existsSync(beforeSeeded.header.parentSession), false, "runner removed the fork snapshot");

  const [nested] = results({ messages: seededEntries.filter((entry) => entry.type === "message").map((entry) => entry.message) });
  const beforeNested = fixture.observation("nested-child");
  const nestedEntries = jsonl(beforeNested.file);
  assert.equal(nested.session.id, beforeNested.header.id);
  assertOrigin(nestedEntries, seeded.session.id, "leaf", "nested");
  const nestedOrigins = origins(nestedEntries);
  assert.equal(
    nestedOrigins.filter((entry) => entry.data.childSessionId === beforeNested.header.id).length,
    1,
    "copied ancestors and inherited job entries remain foreign to the nested header",
  );
  assert.deepEqual(nestedOrigins[0].data, ancestor, "the oldest ancestor is still copied");
  assert.equal(
    nestedOrigins.some((entry) => entry.data.childSessionId === seeded.session.id),
    true,
    "the seeded child's own origin is inherited through its snapshot",
  );
  assert.equal(
    nestedOrigins.some((entry) => entry.data.jobId === first.job.id),
    true,
    "inherited job entries survive the nested fork",
  );
  assert.equal(beforeNested.depth, "2");
  assert.equal(beforeNested.tools.includes("Agent"), false, "depth guard disables delegation, not metadata");
  assert.notEqual(ownOrigins(nestedEntries)[0].data.parentSessionId, parent.sessionId, "nested parent is not the root");

  const persistedBeforeEphemeral = fs.readdirSync(fixture.sessionDir).filter((name) => name.endsWith(".jsonl")).sort();
  const ephemeral = results(await rpc.prompt({ tag: "ephemeral", calls: [
    childCall("ephemeral-empty"), childCall("ephemeral-parent", { initialContext: "parent" }),
  ] }));
  assert.ok(ephemeral.every((result) => result.session === undefined));
  for (const result of ephemeral) {
    assertJobId(result.job);
    assert.equal(result.job.status, "done");
    assert.equal(result.job.childSessionId, null, "ephemeral calls have no child session id");
    assert.equal(result.job.childSessionFile, null, "ephemeral calls have no child session file");
  }
  const recordedJobIds = new Set(parentOriginEntries().map((entry) => entry.data.jobId));
  assert.equal(
    ephemeral.some((result) => recordedJobIds.has(result.job.id)),
    false,
    "ephemeral jobs are tracked in-memory only and record no origin entries",
  );
  for (const tag of ["ephemeral-empty", "ephemeral-parent"]) {
    const observation = fixture.observation(tag);
    assert.equal(observation.launchPayload, null, `${tag} clears inherited launch metadata`);
    assert.equal(origins(observation.entries).some((entry) => entry.data.childSessionId === observation.header.id), false);
    if (tag === "ephemeral-empty") {
      assert.equal(observation.file, null);
      assert.equal(origins(observation.entries).length, 0);
    } else {
      assert.equal(observation.header.id, parent.sessionId, "ephemeral snapshot retains the delegator's ID");
      assert.equal(observation.temporaryParent, "1");
      const snapshotOrigins = origins(observation.entries);
      assert.deepEqual(snapshotOrigins[0].data, ancestor, "the seeded ancestor is copied verbatim");
      assert.equal(
        snapshotOrigins.every((entry) => entry.data.childSessionId !== observation.header.id),
        true,
        "the ephemeral child owns no origin entry",
      );
      assert.equal(
        snapshotOrigins.some((entry) => entry.data.jobId === first.job.id),
        true,
        "the snapshot carries the parent's job entries without re-marking them",
      );
      assert.equal(fs.existsSync(observation.file), false, "temporary session removed after the child exits");
    }
  }
  assert.deepEqual(fs.readdirSync(fixture.sessionDir).filter((name) => name.endsWith(".jsonl")).sort(), persistedBeforeEphemeral);

  // Reconstruct an owned pre-feature transcript by removing only the new origin and repairing its tree link.
  const legacyEntries = jsonl(beforeFirst.file).filter((entry) => entry.id !== firstOrigin.id)
    .map((entry) => entry.parentId === firstOrigin.id ? { ...entry, parentId: firstOrigin.parentId } : entry);
  fs.writeFileSync(beforeFirst.file, legacyEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await rpc.command("prompt", { message: `/delegation-test-payload ${JSON.stringify(firstOrigin.data)}` });
  const [legacy] = results(await rpc.prompt({ tag: "legacy", calls: [childCall("legacy-child", { session: "work" })] }));
  assert.equal(legacy.session.created, false);
  assert.equal(legacy.session.id, first.session.id);
  assert.equal(fixture.observation("legacy-child").launchPayload, null, "even a matching inherited payload cannot backfill a continuation");
  assert.deepEqual(origins(jsonl(beforeFirst.file)), [], "legacy sessions stay unmarked");
  assert.deepEqual(jsonl(beforeFirst.file).slice(0, legacyEntries.length), legacyEntries);
  assert.equal(ownOrigins(jsonl(parent.sessionFile)).length, 0, "no backfill into the root either");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
  assert.deepEqual(fs.readdirSync(fixture.tmp).filter((name) => name.startsWith("pi-subagent-")), [], "runner temporary resources cleaned up");
});

test("real Pi preserves thinking precedence and delegation metadata across named continuations", { timeout: 120_000 }, async (t) => {
  const fixture = setup(t, { workerThinking: "high" });
  const rpc = fixture.start({ model: "reasoning", thinking: "low" });
  const parent = await rpc.command("get_state");
  assert.equal(parent.thinkingLevel, "low");
  await rpc.command("set_thinking_level", { level: "medium" });

  const [first] = results(await rpc.prompt({ tag: "thinking-first", calls: [
    childCall("thinking-off", { session: "thinking", thinking: "off" }),
  ] }));
  const initial = fixture.observation("thinking-off");
  assert.equal(initial.thinking, "off", "call overrides agent high and startup low");
  const origin = assertOrigin(jsonl(initial.file), parent.sessionId, "worker", "thinking");

  const [continued] = results(await rpc.prompt({ tag: "thinking-continue", calls: [
    childCall("thinking-agent", { session: "thinking" }),
  ] }));
  assert.equal(continued.session.id, first.session.id);
  assert.equal(continued.session.created, false);
  assert.equal(fixture.observation("thinking-agent").thinking, "high", "agent overrides restored off and startup low");

  results(await rpc.prompt({ tag: "thinking-call-again", calls: [
    childCall("thinking-low", { session: "thinking", thinking: "low" }),
    childCall("thinking-fallback", { agent: "leaf", session: "fallback" }),
  ] }));
  assert.equal(fixture.observation("thinking-low").thinking, "low", "call overrides continued agent high");
  assert.equal(fixture.observation("thinking-fallback").thinking, "low", "startup low, not live parent medium");
  assert.deepEqual(assertOrigin(jsonl(initial.file), parent.sessionId, "worker", "thinking"), origin);

  results(await rpc.prompt({ tag: "thinking-fallback-continue", calls: [
    childCall("thinking-fallback-off", { agent: "leaf", session: "fallback", thinking: "off" }),
  ] }));
  assert.equal(fixture.observation("thinking-fallback-off").thinking, "off");
  results(await rpc.prompt({ tag: "thinking-fallback-restored", calls: [
    childCall("thinking-fallback-low", { agent: "leaf", session: "fallback" }),
  ] }));
  assert.equal(fixture.observation("thinking-fallback-low").thinking, "low", "startup fallback overrides restored off");

  const before = jsonl(fixture.log).filter((entry) => entry.kind === "process").length;
  const invalid = await rpc.prompt({ tag: "thinking-invalid", calls: [
    childCall("must-not-run", { session: "invalid-batch", thinking: "off" }),
    childCall("invalid", { thinking: "HIGH" }),
  ] });
  const rejected = invalid.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(rejected);
  assert.match(JSON.stringify(rejected), /thinking/);
  assert.equal(jsonl(fixture.log).filter((entry) => entry.kind === "process").length, before, "invalid batch starts no children");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi CLI accepts max and leaves model-dependent clamping to Pi", { timeout: 60_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start({ cli: true, thinking: "max" });
  assert.equal((await rpc.command("get_state")).thinkingLevel, "off", "non-reasoning model clamps max to off");
  const [child] = results(await rpc.prompt({ tag: "max-cli", calls: [
    childCall("max-child", { session: "max", thinking: "max" }),
  ] }));
  const observation = fixture.observation("max-child");
  assert.equal(observation.argv[observation.argv.indexOf("--thinking") + 1], "max");
  assert.equal(observation.thinking, "off");
  assert.equal(child.session.created, true);
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi explicitly loads the metadata helper when child extension discovery is disabled", { timeout: 60_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start({ rootOnly: true });
  const parent = await rpc.command("get_state");
  const [child] = results(await rpc.prompt({ tag: "helper", calls: [childCall("helper-child", { session: "helper-only" })] }));
  const observation = fixture.observation("helper-child");
  assert.equal(observation.depth, "1", "below the configured maximum, not a depth-guard case");
  assert.equal(observation.tools.includes("Agent"), false, "main extension is absent in the child");
  assert.equal(child.session.id, observation.header.id);
  assertOrigin(jsonl(observation.file), parent.sessionId, "worker", "helper-only");
  assert.equal(observation.diskEntries.length, 0, "helper does not force a placeholder flush");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});
