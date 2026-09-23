import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertJobId,
  childCall,
  customType,
  jsonl,
  messageText,
  setup,
  waitForObservation,
} from "./fixtures/integration-harness.mjs";

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

function toolResultMessage(event) {
  return event.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
}

function failedResults(event) {
  const tool = toolResultMessage(event);
  assert.ok(tool, "real Pi executed the production Agent tool");
  assert.equal(tool.isError, true, "failed subagent calls surface as tool errors", JSON.stringify(tool));
  assert.equal(tool.details.failed, true, JSON.stringify(tool));
  return tool.details.results;
}

/** The Agent tool result of a turn, without foreground-completion assumptions. */
function agentTool(event) {
  const tool = event.messages.findLast((message) => message.role === "toolResult" && message.toolName === "Agent");
  assert.ok(tool, "real Pi executed the production Agent tool");
  assert.equal(tool.isError, false, JSON.stringify(tool));
  return tool;
}

/** Every result of one companion tool in a turn, in execution order. */
function companionTools(event, name) {
  const tools = event.messages.filter((message) => message.role === "toolResult" && message.toolName === name);
  assert.ok(tools.length > 0, `real Pi executed the ${name} tool`);
  return tools;
}

/** One companion tool result of a turn by index (default the first). */
function companionTool(event, name, index = 0) {
  const tools = companionTools(event, name);
  assert.ok(tools.length > index, `a ${name} result exists at index ${index}`);
  const tool = tools[index];
  assert.equal(tool.isError, false, JSON.stringify(tool));
  return tool;
}

/** One companion tool result that must be an error, with its message. */
function companionToolError(event, name, index = 0) {
  const tools = companionTools(event, name);
  assert.ok(tools.length > index, `a ${name} result exists at index ${index}`);
  const tool = tools[index];
  assert.equal(tool.isError, true, JSON.stringify(tool));
  return tool;
}

