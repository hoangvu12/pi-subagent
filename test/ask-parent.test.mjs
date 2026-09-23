import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import {
  ASK_ANSWER_FILE,
  ASK_PARENT_DIR_ENV,
  ASK_PARENT_TOOL_NAME,
  ASK_QUESTION_FILE,
  ASK_TIMEOUT_FILE,
  ASK_PARENT_DEFAULT_TIMEOUT_MS,
  formatAskSeconds,
  parseAskAnswerFile,
  parseAskQuestionFile,
  parseAskTimeoutFile,
  writeAskFileAtomic,
} from "../ask-parent.ts";
import { JobRegistry } from "../jobs.ts";
import askParentExtension from "../ask-parent.ts";

const jiti = createJiti(import.meta.url);
const {
  AskParentHub,
  formatAskQuestionMessage,
  formatAskTimeoutMessage,
  formatReplyDeliveredMessage,
} = await jiti.import("../questions.ts");
const {
  default: registerSubagentExtension,
} = await jiti.import("../index.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempAskDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-ask-"));
}

/** Read the one protocol file in an ask directory, parsed. */
function readAskFile(dir, file) {
  const raw = fs.readFileSync(path.join(dir, file), "utf8");
  return JSON.parse(raw);
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

function fakeJob(overrides = {}) {
  const jobs = new JobRegistry();
  return jobs.create({ agent: "worker", handle: null, cwd: "/repo", ...overrides });
}

/** Register the child-side extension against a mock pi and return the tool. */
function loadAskParentTool(askDir) {
  const tools = new Map();
  const previous = process.env[ASK_PARENT_DIR_ENV];
  if (askDir === undefined) delete process.env[ASK_PARENT_DIR_ENV];
  else process.env[ASK_PARENT_DIR_ENV] = askDir;
  try {
    askParentExtension({ registerTool: (tool) => tools.set(tool.name, tool) });
  } finally {
    if (previous === undefined) delete process.env[ASK_PARENT_DIR_ENV];
    else process.env[ASK_PARENT_DIR_ENV] = previous;
  }
  return tools.get(ASK_PARENT_TOOL_NAME);
}

function childContext() {
  return { sessionManager: { getSessionId: () => "child-session-42" } };
}

/** Wait for a condition, bounded; returns the value or undefined on expiry. */
async function waitFor(predicate, { timeoutMs = 5_000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// ---------------------------------------------------------------------------
// Protocol file parsing and writing
// ---------------------------------------------------------------------------

test("ask protocol files parse strictly and reject malformed input", () => {
  const question = JSON.stringify({
    version: 1,
    questionId: "q1",
    question: "Which flavor?",
    timeoutMs: 30_000,
    askedAt: "2026-01-01T00:00:00.000Z",
    childSessionId: "child-1",
  });
  assert.deepEqual(parseAskQuestionFile(question), {
    version: 1,
    questionId: "q1",
    question: "Which flavor?",
    timeoutMs: 30_000,
    askedAt: "2026-01-01T00:00:00.000Z",
    childSessionId: "child-1",
  });
  for (const malformed of [
    "not json",
    JSON.stringify({ version: 2, questionId: "q1", question: "q", timeoutMs: 1 }),
    JSON.stringify({ version: 1, questionId: "", question: "q", timeoutMs: 1 }),
    JSON.stringify({ version: 1, questionId: "q1", question: " ", timeoutMs: 1 }),
    JSON.stringify({ version: 1, questionId: "q1", question: "q", timeoutMs: 0 }),
    JSON.stringify({ version: 1, questionId: "q1", question: "q", timeoutMs: "30" }),
    JSON.stringify({ version: 1, questionId: "q1", question: "q" }),
  ]) {
    assert.equal(parseAskQuestionFile(malformed), undefined, `malformed question: ${malformed}`);
  }

  const answer = JSON.stringify({ version: 1, questionId: "q1", answer: "vanilla", answeredAt: "t" });
  assert.deepEqual(parseAskAnswerFile(answer), {
    version: 1,
    questionId: "q1",
    answer: "vanilla",
    answeredAt: "t",
  });
  for (const malformed of [
    "not json",
    JSON.stringify({ version: 1, questionId: "q1" }),
    JSON.stringify({ version: 1, answer: "vanilla" }),
    JSON.stringify({ version: 1, questionId: "q1", answer: 42 }),
  ]) {
    assert.equal(parseAskAnswerFile(malformed), undefined, `malformed answer: ${malformed}`);
  }

  const timeout = JSON.stringify({ version: 1, questionId: "q1", timeoutMs: 1_000, timedOutAt: "t" });
  assert.deepEqual(parseAskTimeoutFile(timeout), {
    version: 1,
    questionId: "q1",
    timeoutMs: 1_000,
    timedOutAt: "t",
  });
  for (const malformed of [
    "not json",
    JSON.stringify({ version: 1, questionId: "q1" }),
    JSON.stringify({ version: 1, questionId: "q1", timeoutMs: -1 }),
  ]) {
    assert.equal(parseAskTimeoutFile(malformed), undefined, `malformed timeout: ${malformed}`);
  }
});

test("ask protocol files are written atomically as JSON lines", () => {
  const dir = tempAskDir();
  try {
    const file = path.join(dir, ASK_QUESTION_FILE);
    writeAskFileAtomic(file, { version: 1, questionId: "q1", question: "q", timeoutMs: 1 });
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.endsWith("\n"), "the document ends with a newline");
    assert.deepEqual(JSON.parse(raw), { version: 1, questionId: "q1", question: "q", timeoutMs: 1 });
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, [], "no temp files are left behind");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, "protocol files are owner-only");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ask timeout wording stays compact", () => {
  assert.equal(formatAskSeconds(1_000), "1s");
  assert.equal(formatAskSeconds(2_000), "2s");
  assert.equal(formatAskSeconds(1_500), "1.5s");
  assert.equal(formatAskSeconds(90_000), "90s");
  assert.equal(formatAskSeconds(0), "0s");
  assert.equal(formatAskSeconds(-1), "0s");
});

// ---------------------------------------------------------------------------
// Child-side ask_parent tool
// ---------------------------------------------------------------------------

test("ask_parent registers only when the ask-directory marker env is set", async () => {
  const dir = tempAskDir();
  try {
    const registered = loadAskParentTool(dir);
    assert.ok(registered, "the tool registers when the marker env points at a directory");
    assert.equal(registered.name, ASK_PARENT_TOOL_NAME);
    assert.equal(registered.parameters.properties.question.minLength, 1);
    assert.equal(registered.parameters.properties.timeout.minimum, 1);
    assert.equal(registered.parameters.properties.timeout.maximum, 3_600);
    assert.deepEqual(registered.parameters.required, ["question"]);
    assert.match(registered.description, /Ask the parent agent/);

    const inert = loadAskParentTool(undefined);
    assert.equal(inert, undefined, "without the marker env no tool registers");

    const missing = loadAskParentTool(path.join(dir, "missing"));
    assert.equal(missing, undefined, "a nonexistent directory does not activate the tool");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ask_parent writes the question file and returns the parent's answer", async () => {
  const dir = tempAskDir();
  try {
    const tool = loadAskParentTool(dir);

    const pending = tool.execute(
      "ask-1",
      { question: "Which flavor should the report use?", timeout: 10 },
      undefined,
      undefined,
      childContext(),
    );

    // The question lands in the ask directory in the documented format.
    const question = await waitFor(() =>
      fs.existsSync(path.join(dir, ASK_QUESTION_FILE))
        ? readAskFile(dir, ASK_QUESTION_FILE)
        : undefined,
    );
    assert.ok(question, "the question file appears");
    assert.equal(question.version, 1);
    assert.equal(question.question, "Which flavor should the report use?");
    assert.equal(question.timeoutMs, 10_000);
    assert.equal(question.childSessionId, "child-session-42");
    assert.ok(question.questionId, "the question carries a unique id");
    assert.ok(!fs.existsSync(path.join(dir, ASK_ANSWER_FILE)));

    // The parent answers through the same protocol: answer.json keyed by the
    // question id.
    writeAskFileAtomic(path.join(dir, ASK_ANSWER_FILE), {
      version: 1,
      questionId: question.questionId,
      answer: "vanilla, definitely",
      answeredAt: new Date().toISOString(),
    });

    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "vanilla, definitely" }]);
    assert.equal(result.details.kind, "pi-subagent-ask");
    assert.equal(result.details.questionId, question.questionId);
    assert.equal(result.details.answered, true);
    assert.equal(result.details.timeoutMs, 10_000);
    assert.ok(result.details.waitedMs >= 0);
    assert.equal(fs.existsSync(path.join(dir, ASK_TIMEOUT_FILE)), false, "no timeout notice on success");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ask_parent times out, informs the parent, and tells the child to proceed", async () => {
  const dir = tempAskDir();
  try {
    const tool = loadAskParentTool(dir);

    const started = Date.now();
    const result = await tool.execute(
      "ask-1",
      { question: "Unanswerable?", timeout: 1 },
      undefined,
      undefined,
      childContext(),
    );
    const waited = Date.now() - started;

    assert.ok(waited >= 900, `the child waited its timeout (waited ${waited}ms)`);
    assert.match(result.content[0].text, /No answer from the parent arrived within 1s\./);
    assert.match(result.content[0].text, /Proceed without an answer: choose the most reasonable interpretation/);
    assert.equal(result.details.answered, false);
    assert.equal(result.details.timeoutMs, 1_000);
    assert.equal(result.details.waitedMs >= 1_000, true);

    // The timeout notice is written for the parent-side relay.
    const timeout = readAskFile(dir, ASK_TIMEOUT_FILE);
    assert.equal(timeout.version, 1);
    assert.equal(timeout.questionId, result.details.questionId);
    assert.equal(timeout.timeoutMs, 1_000);
    assert.ok(timeout.timedOutAt);
    assert.equal(fs.existsSync(path.join(dir, ASK_ANSWER_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ask_parent never mistakes a leftover answer for its own", async () => {
  const dir = tempAskDir();
  try {
    // An answer left over from an earlier question, plus a malformed answer:
    // neither may unblock a new question.
    writeAskFileAtomic(path.join(dir, ASK_ANSWER_FILE), {
      version: 1,
      questionId: "an-earlier-question",
      answer: "stale answer",
      answeredAt: "t",
    });

    const tool = loadAskParentTool(dir);
    const result = await tool.execute(
      "ask-1",
      { question: "Fresh question?", timeout: 1 },
      undefined,
      undefined,
      childContext(),
    );
    assert.match(result.content[0].text, /No answer from the parent arrived within 1s\./);
    assert.equal(result.details.answered, false);
    const stale = parseAskAnswerFile(fs.readFileSync(path.join(dir, ASK_ANSWER_FILE), "utf8"));
    assert.equal(stale.questionId, "an-earlier-question", "the stale answer is untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ask_parent returns promptly when its run is aborted mid-wait", async () => {
  const dir = tempAskDir();
  try {
    const tool = loadAskParentTool(dir);
    const controller = new AbortController();
    const pending = tool.execute(
      "ask-1",
      { question: "Question?", timeout: 30 },
      controller.signal,
      undefined,
      childContext(),
    );
    const question = await waitFor(() =>
      fs.existsSync(path.join(dir, ASK_QUESTION_FILE))
        ? readAskFile(dir, ASK_QUESTION_FILE)
        : undefined,
    );
    assert.ok(question, "the question was delivered before the abort");
    controller.abort();
    const result = await pending;
    assert.match(result.content[0].text, /interrupted before an answer arrived/);
    assert.equal(result.details.answered, false);
    assert.equal(fs.existsSync(path.join(dir, ASK_TIMEOUT_FILE)), false, "an abort is not a timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ask_parent defaults to the documented wait and caps the maximum", async () => {
  const dir = tempAskDir();
  try {
    const tool = loadAskParentTool(dir);
    // A default-timeout ask is aborted immediately; the recorded timeout
    // documents what the child would have waited.
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      "ask-1",
      { question: "Question?" },
      controller.signal,
      undefined,
      childContext(),
    );
    assert.equal(result.details.timeoutMs, ASK_PARENT_DEFAULT_TIMEOUT_MS);
    assert.equal(ASK_PARENT_DEFAULT_TIMEOUT_MS, 120_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ask_parent surfaces delivery failures as a clear tool result", async () => {
  const dir = tempAskDir();
  try {
    const tool = loadAskParentTool(dir);
    // Make the ask directory unwritable by removing it after registration.
    fs.rmSync(dir, { recursive: true, force: true });
    const result = await tool.execute(
      "ask-1",
      { question: "Question?", timeout: 5 },
      undefined,
      undefined,
      childContext(),
    );
    assert.match(result.content[0].text, /ask_parent could not deliver the question to the parent session/);
    assert.equal(result.details.answered, false);
    assert.equal(result.details.waitedMs, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parent-side relay hub
// ---------------------------------------------------------------------------

function recordDelivery() {
  const questions = [];
  const timeouts = [];
  return {
    questions,
    timeouts,
    onQuestion: (event) => questions.push(event),
    onTimeout: (event) => timeouts.push(event),
  };
}

function writeQuestion(dir, question) {
  writeAskFileAtomic(path.join(dir, ASK_QUESTION_FILE), {
    version: 1,
    askedAt: new Date().toISOString(),
    ...question,
  });
}

test("the hub relays a child question with follow-up phrasing for subagent_reply", async () => {
  const dir = tempAskDir();
  try {
    const delivery = recordDelivery();
    const hub = new AskParentHub(delivery);
    const job = fakeJob({ handle: "docs" });

    hub.watch(job, dir);
    writeQuestion(dir, {
      questionId: "q1",
      question: "Which flavor should the report use?",
      timeoutMs: 30_000,
    });

    const event = await waitFor(() => delivery.questions[0]);
    assert.ok(event, "the question was relayed");
    assert.equal(event.job.id, job.id);
    assert.equal(event.job.agent, "worker");
    assert.equal(event.question.questionId, "q1");
    assert.equal(event.question.question, "Which flavor should the report use?");

    const text = formatAskQuestionMessage(event.job, event.question);
    assert.match(text, new RegExp(`^Subagent job ${job.id} \\(agent worker\\) is asking a question mid-task:`));
    assert.match(text, /Which flavor should the report use\?/);
    assert.match(text, new RegExp("Reply with the subagent_reply tool, passing `job` \"" + job.id + "\" and your answer"));
    assert.match(text, /The child is blocked waiting and will continue its task using your answer/);
    assert.match(text, /If no answer arrives within 30s, the child gives up and proceeds on its own/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hub delivers a reply to the waiting child through answer.json", async () => {
  const dir = tempAskDir();
  try {
    const delivery = recordDelivery();
    const hub = new AskParentHub(delivery);
    const job = fakeJob();
    hub.watch(job, dir);

    // The child (the real ask_parent tool) asks a question.
    const tool = loadAskParentTool(dir);
    const pending = tool.execute(
      "ask-1",
      { question: "Which flavor?", timeout: 10 },
      undefined,
      undefined,
      childContext(),
    );
    const event = await waitFor(() => delivery.questions[0]);
    assert.ok(event, "the hub observed the question");

    // The parent answers through the hub, exactly as subagent_reply does.
    const outcome = hub.reply(job.id, "vanilla, definitely");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.job.id, job.id);
    assert.equal(outcome.question.questionId, event.question.questionId);
    assert.equal(outcome.answer, "vanilla, definitely");

    const answer = readAskFile(dir, ASK_ANSWER_FILE);
    assert.equal(answer.version, 1);
    assert.equal(answer.questionId, event.question.questionId);
    assert.equal(answer.answer, "vanilla, definitely");

    // The waiting child picks the answer up on its own poll and continues.
    const result = await pending;
    assert.equal(result.content[0].text, "vanilla, definitely");
    assert.equal(result.details.answered, true);

    const delivered = formatReplyDeliveredMessage(job, "vanilla, definitely");
    assert.match(delivered, new RegExp(`^Answer delivered to subagent job ${job.id} \\(agent worker\\): "vanilla, definitely"`));
    assert.match(delivered, /picks the answer up on its next poll and continues its task using it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hub relays a child timeout notice and keeps the job running", async () => {
  const dir = tempAskDir();
  try {
    const delivery = recordDelivery();
    const hub = new AskParentHub(delivery);
    const job = fakeJob();
    hub.watch(job, dir);

    writeQuestion(dir, { questionId: "q1", question: "Unanswerable?", timeoutMs: 2_000 });
    await waitFor(() => delivery.questions[0]);

    writeAskFileAtomic(path.join(dir, ASK_TIMEOUT_FILE), {
      version: 1,
      questionId: "q1",
      timeoutMs: 2_000,
      timedOutAt: new Date().toISOString(),
    });

    const event = await waitFor(() => delivery.timeouts[0]);
    assert.ok(event, "the timeout was relayed");
    assert.equal(event.job.id, job.id);
    assert.equal(event.questionId, "q1");
    assert.equal(event.timeoutMs, 2_000);
    assert.equal(event.question, "Unanswerable?", "the relayed timeout names the question it observed");

    const text = formatAskTimeoutMessage(job, event);
    assert.match(text, new RegExp(`^Subagent job ${job.id} \\(agent worker\\) timed out waiting for an answer after 2s and proceeded on its own\\.`));
    assert.match(text, /It asked:\n\nUnanswerable\?/);
    assert.match(text, /No reply is needed now: the job keeps running/);

    // A late reply for the timed-out question no longer delivers.
    const late = hub.reply(job.id, "too late");
    assert.equal(late.ok, false);
    assert.equal(late.code, "no-pending");
    assert.match(late.error, /has no question waiting for an answer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hub reports no pending question for unknown jobs and after jobs end", async () => {
  const dir = tempAskDir();
  try {
    const hub = new AskParentHub(recordDelivery());

    const unknown = hub.reply("job-ffffffffffff", "an answer");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "no-pending");
    assert.match(unknown.error, /Subagent job job-ffffffffffff has no question waiting for an answer/);
    assert.match(unknown.error, /The child may have timed out and moved on, already finished, or never asked/);

    // A watched job with no question written yet also reports no question
    // waiting rather than guessing.
    const job = fakeJob();
    hub.watch(job, dir);
    const quiet = hub.reply(job.id, "an answer");
    assert.equal(quiet.ok, false);
    assert.equal(quiet.code, "no-pending");

    // stopWatch ends the job's watch and clears its pending question, so a
    // reply for a finished child reports no question waiting and writes
    // nothing into a directory the child no longer reads.
    const job2 = fakeJob();
    hub.watch(job2, dir);
    writeQuestion(dir, { questionId: "q2", question: "Another?", timeoutMs: 5_000 });
    const question2 = await waitFor(() => readAskFile(dir, ASK_QUESTION_FILE));
    assert.equal(question2.questionId, "q2");
    hub.stopWatch(job2.id);
    const finished = hub.reply(job2.id, "an answer");
    assert.equal(finished.ok, false);
    assert.equal(finished.code, "no-pending");
    assert.equal(fs.existsSync(path.join(dir, ASK_ANSWER_FILE)), false, "no answer is written for a dead child");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hub stops watching when the last job ends", async () => {
  const dir = tempAskDir();
  try {
    const delivery = recordDelivery();
    const hub = new AskParentHub(delivery);
    const job = fakeJob();
    hub.watch(job, dir);
    hub.stopWatch(job.id);

    writeQuestion(dir, { questionId: "q-late", question: "Late?", timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(delivery.questions, [], "a directory nobody watches is not relayed");

    // The hub restarts its timer when a new job is watched: whatever is in
    // the directory at that point relays on the next poll.
    const job2 = fakeJob();
    hub.watch(job2, dir);
    const resumed = await waitFor(() => delivery.questions[0]);
    assert.ok(resumed, "watching again resumes the relay");
    assert.equal(resumed.question.questionId, "q-late");

    writeQuestion(dir, { questionId: "q-next", question: "Next?", timeoutMs: 5_000 });
    const next = await waitFor(() => delivery.questions[1]);
    assert.ok(next, "a later question from the watched directory relays");
    assert.equal(next.question.questionId, "q-next");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hub relays repeated questions from the same child only once each", async () => {
  const dir = tempAskDir();
  try {
    const delivery = recordDelivery();
    const hub = new AskParentHub(delivery);
    const job = fakeJob();
    hub.watch(job, dir);

    writeQuestion(dir, { questionId: "q1", question: "First?", timeoutMs: 5_000 });
    await waitFor(() => delivery.questions.length === 1 ? delivery.questions : undefined);

    // The same file content (same question id) is not re-relayed on later polls.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(delivery.questions.length, 1);

    // A new question id from the same child relays again and replaces the
    // pending question.
    writeQuestion(dir, { questionId: "q2", question: "Second?", timeoutMs: 5_000 });
    await waitFor(() => delivery.questions.length === 2 ? delivery.questions : undefined);
    assert.equal(delivery.questions.length, 2);
    assert.equal(delivery.questions[1].question.questionId, "q2");

    const outcome = hub.reply(job.id, "answer to the second");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.questionId, "q2");
    const answer = readAskFile(dir, ASK_ANSWER_FILE);
    assert.equal(answer.questionId, "q2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hub fails softly on malformed protocol files", async () => {
  const dir = tempAskDir();
  try {
    const delivery = recordDelivery();
    const hub = new AskParentHub(delivery);
    const job = fakeJob();
    hub.watch(job, dir);

    fs.writeFileSync(path.join(dir, ASK_QUESTION_FILE), "not json at all\n");
    fs.writeFileSync(path.join(dir, ASK_TIMEOUT_FILE), "also not json\n");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(delivery.questions, [], "a malformed question is not relayed");
    assert.deepEqual(delivery.timeouts, [], "a malformed timeout is not relayed");
    assert.equal(hub.reply(job.id, "answer").ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// subagent_reply tool surface (mocked pi, real factory)
// ---------------------------------------------------------------------------

function createPiHarness() {
  const handlers = new Map();
  const tools = new Map();
  const flags = new Map();

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
    appendEntry() {},
    sendUserMessage() {},
  };

  registerSubagentExtension(pi);
  return { handlers, tools, flags };
}

test("subagent_reply answers a job's pending question through the extension's hub", async () => {
  // The reply tool can only observe questions the extension's own hub has
  // seen; without a watched ask directory every job reports no question
  // waiting, which is the clear error result the tool must produce.
  const harness = createPiHarness();
  const reply = harness.tools.get("subagent_reply");

  const missing = await reply.execute(
    "reply-1",
    { job: "job-ffffffffffff", answer: "an answer" },
    undefined,
    undefined,
    undefined,
  );
  assert.match(missing.content[0].text, /Subagent job job-ffffffffffff has no question waiting for an answer/);
  assert.equal(missing.details.kind, "pi-subagent-reply");
  assert.equal(missing.details.job, null);
  assert.equal(missing.details.answer, "an answer");
  assert.equal(missing.details.delivered, false);
  assert.equal(missing.details.failed, true);
});
