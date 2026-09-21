import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerMetadata, { DELEGATION_CUSTOM_TYPE, DELEGATION_ENV } from "../delegation-metadata.ts";

const origin = {
  version: 1,
  childSessionId: "subagent.child",
  parentSessionId: "actual-parent",
  agent: "worker",
  handle: "work",
};

function harness(manager, payload = JSON.stringify(origin)) {
  let handler;
  const previous = process.env[DELEGATION_ENV];
  if (payload === undefined) delete process.env[DELEGATION_ENV];
  else process.env[DELEGATION_ENV] = payload;
  try {
    registerMetadata({
      on(event, callback) {
        assert.equal(event, "session_start");
        handler = callback;
      },
      appendEntry(type, data) { manager.appendCustomEntry(type, data); },
    });
  } finally {
    if (previous === undefined) delete process.env[DELEGATION_ENV];
    else process.env[DELEGATION_ENV] = previous;
  }
  return (reason = "startup", sessionManager = manager) => handler?.({ reason }, { sessionManager });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-metadata-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, manager: SessionManager.create(dir, dir, { id: origin.childSessionId }) };
}

function entries(manager) {
  return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === DELEGATION_CUSTOM_TYPE);
}

const assistant = {
  role: "assistant", content: [{ type: "text", text: "test response" }],
  api: "test", provider: "test", model: "test", stopReason: "stop", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

test("metadata uses Pi's buffered appendEntry persistence and stays out of model context", (t) => {
  const { manager } = fixture(t);
  const start = harness(manager);
  start();
  start();
  assert.equal(entries(manager).length, 1);
  assert.deepEqual(entries(manager)[0].data, origin);
  assert.equal(fs.existsSync(manager.getSessionFile()), false, "no eager flush or placeholder");
  assert.deepEqual(manager.buildSessionContext().messages, []);

  manager.appendMessage(assistant);
  const reopened = SessionManager.open(manager.getSessionFile());
  assert.deepEqual(entries(reopened), entries(manager));
  assert.deepEqual(reopened.buildSessionContext().messages, [assistant]);
});

test("origin is found across all branches and never rewritten on reload", (t) => {
  const { manager } = fixture(t);
  harness(manager)();
  const original = entries(manager);
  manager.resetLeaf();
  assert.deepEqual(manager.getBranch(), []);
  const changedPayload = JSON.stringify({ ...origin, parentSessionId: "wrong-parent" });
  harness(manager, changedPayload)();
  harness(manager, changedPayload)("reload");
  assert.deepEqual(entries(manager), original);
  assert.equal(manager.getLeafId(), null, "deduplication does not change the active branch");
});

test("copied origins neither assign ownership to forks nor suppress a new child's origin", (t) => {
  const { dir, manager } = fixture(t);
  harness(manager)();
  manager.appendMessage(assistant);
  const fork = SessionManager.forkFrom(manager.getSessionFile(), dir, dir, { id: "forked-child" });
  harness(fork)();
  assert.deepEqual(entries(fork), entries(manager), "inherited payload is bound to the original header");
  assert.equal(entries(fork).filter((entry) => entry.data.childSessionId === fork.getHeader().id).length, 0);

  const nextOrigin = { ...origin, childSessionId: fork.getSessionId(), parentSessionId: manager.getSessionId(), handle: "nested" };
  harness(fork, JSON.stringify(nextOrigin))();
  assert.deepEqual(entries(fork).map((entry) => entry.data), [origin, nextOrigin]);
  assert.deepEqual(entries(manager).map((entry) => entry.data), [origin], "child never edits parent history");
});

test("reload, new, resume and fork lifecycle events cannot annotate unmarked sessions", (t) => {
  const { manager } = fixture(t);
  for (const reason of ["reload", "new", "resume", "fork"]) {
    harness(manager)(reason);
    assert.deepEqual(entries(manager), []);
  }
  assert.equal(fs.existsSync(manager.getSessionFile()), false);
});

test("a launch cannot mark a switched session or an in-memory session", (t) => {
  const { dir, manager } = fixture(t);
  const start = harness(manager);
  const other = SessionManager.create(dir, dir, { id: "other-session" });
  start("startup", other);
  assert.deepEqual(entries(other), []);
  assert.deepEqual(entries(manager), []);
  harness(SessionManager.inMemory(dir, { id: origin.childSessionId }))();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("both actual session ID and containing header must match the payload", (t) => {
  const { manager } = fixture(t);
  const start = harness(manager);
  start("startup", {
    getSessionFile: () => manager.getSessionFile(),
    getSessionId: () => origin.childSessionId,
    getHeader: () => ({ id: "copied-header" }),
    getEntries: () => [],
  });
  assert.deepEqual(entries(manager), []);
});

test("missing, malformed and unsupported launch payloads are inert", (t) => {
  const { manager } = fixture(t);
  for (const payload of [
    "", "{", "null", "[]", "true", "1", '"text"', "{}",
    JSON.stringify({ ...origin, version: 2 }),
    JSON.stringify({ ...origin, childSessionId: origin.parentSessionId }),
    ...["childSessionId", "parentSessionId", "agent", "handle"].flatMap((key) =>
      [null, undefined, 4, "", " ", " padded "].map((value) => JSON.stringify({ ...origin, [key]: value }))),
  ]) {
    harness(manager, payload)();
  }
  assert.deepEqual(entries(manager), []);
  assert.equal(fs.existsSync(manager.getSessionFile()), false);
});

test("only contract fields are written from a launch payload", (t) => {
  const { manager } = fixture(t);
  harness(manager, JSON.stringify({ ...origin, pid: 1234, status: "running" }))();
  assert.deepEqual(entries(manager)[0].data, origin);
});