/** Wait for a background job's injected summary to arrive as a queued user message. */
function backgroundSummaryWait(rpc, from) {
  return rpc.wait(
    (event) => event.type === "message_end" && event.message.role === "user" &&
      messageText(event.message).includes("Background subagent job"),
    from,
  );
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

test("real Pi resumes a failed subagent from its preserved session with one corrective call", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();
  const parent = await rpc.command("get_state");

  // Turn 1: a named-session child fails mid-task after making real progress.
  const failTurn = await rpc.prompt({ tag: "fail-soft", calls: [
    childCall("failing", {
      session: "resumable",
      prompt: JSON.stringify({ tag: "failing", fail: { partial: "partial progress before the scripted failure", error: "scripted subagent failure" } }),
    }),
  ] });
  const [failed] = failedResults(failTurn);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.errorMessage, "scripted subagent failure");
  assert.equal(failed.session.created, true);
  const handle = failed.session.id;
  assert.match(handle, /^subagent\.[0-9a-f]{16}$/);

  // The partial output collected up to the failure is retained on the result.
  assert.ok(
    failed.messages.some((message) => message.role === "assistant" &&
      JSON.stringify(message.content).includes("partial progress before the scripted failure")),
    "the failure result carries the partial output",
  );

  // The job failed but resolved the flushed child session file; nothing
  // truncated or cleaned it.
  assertJobId(failed.job);
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.childSessionId, handle);
  assert.equal(failed.job.childSessionFile, fixture.observation("failing").file);
  assert.ok(fs.existsSync(failed.job.childSessionFile), "the failed child's session file survives");

  // Resume guidance is embedded in the result details and in the content the
  // model sees, worded for one corrective call with the handle.
  assert.equal(failed.resume.handle, handle);
  assert.match(failed.resume.guidance, new RegExp(`session "${handle}"`));
  assert.match(failed.resume.guidance, /agent "worker"/);
  assert.match(failed.resume.guidance, /retaining its earlier context/);
  const failureContent = toolResultMessage(failTurn).content[0].text;
  assert.match(failureContent, new RegExp(`session "${handle}"`));
  assert.match(failureContent, /partial progress before the scripted failure/);
  assert.ok(
    failureContent.indexOf(`session "${handle}"`) < failureContent.indexOf("partial progress before the scripted failure"),
    "guidance precedes the partial output",
  );

  // The session lock held around the failed run is released, leaving the
  // session resumable by the next call.
  assert.equal(
    fs.existsSync(path.join(fixture.sessionDir, ".pi-subagent-locks", `${handle}.lock`)),
    false,
    "the failed run released its session lock",
  );

  // The parent session records the failed job's lifecycle as origin entries.
  const parentOrigins = () => jsonl(parent.sessionFile)
    .filter((entry) => entry.type === "custom" && entry.customType === customType);
  assert.deepEqual(
    parentOrigins().filter((entry) => entry.data.jobId === failed.job.id).map((entry) => entry.data.status),
    ["running", "failed"],
  );

  // Turn 2: ONE corrective call with the handle continues the persisted
  // session from where the child died.
  const beforeEntries = jsonl(failed.job.childSessionFile);
  const resumeTurn = await rpc.prompt({ tag: "fail-soft-resume", calls: [
    childCall("resumed", { session: handle, prompt: JSON.stringify({ tag: "resumed" }) }),
  ] });
  const [resumed] = results(resumeTurn);
  assert.equal(resumed.session.created, false, "the handle continues the existing session");
  assert.equal(resumed.session.id, handle);
  assert.equal(resumed.session.handle, handle);
  assert.equal(resumed.session.initialContextApplied, null);
  assertJobId(resumed.job);
  assert.notEqual(resumed.job.id, failed.job.id, "the resume is its own job");
  assert.equal(resumed.job.status, "done");
  assert.equal(resumed.job.childSessionId, handle);
  assert.equal(resumed.job.childSessionFile, failed.job.childSessionFile);
  assert.deepEqual(
    parentOrigins().filter((entry) => entry.data.jobId === resumed.job.id).map((entry) => entry.data.status),
    ["running", "done"],
  );
  assert.equal(
    parentOrigins().find((entry) => entry.data.jobId === resumed.job.id).data.handle,
    handle,
    "the resumed call records the raw session id as its handle",
  );

  // The resumed child retained the context from before the failure and
  // completed the task using the prior progress.
  const resumedObservation = fixture.observation("resumed");
  assert.equal(resumedObservation.sessionId, handle);
  assert.equal(resumedObservation.header.id, handle);
  const contextText = JSON.stringify(resumedObservation.contextMessages);
  assert.match(contextText, /partial progress before the scripted failure/, "prior progress is in the resumed child's context");
  const lastUser = resumedObservation.contextMessages.findLast((m) => m.role === "user");
  const lastUserText = typeof lastUser?.content === "string" ? lastUser.content
    : (lastUser?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
  assert.equal(lastUserText, JSON.stringify({ tag: "resumed" }), "the corrective prompt is delivered");
  const afterEntries = jsonl(resumedObservation.file);
  assert.deepEqual(afterEntries.slice(0, beforeEntries.length), beforeEntries, "resume preserves the failed run's history verbatim");
  assert.ok(afterEntries.length > beforeEntries.length, "the resumed run appended new work");

  // Turn 3: the original named handle still continues the same session —
  // existing named-session continuation is unaffected.
  const continueTurn = await rpc.prompt({ tag: "fail-soft-continue", calls: [
    childCall("continued", { session: "resumable" }),
  ] });
  const [continued] = results(continueTurn);
  assert.equal(continued.session.created, false);
  assert.equal(continued.session.id, handle);
  assert.equal(continued.session.handle, "resumable");
  assert.equal(continued.job.status, "done");
  assert.deepEqual(jsonl(fixture.observation("continued").file).slice(0, afterEntries.length), afterEntries, "handle continuation preserves history verbatim");
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi reports ephemeral failures as not resumable", { timeout: 60_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();

  const turn = await rpc.prompt({ tag: "ephemeral-fail", calls: [
    childCall("ephemeral-failing", {
      prompt: JSON.stringify({ tag: "ephemeral-failing", fail: { partial: "progress that cannot be recovered", error: "scripted ephemeral failure" } }),
    }),
  ] });
  const [failed] = failedResults(turn);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.errorMessage, "scripted ephemeral failure");
  assert.equal(failed.session, undefined, "the call was ephemeral");
  assertJobId(failed.job);
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.childSessionId, null, "ephemeral jobs have no session handle");
  assert.equal(failed.resume.handle, null, "no handle to resume");
  assert.match(failed.resume.guidance, /cannot be resumed/);
  assert.match(failed.resume.guidance, /Rerun the Agent call/);
  const failureContent = toolResultMessage(turn).content[0].text;
  assert.match(failureContent, /cannot be resumed/);
  assert.match(failureContent, /progress that cannot be recovered/);
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi preserves a killed subagent's session and resumes it by handle", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();

  // Turn 1: the child makes real progress (a note and a completed grandchild
  // delegation), then stalls on its follow-up model request and is killed by
  // its inactivity watchdog mid-run.
  const killTurn = await rpc.prompt({ tag: "kill", calls: [
    childCall("kill-child", {
      session: "kill-resume",
      inactivityTimeout: 2,
      timeout: 20,
      prompt: JSON.stringify({
        tag: "kill-child",
        note: "progress before the hard kill",
        hang: true,
        calls: [childCall("kill-grandchild", { agent: "leaf" })],
      }),
    }),
  ] });
  const [killed] = failedResults(killTurn);
  assert.equal(killed.exitCode, 1);
  assert.equal(killed.processError, true);
  assert.match(killed.errorMessage, /inactivity timeout/);
  assert.ok(
    killed.messages.some((message) => message.role === "assistant" &&
      JSON.stringify(message.content).includes("progress before the hard kill")),
    "partial output was captured before the kill",
  );
  const handle = killed.session.id;
  assert.match(handle, /^subagent\.[0-9a-f]{16}$/);
  assert.equal(killed.job.status, "failed");
  assert.equal(killed.job.childSessionId, handle);
  assert.ok(killed.job.childSessionFile, "the killed child's session file survives the kill");
  assert.equal(killed.job.childSessionFile, fixture.observation("kill-child").file);
  assert.equal(killed.resume.handle, handle);
  assert.match(killed.resume.guidance, /retaining its earlier context/);

  // The killed child's session file retains the progress it flushed before
  // dying: nothing truncates or cleans it on failure.
  const beforeEntries = jsonl(killed.job.childSessionFile);
  assert.ok(
    beforeEntries.some((entry) => entry.type === "message" &&
      JSON.stringify(entry).includes("progress before the hard kill")),
    "the killed child's session retained its partial progress",
  );

  // Turn 2: one corrective resume call completes the task from the preserved
  // session; the child retains context from before the kill.
  const resumeTurn = await rpc.prompt({ tag: "kill-resume", calls: [
    childCall("resumed-kill", { session: handle, timeout: 20, prompt: JSON.stringify({ tag: "resumed-kill" }) }),
  ] });
  const [resumed] = results(resumeTurn);
  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.session.id, handle);
  assert.equal(resumed.session.created, false);
  assert.equal(resumed.job.status, "done");
  assert.equal(resumed.job.childSessionId, handle);
  const resumedObservation = fixture.observation("resumed-kill");
  assert.equal(resumedObservation.sessionId, handle);
  assert.match(
    JSON.stringify(resumedObservation.contextMessages),
    /progress before the hard kill/,
    "the killed run's progress is in the resumed child's context",
  );
  assert.deepEqual(
    jsonl(resumedObservation.file).slice(0, beforeEntries.length),
    beforeEntries,
    "the killed run's history is preserved verbatim",
  );
  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi returns background subagent calls immediately and delivers results as queued follow-up messages", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();
  const parent = await rpc.command("get_state");

  // The child deliberately takes 4s; the tool call must return long before.
  const firstTurn = await rpc.prompt({
    tag: "bg-start",
    calls: [childCall("bg-slow", {
      background: true,
      session: "bg",
      prompt: JSON.stringify({ tag: "bg-slow", delayMs: 4000 }),
    })],
  });

  // Immediate return: the serialized tool result carries the job id while the
  // detached child is still running.
  const tool = agentTool(firstTurn);
  const [bg] = tool.details.results;
  assertJobId(bg.job);
  assert.equal(bg.job.agent, "worker");
  assert.equal(bg.job.status, "running", "the tool result reports the detached job as running");
  assert.equal(bg.exitCode, -1, "the detached call has no completed child result yet");
  assert.equal(bg.job.childSessionId, bg.session.id);
  assert.equal(bg.job.model, "delegation-test/deterministic");
  const ackText = messageText(tool);
  assert.match(ackText, /Background subagent started:/);
  assert.match(ackText, new RegExp(`- ${bg.job.id} \\(worker\\): running`));
  assert.match(ackText, /This call returns immediately/);
  assert.match(ackText, /subagent_result tool/);

  // The chat stays usable while the child runs: a second turn completes well
  // before the 4s child can finish.
  const secondTurn = await rpc.prompt({ tag: "while-running" });
  assert.match(messageText(secondTurn.messages.at(-1)), /fixture:while-running/);

  // Completion injects the compact summary as a queued user message that is
  // delivered as a new turn once the parent is idle.
  const afterSecond = rpc.events.length;
  const summary = await backgroundSummaryWait(rpc, afterSecond);
  const summaryText = messageText(summary.message);
  assert.match(summaryText, new RegExp(`^Background subagent job ${bg.job.id} \\(worker\\) completed after [0-9.]+s\\.`));
  assert.match(summaryText, /Output:\nfixture:bg-slow/);
  assert.match(summaryText, /The full output of this job remains available on demand via the subagent_result tool\./);
  const elapsedSeconds = Number(summaryText.match(/after ([0-9.]+)s\./)[1]);
  assert.ok(elapsedSeconds >= 3, "the summary arrives only after the slow child finishes");
  await rpc.wait((event) => event.type === "agent_settled", afterSecond);

  // The queued summary is persisted in the parent session JSONL as a user message.
  const parentEntries = jsonl(parent.sessionFile);
  const summaryEntries = parentEntries.filter(
    (entry) => entry.type === "message" && entry.message.role === "user" &&
      messageText(entry.message).startsWith("Background subagent job"),
  );
  assert.equal(summaryEntries.length, 1, "exactly one injected background summary");
  assert.equal(messageText(summaryEntries[0].message), summaryText);

  // Job lifecycle entries mirror the background run in the parent session.
  const jobEntries = parentEntries
    .filter((entry) => entry.type === "custom" && entry.customType === customType && entry.data.jobId === bg.job.id);
  assert.deepEqual(jobEntries.map((entry) => entry.data.status), ["running", "done"]);

  // The background job released its session lock and reserved session id: the
  // same handle continues the session the detached child created.
  const [reused] = results(await rpc.prompt({
    tag: "bg-reuse",
    calls: [childCall("bg-reuse", { session: "bg" })],
  }));
  assert.equal(reused.session.created, false);
  assert.equal(reused.session.id, bg.job.childSessionId);
  assert.equal(reused.job.status, "done");
  const lockRoot = path.join(fixture.sessionDir, ".pi-subagent-locks");
  assert.deepEqual(
    fs.readdirSync(lockRoot).filter((name) => name.endsWith(".lock")),
    [],
    "no background session lock is left behind",
  );

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
  assert.deepEqual(fs.readdirSync(fixture.tmp).filter((name) => name.startsWith("pi-subagent-")), [], "runner temporary resources cleaned up");
});

