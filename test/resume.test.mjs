import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResumeInfo,
  isResumableSessionHandle,
  resolveResumedSessionId,
} from "../resume.ts";

test("isResumableSessionHandle matches exactly the raw child session id shape", () => {
  assert.equal(isResumableSessionHandle("subagent.0123456789abcdef"), true);
  assert.equal(isResumableSessionHandle("subagent.abcdef1234567890"), true);
  for (const handle of [
    "subagent.0123456789abcde", // 15 hex chars
    "subagent.0123456789abcdef0", // 17 hex chars
    "subagent.ABCDEF1234567890", // uppercase
    "subagent.0123456789abcdeg", // non-hex character
    "work",
    "session.0123456789abcdef",
    " subagent.0123456789abcdef",
    "",
  ]) {
    assert.equal(isResumableSessionHandle(handle), false, `handle: ${handle}`);
  }
});

test("resolveResumedSessionId resolves registry and on-disk child session ids", () => {
  const id = "subagent.0123456789abcdef";
  const onDisk = new Set(["/a\0" + id]);
  const lookup = {
    jobs: [
      { childSessionId: null, cwd: "/a" },
      { childSessionId: "subagent.ffffffffffffffff", cwd: "/a" },
      { childSessionId: id, cwd: "/other" },
      { childSessionId: id, cwd: "/a" },
    ],
    findSessionFile: (cwd, sessionId) =>
      onDisk.has(`${cwd}\0${sessionId}`) ? `/sessions/${sessionId}.jsonl` : undefined,
  };

  // Registry match in the resolving call's working directory.
  assert.equal(resolveResumedSessionId(id, lookup, "/a"), id);
  // Registry miss falls through to the on-disk scope.
  assert.equal(resolveResumedSessionId(id, { ...lookup, jobs: [] }, "/a"), id);
  // A registry match in a different working directory does not resolve the id,
  // and neither does a missing session file.
  assert.equal(
    resolveResumedSessionId(
      id,
      { ...lookup, jobs: lookup.jobs.slice(0, 3), findSessionFile: () => undefined },
      "/a",
    ),
    undefined,
  );
  assert.equal(
    resolveResumedSessionId(id, { ...lookup, jobs: [], findSessionFile: () => undefined }, "/a"),
    undefined,
  );
  // Resolution is scoped by the call's own working directory, not some
  // ambient one: the same registry resolves nothing under a different cwd.
  assert.equal(
    resolveResumedSessionId(id, { ...lookup, jobs: [] }, "/b"),
    undefined,
    "the on-disk scope follows the call cwd",
  );
  // Non-id-shaped handles never resolve as raw ids, even when a lookup would match.
  assert.equal(resolveResumedSessionId("work", { ...lookup, findSessionFile: () => "/x" }, "/a"), undefined);
});

test("buildResumeInfo guides one corrective resume call for persisted sessions", () => {
  const info = buildResumeInfo({
    agent: "worker",
    handle: "subagent.0123456789abcdef",
    persisted: true,
  });
  assert.equal(info.handle, "subagent.0123456789abcdef");
  assert.match(info.guidance, /session "subagent\.0123456789abcdef"/);
  assert.match(info.guidance, /agent "worker"/);
  assert.match(info.guidance, /failed mid-task/);
  assert.match(info.guidance, /retaining its earlier context/);
  assert.doesNotMatch(info.guidance, /cannot be resumed/);
  // The details shape stays JSON-serializable and additive.
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info);
});

test("buildResumeInfo is honest when nothing was persisted before the failure", () => {
  const info = buildResumeInfo({
    agent: "worker",
    handle: "subagent.0123456789abcdef",
    persisted: false,
  });
  assert.equal(info.handle, "subagent.0123456789abcdef");
  assert.match(info.guidance, /session "subagent\.0123456789abcdef"/);
  assert.match(info.guidance, /before its session was persisted/);
  assert.match(info.guidance, /restating the task/);
  assert.doesNotMatch(info.guidance, /retaining its earlier context/);
});

test("buildResumeInfo states that ephemeral failures cannot be resumed", () => {
  const info = buildResumeInfo({ agent: "worker", handle: null, persisted: false });
  assert.equal(info.handle, null);
  assert.match(info.guidance, /cannot be resumed/);
  assert.match(info.guidance, /Rerun the Agent call/);
  assert.match(info.guidance, /session handle/);
  assert.doesNotMatch(info.guidance, /session "/);
});
