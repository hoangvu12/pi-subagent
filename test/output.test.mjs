import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const {
  formatCallsSummary,
  formatFullCallsSummary,
  writeOutputArtifact,
} = await jiti.import("../output.ts");

function makeResult(index, text, overrides = {}) {
  return {
    callIndex: index,
    agent: `agent-${index}`,
    agentSource: "user",
    prompt: "test",
    initialContext: "empty",
    exitCode: 0,
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: 1,
      },
    ],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 1,
    },
    ...overrides,
  };
}

function lineCount(text) {
  return text.replace(/\r\n?/g, "\n").split("\n").length;
}

test("leaves summaries under the Pi limits byte-for-byte unchanged", () => {
  const results = [makeResult(0, "Short answer")];
  let saveCalled = false;
  const summary = formatCallsSummary(results, () => {
    saveCalled = true;
    return "/tmp/unexpected";
  });

  assert.equal(summary.text, formatFullCallsSummary(results));
  assert.equal(summary.truncated, false);
  assert.equal(summary.fullOutputPath, null);
  assert.equal(saveCalled, false);
});

test("bounds large batches while retaining every result status", () => {
  const results = Array.from({ length: 8 }, (_, index) =>
    makeResult(index, `${`line-${index} `.repeat(20)}\n`.repeat(1200)),
  );
  results[7] = makeResult(7, "Partial failure output\n".repeat(4000), {
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Provider failed",
  });

  let savedFullText = "";
  const summary = formatCallsSummary(results, (content) => {
    savedFullText = content;
    return "/tmp/subagent-full.md";
  });

  assert.equal(summary.truncated, true);
  assert.equal(summary.fullOutputPath, "/tmp/subagent-full.md");
  assert.equal(Buffer.byteLength(summary.text, "utf8") <= DEFAULT_MAX_BYTES, true);
  assert.equal(lineCount(summary.text) <= DEFAULT_MAX_LINES, true);
  assert.equal(Buffer.byteLength(savedFullText, "utf8") > DEFAULT_MAX_BYTES, true);
  assert.match(summary.text, /Full output saved to: \/tmp\/subagent-full\.md/);
  for (let index = 0; index < results.length; index++) {
    assert.match(summary.text, new RegExp(`\\[${index + 1}: agent-${index}\\]`));
  }
  assert.match(summary.text, /\[8: agent-7\] failed/);
});

test("keeps multibyte output within the byte limit without an artifact", () => {
  const results = [makeResult(0, "🧪".repeat(DEFAULT_MAX_BYTES))];
  const summary = formatCallsSummary(results, () => null);

  assert.equal(summary.truncated, true);
  assert.equal(summary.fullOutputPath, null);
  assert.equal(Buffer.byteLength(summary.text, "utf8") <= DEFAULT_MAX_BYTES, true);
  assert.equal(lineCount(summary.text) <= DEFAULT_MAX_LINES, true);
  assert.match(summary.text, /preserved in tool details/);
});

test("failure summaries lead with resume guidance before partial output", () => {
  const results = [makeResult(0, "Partial progress before the crash", {
    exitCode: 1,
    stopReason: "error",
    errorMessage: "scripted failure",
    resume: {
      handle: "subagent.0123456789abcdef",
      guidance: 'Continue with session "subagent.0123456789abcdef" and a corrective prompt.',
    },
  })];
  const summary = formatCallsSummary(results, () => "/tmp/unexpected");

  assert.equal(summary.truncated, false);
  assert.match(summary.text, /\[1: agent-0\] failed/);
  const guidanceIndex = summary.text.indexOf("Continue with session");
  const partialIndex = summary.text.indexOf("Partial progress before the crash");
  assert.notEqual(guidanceIndex, -1);
  assert.notEqual(partialIndex, -1);
  assert.ok(
    guidanceIndex < partialIndex,
    "guidance precedes the partial output so head-truncation keeps it",
  );
});

test("bounded failure summaries retain resume guidance under truncation", () => {
  const results = Array.from({ length: 8 }, (_, index) =>
    makeResult(index, `${`line-${index} `.repeat(20)}\n`.repeat(1200)),
  );
  results[7] = makeResult(7, "Partial failure output\n".repeat(4000), {
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Provider failed",
    resume: {
      handle: null,
      guidance: "Ephemeral failure guidance: rerun the Agent call with a corrected prompt.",
    },
  });

  const summary = formatCallsSummary(results, () => "/tmp/subagent-full.md");

  assert.equal(summary.truncated, true);
  assert.equal(Buffer.byteLength(summary.text, "utf8") <= DEFAULT_MAX_BYTES, true);
  assert.equal(lineCount(summary.text) <= DEFAULT_MAX_LINES, true);
  assert.match(summary.text, /Ephemeral failure guidance: rerun the Agent call/);
});

test("writes full-output artifacts with owner-only permissions", () => {
  const artifact = writeOutputArtifact("sensitive output");
  try {
    assert.equal(fs.readFileSync(artifact.filePath, "utf8"), "sensitive output");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(artifact.filePath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(artifact.dir, { recursive: true, force: true });
  }
});