test("real Pi notifies when a background subagent fails", { timeout: 120_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();
  const parent = await rpc.command("get_state");

  const firstTurn = await rpc.prompt({
    tag: "bg-fail",
    calls: [childCall("bg-fail-child", {
      background: true,
      session: "bg-fail",
      prompt: JSON.stringify({ tag: "bg-fail-child", fail: true }),
    })],
  });

  const [bg] = agentTool(firstTurn).details.results;
  assertJobId(bg.job);
  assert.equal(bg.job.status, "running", "the immediate return precedes the child failure");

  // The failure is injected through the same queued-message path, phrased for
  // the dead child.
  const from = rpc.events.length;
  const summary = await backgroundSummaryWait(rpc, from);
  const text = messageText(summary.message);
  assert.match(text, new RegExp(`^Background subagent job ${bg.job.id} \\(worker\\) failed after [0-9.]+s\\.`));
  assert.match(text, /Error:\nSubagent error: Error: deliberate fixture failure/);
  assert.match(text, /The full output of this job remains available on demand via the subagent_result tool\./);
  const failedElapsed = Number(text.match(/after ([0-9.]+)s\./)[1]);
  await rpc.wait((event) => event.type === "agent_settled", from);

  const parentEntries = jsonl(parent.sessionFile);
  const failureEntry = parentEntries.find(
    (entry) => entry.type === "message" && entry.message.role === "user" &&
      messageText(entry.message).includes("failed after"),
  );
  assert.ok(failureEntry, "the failure notification is persisted as a user message");
  const jobEntries = parentEntries
    .filter((entry) => entry.type === "custom" && entry.customType === customType && entry.data.jobId === bg.job.id);
  assert.deepEqual(jobEntries.map((entry) => entry.data.status), ["running", "failed"]);

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi caps injected background summaries at the per-child output limit", { timeout: 120_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();
  const parent = await rpc.command("get_state");

  const firstTurn = await rpc.prompt({
    tag: "bg-cap",
    calls: [childCall("bg-cap-child", {
      background: true,
      session: "bg-cap",
      prompt: JSON.stringify({ tag: "bg-cap-child", bigOutputBytes: 60_000 }),
    })],
  });

  const [bg] = agentTool(firstTurn).details.results;
  assertJobId(bg.job);

  const from = rpc.events.length;
  const summary = await backgroundSummaryWait(rpc, from);
  const text = messageText(summary.message);
  assert.match(text, new RegExp(`^Background subagent job ${bg.job.id} \\(worker\\) completed after [0-9.]+s\\.`));
  assert.match(text, /\[Output truncated to the 50\.0KB per-child cap\.\]/);
  assert.ok(Buffer.byteLength(text, "utf8") < 52_000, "the injected summary stays within the 50KB cap plus a small header");
  assert.match(text, /subagent_result tool/);
  await rpc.wait((event) => event.type === "agent_settled", from);

  // The full output never enters the parent context: it stays in the child's
  // persisted session file on disk.
  const child = fixture.observation("bg-cap-child");
  const childOutput = jsonl(child.file)
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => messageText(entry.message))
    .join("");
  assert.ok(Buffer.byteLength(childOutput, "utf8") >= 60_000, "the child produced oversized output");
  assert.equal(text.includes(childOutput), false, "the full oversized output is not injected");
  const injectedEntry = jsonl(parent.sessionFile).find(
    (entry) => entry.type === "message" && entry.message.role === "user" &&
      messageText(entry.message).startsWith("Background subagent job"),
  );
  assert.ok(injectedEntry);
  assert.equal(messageText(injectedEntry.message), text);

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi runs mixed foreground and background calls in one invocation", { timeout: 120_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();

  const turn = await rpc.prompt({
    tag: "mixed",
    calls: [
      childCall("mixed-fg"),
      childCall("mixed-bg", { background: true, prompt: JSON.stringify({ tag: "mixed-bg", delayMs: 3000 }) }),
    ],
  });

  const tool = agentTool(turn);
  assert.equal(tool.details.results.length, 2);
  assert.deepEqual(tool.details.results.map((result) => result.callIndex), [0, 1]);
  const [foreground, background] = tool.details.results;

  // Foreground behavior is unchanged: the call blocks the invocation and
  // returns its completed result alongside the background acknowledgment.
  assert.equal(foreground.exitCode, 0, JSON.stringify(foreground));
  assert.equal(foreground.stopReason, "stop", JSON.stringify(foreground));
  assertJobId(foreground.job);
  assert.equal(foreground.job.status, "done");

  // The background call detached: the invocation returned while it ran.
  assertJobId(background.job);
  assert.notEqual(background.job.id, foreground.job.id);
  assert.equal(background.job.status, "running");
  assert.equal(background.exitCode, -1);

  const text = messageText(tool);
  assert.match(text, /Background subagent started:/);
  assert.match(text, new RegExp(`- ${background.job.id} \\(worker\\): running`));
  assert.match(text, /1\/1 succeeded/);
  assert.match(text, /fixture:mixed-fg/);

  const from = rpc.events.length;
  const summary = await backgroundSummaryWait(rpc, from);
  const summaryText = messageText(summary.message);
  assert.match(summaryText, new RegExp(`^Background subagent job ${background.job.id} \\(worker\\) completed after [0-9.]+s\\.`));
  assert.match(summaryText, /Output:\nfixture:mixed-bg/);
  await rpc.wait((event) => event.type === "agent_settled", from);

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});
// ---------------------------------------------------------------------------
// Companion tools: subagent_status and subagent_result (ticket 03)
// ---------------------------------------------------------------------------

