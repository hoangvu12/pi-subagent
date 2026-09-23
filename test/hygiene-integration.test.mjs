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
  runPrint,
  setup,
  waitForObservation,
} from "./fixtures/integration-harness.mjs";

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

/** Wait for a background job's injected summary to arrive as a queued user message. */
function backgroundSummaryWait(rpc, from) {
  return rpc.wait(
    (event) => event.type === "message_end" && event.message.role === "user" &&
      messageText(event.message).includes("Background subagent job"),
    from,
  );
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

