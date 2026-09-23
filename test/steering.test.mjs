import test from "node:test";
import assert from "node:assert/strict";
import {
  STEER_ACK_TIMEOUT_MS,
  STEER_CHANNEL_WAIT_MS,
  SteerChannel,
  SteerChannelRegistry,
  steerJob,
} from "../steering.ts";
import { JobRegistry } from "../jobs.ts";

function createRecordingWriter(records = [], options = {}) {
  return (line, onWritten) => {
    records.push(JSON.parse(line));
    if (options.failWrite) {
      onWritten(new Error("pipe broken"));
      return;
    }
    onWritten(null);
  };
}

/** A channel whose child rejects every steering message. */
function createRejectingChannel() {
  const channel = new SteerChannel((line, onWritten) => {
    onWritten(null);
    const command = JSON.parse(line);
    setImmediate(() => {
      channel.handleResponse({
        id: command.id,
        type: "response",
        command: "steer",
        success: false,
        error: "the child rejected the steering message",
      });
    });
  });
  return channel;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeRegistryWithJob(status = "running") {
  const jobs = new JobRegistry();
  const job = jobs.create({
    agent: "worker",
    handle: "work",
    childSessionId: "subagent.test",
    cwd: process.cwd(),
  });
  jobs.setStatus(job.id, status);
  return { jobs, job };
}

test("steer resolves delivered when the child acknowledges the queued message", async () => {
  const records = [];
  const channel = new SteerChannel(createRecordingWriter(records));
  const pending = channel.steer("redirect the child");
  const command = records[0];
  assert.equal(command.type, "steer");
  assert.equal(command.message, "redirect the child");
  assert.match(command.id, /^pi-subagent-steer-\d+$/);
  assert.equal(channel.handleResponse({
    id: command.id,
    type: "response",
    command: "steer",
    success: true,
  }), true);
  assert.deepEqual(await pending, { delivered: true });
});

test("steer reports the child's rejection with its error text", async () => {
  const records = [];
  const channel = new SteerChannel(createRecordingWriter(records));
  const pending = channel.steer("/extension-command");
  channel.handleResponse({
    id: records[0].id,
    type: "response",
    command: "steer",
    success: false,
    error: "Extension commands are not allowed (use `prompt` instead).",
  });
  const outcome = await pending;
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.code, "rejected");
  assert.match(outcome.error, /Extension commands are not allowed/);
});

test("steer times out with a clear error when the child never acknowledges", async () => {
  const channel = new SteerChannel(createRecordingWriter([]));
  const outcome = await channel.steer("redirect", 60);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.code, "timeout");
  assert.match(outcome.error, /did not acknowledge the steering message within 60ms/);
});

test("steer fails when the write to the child errors", async () => {
  const channel = new SteerChannel(createRecordingWriter([], { failWrite: true }));
  const outcome = await channel.steer("redirect");
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.code, "write-failed");
  assert.match(outcome.error, /pipe broken/);
});

test("closed channels reject new steers and fail pending ones", async () => {
  const records = [];
  const channel = new SteerChannel(createRecordingWriter(records));
  const pending = channel.steer("redirect");
  channel.close("the subagent run finished");
  const outcome = await pending;
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.code, "channel-closed");
  assert.match(outcome.error, /steering channel is closed: the subagent run finished/);
  const afterClose = await channel.steer("another message");
  assert.equal(afterClose.code, "channel-closed");
});

test("concurrent steers correlate by command id", async () => {
  const records = [];
  const channel = new SteerChannel(createRecordingWriter(records));
  const first = channel.steer("first message");
  const second = channel.steer("second message");
  channel.handleResponse({ id: records[1].id, type: "response", command: "steer", success: true });
  channel.handleResponse({ id: records[0].id, type: "response", command: "steer", success: true });
  assert.deepEqual(await first, { delivered: true });
  assert.deepEqual(await second, { delivered: true });
  assert.equal(records[0].message, "first message");
  assert.equal(records[1].message, "second message");
  assert.notEqual(records[0].id, records[1].id);
});

test("handleResponse ignores unrelated events and unknown ids", () => {
  const records = [];
  const channel = new SteerChannel(createRecordingWriter(records));
  const pending = channel.steer("redirect");
  assert.equal(channel.handleResponse({ type: "message_end", message: {} }), false);
  assert.equal(channel.handleResponse({
    id: "pi-subagent-prompt-state",
    type: "response",
    command: "get_state",
    success: true,
    data: { isStreaming: true },
  }), false);
  assert.equal(channel.handleResponse({
    id: "pi-subagent-steer-999",
    type: "response",
    command: "steer",
    success: true,
  }), false);
  assert.equal(pending instanceof Promise, true);
  channel.close("test teardown");
});

