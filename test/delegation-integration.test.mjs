import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const rpcEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
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

function childCall(tag, options = {}) {
  return { agent: "worker", prompt: JSON.stringify({ tag }), timeout: 25, inactivityTimeout: 20, ...options };
}

function results(event) {
  const tool = event.messages.findLast((message) => message.role === "toolResult" && message.toolName === "subagent");
  assert.ok(tool, "real Pi executed the production subagent tool");
  assert.equal(tool.isError, false, JSON.stringify(tool));
  assert.notEqual(tool.details.failed, true, JSON.stringify(tool));
  for (const result of tool.details.results) {
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stopReason, "stop", JSON.stringify(result));
  }
  return tool.details.results;
}

class Rpc {
  constructor(cwd, env, args) {
    this.events = [];
    this.waiters = new Set();
    this.stderr = "";
    this.proc = spawn(process.execPath, [rpcEntry, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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

function setup(t) {
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
    fs.writeFileSync(path.join(agentDir, "agents", `${agent}.md`), `---\nname: ${agent}\ndescription: Integration fixture\n---\nUse the deterministic test provider.\n`);
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
    start({ rootOnly = false, rootId = "delegation-test-root", launchPayload } = {}) {
      const launchEnv = { ...env };
      if (launchPayload) launchEnv.PI_SUBAGENT_DELEGATION = JSON.stringify(launchPayload);
      const client = new Rpc(cwd, launchEnv, [
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools",
        "--extension", provider,
        "--extension", rootOnly ? path.join(root, "test/fixtures/delegation-root-only.ts") : path.join(root, "index.ts"),
        // Deliberately omit the helper in the root-only case: runner.ts must supply it.
        ...(rootOnly ? [] : ["--extension", helper]),
        "--provider", "delegation-test", "--model", "deterministic",
        "--session-id", rootId, "--session-dir", sessionDir,
      ]);
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

  const [first] = results(await rpc.prompt({ tag: "first", calls: [childCall("first-child", { agent: " worker ", session: " work " })] }));
  assert.equal(first.session.created, true);
  const beforeFirst = fixture.observation("first-child");
  assert.equal(first.session.id, beforeFirst.header.id);
  assert.equal(beforeFirst.diskEntries.length, 0, "appendEntry remains buffered until a real assistant response");
  assert.deepEqual(beforeFirst.entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role), ["user"]);
  assert.equal(beforeFirst.entries.some((entry) => entry.type === "custom_message"), false, "no placeholder custom messages");
  assert.equal(origins(beforeFirst.entries).length, 1, "child appended metadata before its first model response");
  assert.equal(JSON.stringify(beforeFirst.contextMessages).includes(customType), false, "metadata is not model context");
  const firstEntries = jsonl(beforeFirst.file);
  const firstOrigin = assertOrigin(firstEntries, parent.sessionId, "worker", "work");
  assert.equal(firstEntries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 1);

  const [continued] = results(await rpc.prompt({ tag: "continue", calls: [childCall("continued-child", { session: "work", initialContext: "parent" })] }));
  assert.equal(continued.session.created, false);
  assert.equal(continued.session.id, first.session.id);
  assert.equal(continued.session.initialContextApplied, null);
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
  assert.equal(origins(seededEntries).length, 2, "copied ancestor does not suppress this child's origin");
  assert.deepEqual(origins(seededEntries)[0].data, ancestor);
  assert.notEqual(beforeSeeded.header.id, parent.sessionId, "Pi fork uses a new header identity");
  assert.ok(beforeSeeded.header.parentSession.startsWith(fixture.tmp), "fork source is the temporary parent snapshot");
  assert.equal(fs.existsSync(beforeSeeded.header.parentSession), false, "runner removed the fork snapshot");

  const [nested] = results({ messages: seededEntries.filter((entry) => entry.type === "message").map((entry) => entry.message) });
  const beforeNested = fixture.observation("nested-child");
  const nestedEntries = jsonl(beforeNested.file);
  assert.equal(nested.session.id, beforeNested.header.id);
  assertOrigin(nestedEntries, seeded.session.id, "leaf", "nested");
  assert.equal(origins(nestedEntries).length, 3, "both copied ancestors remain foreign to the nested header");
  assert.equal(beforeNested.depth, "2");
  assert.equal(beforeNested.tools.includes("subagent"), false, "depth guard disables delegation, not metadata");
  assert.notEqual(ownOrigins(nestedEntries)[0].data.parentSessionId, parent.sessionId, "nested parent is not the root");

  const persistedBeforeEphemeral = fs.readdirSync(fixture.sessionDir).filter((name) => name.endsWith(".jsonl")).sort();
  const ephemeral = results(await rpc.prompt({ tag: "ephemeral", calls: [
    childCall("ephemeral-empty"), childCall("ephemeral-parent", { initialContext: "parent" }),
  ] }));
  assert.ok(ephemeral.every((result) => result.session === undefined));
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
      assert.deepEqual(origins(observation.entries).map((entry) => entry.data), [ancestor]);
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

test("real Pi explicitly loads the metadata helper when child extension discovery is disabled", { timeout: 60_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start({ rootOnly: true });
  const parent = await rpc.command("get_state");
  const [child] = results(await rpc.prompt({ tag: "helper", calls: [childCall("helper-child", { session: "helper-only" })] }));
  const observation = fixture.observation("helper-child");
  assert.equal(observation.depth, "1", "below the configured maximum, not a depth-guard case");
  assert.equal(observation.tools.includes("subagent"), false, "main extension is absent in the child");
  assert.equal(child.session.id, observation.header.id);
  assertOrigin(jsonl(observation.file), parent.sessionId, "worker", "helper-only");
  assert.equal(observation.diskEntries.length, 0, "helper does not force a placeholder flush");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});