test("real Pi lists subagent jobs through subagent_status without leaking task text", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();
  const parent = await rpc.command("get_state");

  // Before any delegation the listing explains itself.
  const emptyTurn = await rpc.prompt({ tag: "status-empty", tools: [{ name: "subagent_status" }] });
  const emptyTool = companionTool(emptyTurn, "subagent_status");
  assert.match(messageText(emptyTool), /^No subagent jobs have been started in this session\./);
  assert.deepEqual(emptyTool.details, { kind: "pi-subagent-status", jobs: [] });

  // Start a slow background child whose prompt carries a distinctive marker.
  const startTurn = await rpc.prompt({
    tag: "status-start",
    calls: [childCall("status-slow", {
      background: true,
      session: "status",
      prompt: JSON.stringify({ tag: "status-slow", delayMs: 5000 }),
    })],
  });
  const [bg] = agentTool(startTurn).details.results;
  assertJobId(bg.job);
  const jobId = bg.job.id;

  // While the child runs, the listing reflects the live registry state.
  const whileTurn = await rpc.prompt({
    tag: "status-while",
    tools: [
      { name: "subagent_status" },
      { name: "subagent_status", arguments: { job: jobId } },
      { name: "subagent_status", arguments: { job: "job-ffffffffffff" } },
    ],
  });
  const [listing, filtered, unknown] = [
    companionTool(whileTurn, "subagent_status", 0),
    companionTool(whileTurn, "subagent_status", 1),
    companionToolError(whileTurn, "subagent_status", 2),
  ];

  const listingText = messageText(listing);
  assert.match(listingText, /^Subagent jobs \(1 total: 1 running\):/);
  assert.match(listingText, new RegExp(`- ${jobId} \\(worker\\): running, [0-9.]+s elapsed`));
  // Privacy filter: neither the task prompt nor any output appears.
  assert.ok(!listingText.includes("status-slow"), "no task text leaks into the listing");
  assert.ok(!listingText.includes("delayMs"), "no prompt fields leak into the listing");
  assert.ok(!listingText.includes("fixture:"), "no output leaks into the listing");
  assert.match(listingText, /privacy-filtered: it carries no prompts or output/);
  assert.equal(listing.details.kind, "pi-subagent-status");
  assert.equal(listing.details.jobs.length, 1);
  const entry = listing.details.jobs[0];
  assert.equal(entry.id, jobId);
  assert.equal(entry.agent, "worker");
  assert.equal(entry.status, "running");
  assert.equal(typeof entry.age, "number");
  assert.ok(entry.elapsedMs >= 0);
  for (const key of ["prompt", "output", "messages"]) {
    assert.ok(!(key in entry), `listing entries carry no ${key}`);
  }

  const filteredText = messageText(filtered);
  assert.match(filteredText, /^Subagent jobs \(1 total: 1 running\):/);
  assert.match(filteredText, new RegExp(`- ${jobId} \\(worker\\): running`));

  assert.match(messageText(unknown), /Unknown subagent job "job-ffffffffffff"/);
  assert.equal(unknown.details.failed, true);

  // After the child finishes, the same listing reports it as done.
  const from = rpc.events.length;
  const summary = await backgroundSummaryWait(rpc, from);
  assert.match(messageText(summary.message), new RegExp(`^Background subagent job ${jobId} \\(worker\\) completed after`));
  await rpc.wait((event) => event.type === "agent_settled", from);

  const doneTurn = await rpc.prompt({ tag: "status-done", tools: [{ name: "subagent_status" }] });
  const doneTool = companionTool(doneTurn, "subagent_status");
  const doneText = messageText(doneTool);
  assert.match(doneText, /^Subagent jobs \(1 total: 1 done\):/);
  assert.match(doneText, new RegExp(`- ${jobId} \\(worker\\): done, ran [0-9.]+s`));
  assert.equal(doneTool.details.jobs[0].status, "done");

  // The status turns are ordinary persisted user turns in the parent session.
  const statusTurns = jsonl(parent.sessionFile).filter(
    (json) => json.type === "message" && json.message.role === "user" && messageText(json.message).includes('"tag":"status-while"'),
  );
  assert.ok(statusTurns.length >= 1, "the status turn is a normal user turn in the session");

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi collects finished, running, and unknown job results through subagent_result", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();

  // One foreground child that finishes inside the invocation, and one slow
  // background child.
  const fgTurn = await rpc.prompt({
    tag: "res-fg",
    calls: [childCall("res-fg", { prompt: JSON.stringify({ tag: "res-fg" }) })],
  });
  const [fg] = results(fgTurn);
  assertJobId(fg.job);

  const bgTurn = await rpc.prompt({
    tag: "res-bg",
    calls: [childCall("res-slow", {
      background: true,
      session: "res-handle",
      prompt: JSON.stringify({ tag: "res-slow", delayMs: 4000 }),
    })],
  });
  const [slow] = agentTool(bgTurn).details.results;
  assertJobId(slow.job);

  // While the background child runs: a finished job returns its full stored
  // output, a running job reports not-done, and neither blocks the turn.
  const collectTurn = await rpc.prompt({
    tag: "res-collect",
    tools: [
      { name: "subagent_result", arguments: { job: fg.job.id } },
      { name: "subagent_result", arguments: { job: slow.job.id } },
    ],
  });
  const [finished, notReady] = [
    companionTool(collectTurn, "subagent_result", 0),
    companionTool(collectTurn, "subagent_result", 1),
  ];

  const finishedText = messageText(finished);
  assert.match(finishedText, new RegExp(`^Subagent job ${fg.job.id} \\(agent worker\\) completed after [0-9.]+s\\.`));
  assert.match(finishedText, /^Status: done \(exit code 0, stop reason "stop"\)$/m);
  assert.match(finishedText, /Output:\nfixture:res-fg/);
  assert.equal(finished.details.kind, "pi-subagent-result");
  assert.equal(finished.details.ready, true);
  assert.equal(finished.details.job.id, fg.job.id);
  assert.equal(finished.details.result.exitCode, 0);
  assert.equal(messageText(finished.details.result.messages.at(-1)), "fixture:res-fg");

  const notReadyText = messageText(notReady);
  assert.match(notReadyText, new RegExp(`^Subagent job ${slow.job.id} \\(agent worker\\) is still running \\([0-9.]+s elapsed\\)\\.`));
  assert.match(notReadyText, /Its result is not ready yet\. This call never blocks/);
  assert.equal(notReady.details.ready, false);
  assert.equal(notReady.details.failed, undefined);
  assert.equal(notReady.details.job.status, "running");
  assert.equal(notReady.details.result, undefined);

  // Once the background job finishes, its full output is collectable by job
  // id and by the session handle the call used.
  const from = rpc.events.length;
  await backgroundSummaryWait(rpc, from);
  await rpc.wait((event) => event.type === "agent_settled", from);

  const afterTurn = await rpc.prompt({
    tag: "res-after",
    tools: [
      { name: "subagent_result", arguments: { job: slow.job.id } },
      { name: "subagent_result", arguments: { handle: "res-handle" } },
    ],
  });
  const [byId, byHandle] = [
    companionTool(afterTurn, "subagent_result", 0),
    companionTool(afterTurn, "subagent_result", 1),
  ];
  for (const tool of [byId, byHandle]) {
    assert.equal(tool.details.ready, true);
    assert.equal(tool.details.job.id, slow.job.id);
    assert.match(messageText(tool), /Output:\nfixture:res-slow/);
  }
  assert.equal(byHandle.details.job.handle, "res-handle");

  // An unknown job id errors clearly.
  const errorTurn = await rpc.prompt({
    tag: "res-unknown",
    tools: [{ name: "subagent_result", arguments: { job: "job-ffffffffffff" } }],
  });
  const errorTool = companionToolError(errorTurn, "subagent_result");
  assert.match(messageText(errorTool), /Unknown subagent job "job-ffffffffffff"/);
  assert.equal(errorTool.details.failed, true);
  assert.equal(errorTool.details.job, null);

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

test("real Pi keeps oversized collected output whole in details while capping the text", { timeout: 120_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();

  const bgTurn = await rpc.prompt({
    tag: "res-big",
    calls: [childCall("res-big", {
      background: true,
      session: "res-big",
      prompt: JSON.stringify({ tag: "res-big", bigOutputBytes: 60_000 }),
    })],
  });
  const [big] = agentTool(bgTurn).details.results;
  assertJobId(big.job);

  const from = rpc.events.length;
  const summary = await backgroundSummaryWait(rpc, from);
  await rpc.wait((event) => event.type === "agent_settled", from);
  assert.match(messageText(summary.message), /\[Output truncated to the 50\.0KB per-child cap\.\]/);

  // The collected result caps the included text at the same per-child limit
  // but carries the full stored output in its details.
  const collectTurn = await rpc.prompt({
    tag: "res-big-collect",
    tools: [{ name: "subagent_result", arguments: { job: big.job.id } }],
  });
  const tool = companionTool(collectTurn, "subagent_result");
  const text = messageText(tool);
  assert.match(text, new RegExp(`^Subagent job ${big.job.id} \\(agent worker\\) completed after`));
  assert.match(text, /\[Output truncated to the 50\.0KB per-child cap\. The full output remains in the child's session file on disk\.\]/);
  assert.ok(Buffer.byteLength(text, "utf8") < 52_000, "the collected text stays within the cap plus a small header");
  assert.equal(tool.details.ready, true);
  const fullOutput = messageText(tool.details.result.messages.at(-1));
  assert.ok(Buffer.byteLength(fullOutput, "utf8") >= 60_000, "the full oversized output is stored in details");
  assert.ok(!text.includes(fullOutput), "the capped text never includes the full oversized output");

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

// ---------------------------------------------------------------------------
// Mid-run steering (ticket 05)
// ---------------------------------------------------------------------------

test("real Pi steers a running background child mid-run without blocking the parent", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();
  const steerMessage = "Pivot to course B: the second artifact must reflect this steering message.";

  // A detached child runs the two-course script: its first response is
  // delayed so the steering message queues while the child is mid-run, and
  // its second response — after the steering message is delivered — writes
  // an artifact that reflects the steering text.
  const startTurn = await rpc.prompt({
    tag: "steer-start",
    calls: [childCall("steer-child", {
      background: true,
      session: "steer-me",
      prompt: JSON.stringify({ tag: "steer-child", steerCourse: true, steerDelayMs: 3000 }),
    })],
  });
  const [bg] = agentTool(startTurn).details.results;
  assertJobId(bg.job);
  assert.equal(bg.job.status, "running", "the detached child runs while the parent chats");

  // Steer the running child through the real subagent_steer tool. The call
  // returns as soon as the child acknowledges the queued message; the child
  // keeps running and is never restarted.
  const steerTurn = await rpc.prompt({
    tag: "steer-mid",
    tools: [{ name: "subagent_steer", arguments: { handle: "steer-me", message: steerMessage } }],
  });
  const steerTool = companionTool(steerTurn, "subagent_steer");
  assert.match(
    messageText(steerTool),
    new RegExp(`^Steering message delivered to subagent job ${bg.job.id} \\(agent worker\\)`),
  );
  assert.equal(steerTool.details.delivered, true);
  assert.equal(steerTool.details.job.id, bg.job.id);
  assert.equal(steerTool.details.job.status, "running", "the steer returned while the child was still running");

  // Steering a background job does not block the parent conversation: an
  // ordinary turn completes while the steered child keeps working.
  const chatTurn = await rpc.prompt({ tag: "steer-while-running" });
  assert.match(messageText(chatTurn.messages.at(-1)), /fixture:steer-while-running/);

  // The steered child finishes its two-course script and delivers its summary.
  const from = rpc.events.length;
  const summary = await backgroundSummaryWait(rpc, from);
  assert.match(messageText(summary.message), new RegExp(`^Background subagent job ${bg.job.id} \\(worker\\) completed`));
  await rpc.wait((event) => event.type === "agent_settled", from);

  // The course changed: artifact A reflects the original prompt only, while
  // artifact B — written after the steering message was delivered — reflects
  // the steering text.
  const artifactA = fs.readFileSync(path.join(fixture.cwd, "steer-child-a.txt"), "utf8");
  assert.match(artifactA, /^course: A\n/);
  assert.ok(!artifactA.includes("steer:"), "artifact A predates the steering message");
  const artifactB = fs.readFileSync(path.join(fixture.cwd, "steer-child-b.txt"), "utf8");
  assert.match(artifactB, /^course: B\n/);
  assert.ok(artifactB.includes(`steer: ${steerMessage}`), "artifact B reflects the steering message");

  // The steered child's session shows the injected user message, and the run
  // continued in the same session — steering never restarted the child.
  // (Requests after the steering message carry no plan tag: the injected
  // user text is not JSON, so they are matched by session id.)
  const childRequests = jsonl(fixture.log).filter(
    (record) => record.kind === "request" && record.sessionId === bg.job.childSessionId,
  );
  assert.ok(childRequests.length >= 3, "the steered child made both scripted requests");
  const childSessionFile = childRequests.find((record) => record.file)?.file;
  assert.ok(childSessionFile, "the steered child flushed a session file");
  const steeredMessages = jsonl(childSessionFile).filter(
    (entry) => entry.type === "message" && entry.message.role === "user" &&
      messageText(entry.message) === steerMessage,
  );
  assert.equal(
    steeredMessages.length,
    1,
    "the steering message is persisted as a user message in the child session",
  );

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

// ---------------------------------------------------------------------------
// Child questions: ask_parent relayed end to end (ticket 09)
// ---------------------------------------------------------------------------

test("real Pi relays a child question to the parent and the child completes with the answer", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t);
  const rpc = fixture.start();

  // A detached child asks the parent mid-task and blocks on the answer.
  const startTurn = await rpc.prompt({
    tag: "ask-start",
    calls: [childCall("ask-child", {
      background: true,
      session: "ask-me",
      timeout: 60,
      inactivityTimeout: 50,
      prompt: JSON.stringify({
        tag: "ask-child",
        note: "working before the question",
        ask: "What is the answer to the task?",
      }),
    })],
  });
  const [bg] = agentTool(startTurn).details.results;
  assertJobId(bg.job);

  // The question is relayed into the parent session as a queued user message:
  // a real persisted user turn naming the job and pointing at subagent_reply.
  const questionFrom = rpc.events.length;
  const questionEvent = await rpc.wait(
    (event) => event.type === "message_end" && event.message.role === "user" &&
      messageText(event.message).includes("is asking a question mid-task"),
    questionFrom,
  );
  const questionText = messageText(questionEvent.message);
  assert.match(questionText, new RegExp(`^Subagent job ${bg.job.id} \\(agent worker\\) is asking a question mid-task:`));
  assert.match(questionText, /What is the answer to the task\?/);
  assert.match(questionText, new RegExp("Reply with the subagent_reply tool, passing `job` " + JSON.stringify(bg.job.id)));

  // The parent answers through the real subagent_reply tool (the fixture
  // recognizes the relayed question's phrasing and emits the reply call), and
  // the answer turn settles without errors.
  const answerFrom = rpc.events.length;
  await rpc.wait((event) => event.type === "agent_settled", answerFrom, 60_000);
  const replyTools = rpc.events
    .slice(answerFrom)
    .flatMap((event) => (event.type === "agent_end" ? event.messages : []))
    .filter((message) => message.role === "toolResult" && message.toolName === "subagent_reply");
  assert.equal(replyTools.length, 1, "exactly one subagent_reply tool result");
  assert.equal(replyTools[0].isError, false, JSON.stringify(replyTools[0]));
  assert.match(messageText(replyTools[0]), new RegExp(`^Answer delivered to subagent job ${bg.job.id}`));

  // The child completes the task using the answer: its final message reports
  // exactly what the ask_parent tool returned, and the background summary
  // delivers it.
  const summaryFrom = rpc.events.length;
  const summary = await backgroundSummaryWait(rpc, summaryFrom);
  const summaryText = messageText(summary.message);
  assert.match(summaryText, new RegExp(`^Background subagent job ${bg.job.id} \\(worker\\) completed`));
  assert.match(summaryText, /child-saw:fixture-answer-42/);
  await rpc.wait((event) => event.type === "agent_settled", summaryFrom);

  // The child's session persists the whole question round trip: the
  // ask_parent tool call, the answer tool result, and the final message that
  // used the answer.
  const childSessionFile = fixture.observation("ask-child").file;
  assert.ok(childSessionFile, "the asking child flushed a session file");
  const childEntries = jsonl(childSessionFile);
  const askCalls = childEntries.filter(
    (entry) => entry.type === "message" && entry.message.role === "assistant" &&
      JSON.stringify(entry.message.content).includes("ask_parent"),
  );
  assert.equal(askCalls.length, 1, "the child asked through the ask_parent tool");
  assert.ok(
    childEntries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" &&
      messageText(entry.message) === "fixture-answer-42"),
    "the parent's answer reached the child as the ask_parent tool result",
  );
  const finalMessages = childEntries.filter(
    (entry) => entry.type === "message" && entry.message.role === "assistant" &&
      messageText(entry.message).startsWith("child-saw:"),
  );
  assert.equal(finalMessages.length, 1, "the child's final message reports what it saw");
  assert.match(messageText(finalMessages[0].message), /^child-saw:fixture-answer-42$/);

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});

// ---------------------------------------------------------------------------
// Graceful stop through the companion tool (ticket 03)
// ---------------------------------------------------------------------------

test("real Pi stops a running background job through subagent_stop, preserving partial output", { timeout: 150_000 }, async (t) => {
  const fixture = setup(t, { stopGraceMs: 500 });
  const rpc = fixture.start();

  // A background child runs long: it makes real progress (a note and a
  // completed grandchild delegation, both flushed), then stalls mid-run.
  const startTurn = await rpc.prompt({
    tag: "stop-start",
    calls: [childCall("stop-child", {
      background: true,
      session: "stop-me",
      timeout: 120,
      inactivityTimeout: 110,
      prompt: JSON.stringify({
        tag: "stop-child",
        note: "progress before the stop",
        hang: true,
        calls: [childCall("stop-grandchild", { agent: "leaf" })],
      }),
    })],
  });
  const [bg] = agentTool(startTurn).details.results;
  assertJobId(bg.job);
  assert.equal(bg.job.status, "running");

  // The child is mid-run with its progress already flushed.
  const child = await waitForObservation(fixture, "stop-child", { lastRole: "toolResult" });

  // Stop it through the real subagent_stop tool: the tool awaits the job's
  // completion, so its result reflects the stopped final state.
  const stopTurn = await rpc.prompt({
    tag: "stop-mid",
    tools: [{ name: "subagent_stop", arguments: { job: bg.job.id } }],
  });
  const stopTool = companionTool(stopTurn, "subagent_stop");
  assert.match(messageText(stopTool), new RegExp(`^Subagent job ${bg.job.id} \\(agent worker\\) stopped after [0-9.]+s\\.`));
  assert.equal(stopTool.details.outcome, "stopped");
  assert.equal(stopTool.details.job.status, "stopped");
  assert.match(messageText(stopTool), /progress before the stop/, "the stop view carries the partial output");

  // The stopped job's partial output stays retrievable through subagent_result.
  const collectTurn = await rpc.prompt({
    tag: "stop-result",
    tools: [{ name: "subagent_result", arguments: { job: bg.job.id } }],
  });
  const collectTool = companionTool(collectTurn, "subagent_result");
  assert.equal(collectTool.details.ready, true);
  assert.match(messageText(collectTool), /^Status: stopped/m);
  assert.match(messageText(collectTool), /progress before the stop/);

  // The stopped child's session lock was released: the same session runs again.
  const [resumed] = results(await rpc.prompt({
    tag: "stop-resume",
    calls: [childCall("stop-resume-child", { session: "stop-me" })],
  }));
  assert.equal(resumed.session.created, false, "the stopped child's session continues");
  assert.equal(resumed.session.id, bg.job.childSessionId);
  assert.match(
    JSON.stringify(fixture.observation("stop-resume-child").contextMessages),
    /progress before the stop/,
    "the resumed child retains the stopped run's progress",
  );

  // Stopping an already-finished job is idempotent and says so clearly.
  const againTurn = await rpc.prompt({
    tag: "stop-again",
    tools: [{ name: "subagent_stop", arguments: { job: bg.job.id } }],
  });
  const againTool = companionTool(againTurn, "subagent_stop");
  assert.equal(againTool.details.outcome, "already-finished");
  assert.match(
    messageText(againTool),
    new RegExp(`Subagent job ${bg.job.id} \\(agent worker\\) is already finished with status "stopped"\\. Nothing to stop`),
  );

  // No stray: the stopped child's process is gone, and its lock with it.
  assert.throws(
    () => process.kill(child.pid, 0),
    { code: "ESRCH" },
    "the stopped background child process exited",
  );
  const lockRoot = path.join(fixture.sessionDir, ".pi-subagent-locks");
  assert.deepEqual(
    fs.readdirSync(lockRoot).filter((name) => name.endsWith(".lock")),
    [],
    "the stopped child's session lock was released",
  );

  await rpc.close();
  assert.equal(rpc.exit.code, 0, rpc.stderr);
});