test("registry attaches, detaches, and waits for channels", async () => {
  const registry = new SteerChannelRegistry();
  const channel = new SteerChannel(createRecordingWriter([]));
  registry.attach("job-1", channel);
  assert.equal(registry.get("job-1"), channel);
  registry.detach("job-1");
  assert.equal(registry.get("job-1"), undefined);
  assert.equal(await registry.waitForChannel("job-1", 40), undefined);

  const attached = new Promise((resolve) => {
    setTimeout(() => {
      registry.attach("job-2", channel);
      resolve();
    }, 30);
  });
  await attached;
  assert.equal(await registry.waitForChannel("job-2", 100), channel);
});

test("steerJob delivers to a running job with a live channel", async () => {
  const { jobs, job } = makeRegistryWithJob("running");
  const channels = new SteerChannelRegistry();
  const records = [];
  const channel = new SteerChannel(createRecordingWriter(records));
  channels.attach(job.id, channel);
  const outcomePromise = steerJob(jobs, channels, { jobId: job.id }, "redirect");
  channel.handleResponse({ id: records[0].id, type: "response", command: "steer", success: true });
  const outcome = await outcomePromise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.job.id, job.id);
  assert.equal(outcome.job.handle, "work");
  assert.equal(outcome.message, "redirect");
});

test("steerJob errors for an unknown job id", async () => {
  const jobs = new JobRegistry();
  const outcome = await steerJob(jobs, new SteerChannelRegistry(), { jobId: "job-missing" }, "redirect");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.job, null);
  assert.match(outcome.error, /Unknown subagent job "job-missing"/);
});

test("steerJob errors immediately when the job is not running", async () => {
  for (const status of ["done", "failed", "stopped"]) {
    const { jobs, job } = makeRegistryWithJob(status);
    const channels = new SteerChannelRegistry();
    channels.attach(job.id, new SteerChannel(createRecordingWriter([])));
    const outcome = await steerJob(jobs, channels, { jobId: job.id }, "redirect");
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /is not running: its status is "done"|"failed"|"stopped"/);
  }
});

test("steerJob waits for a job to appear by handle, then delivers", async () => {
  const jobs = new JobRegistry();
  const channels = new SteerChannelRegistry();
  const records = [];
  const outcomePromise = steerJob(jobs, channels, { handle: "work" }, "redirect");
  const job = await new Promise((resolve) => {
    setTimeout(() => {
      const created = jobs.create({ agent: "worker", handle: "work", cwd: process.cwd() });
      jobs.setStatus(created.id, "running");
      channels.attach(created.id, new SteerChannel(createRecordingWriter(records)));
      resolve(created);
    }, 40);
  });
  const command = await waitFor(() => records[0]);
  assert.ok(command, "the steer command was written once the channel appeared");
  channels.get(job.id).handleResponse({
    id: command.id,
    type: "response",
    command: "steer",
    success: true,
  });
  const outcome = await outcomePromise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.job.handle, "work");
  assert.equal(outcome.job.status, "running");
});

test("steerJob reports a missing handle after the bounded wait", async () => {
  const jobs = new JobRegistry();
  const outcome = await steerJob(jobs, new SteerChannelRegistry(), { handle: "nowhere" }, "redirect", {
    channelWaitMs: 60,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.job, null);
  assert.match(outcome.error, /No subagent job found for session handle "nowhere"/);
});

test("steerJob surfaces the child's delivery failure", async () => {
  const { jobs, job } = makeRegistryWithJob("running");
  const channels = new SteerChannelRegistry();
  channels.attach(job.id, createRejectingChannel());
  const outcome = await steerJob(jobs, channels, { handle: "work" }, "redirect");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.job.id, job.id);
  assert.match(outcome.error, /the child rejected the steering message/);
});

test("steerJob reports a job that never exposes a live channel", async () => {
  const { jobs, job } = makeRegistryWithJob("running");
  const outcome = await steerJob(jobs, new SteerChannelRegistry(), { jobId: job.id }, "redirect", {
    channelWaitMs: 60,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /has no live steering channel/);
});

test("steerJob rejects a job id and handle that disagree", async () => {
  const { jobs, job } = makeRegistryWithJob("running");
  const outcome = await steerJob(
    jobs,
    new SteerChannelRegistry(),
    { jobId: job.id, handle: "other-handle" },
    "redirect",
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /does not use session handle "other-handle"/);
});

test("steer defaults use bounded acknowledgement and channel waits", () => {
  assert.equal(STEER_ACK_TIMEOUT_MS, 10_000);
  assert.equal(STEER_CHANNEL_WAIT_MS, 5_000);
});
