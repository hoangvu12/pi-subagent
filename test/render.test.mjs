import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createTestableRenderModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-render-"));
  const codingAgentStub = path.join(tmpDir, "pi-coding-agent-stub.mjs");
  const tuiStub = path.join(tmpDir, "pi-tui-stub.mjs");
  const modulePath = path.join(tmpDir, "render.testable.ts");

  fs.writeFileSync(codingAgentStub, `export function getMarkdownTheme() { return {}; }\n`);
  fs.writeFileSync(
    tuiStub,
    `export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); return child; }
    }
    export class Text { constructor(text) { this.text = text; } }
    export class Markdown { constructor(text) { this.text = text; } }
    export class Spacer { constructor(size) { this.size = size; } }
`,
  );

  const source = fs
    .readFileSync(path.join(process.cwd(), "render.ts"), "utf-8")
    .replace(
      'from "@earendil-works/pi-coding-agent"',
      'from "./pi-coding-agent-stub.mjs"',
    )
    .replace('from "@earendil-works/pi-tui"', 'from "./pi-tui-stub.mjs"')
    .replace(
      'from "./runner-events.js"',
      `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "runner-events.js")).href)}`,
    )
    .replace(
      'from "./types.js"',
      `from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "types.ts")).href)}`,
    );
  fs.writeFileSync(modulePath, source);

  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function collectText(component) {
  if (!component) return [];
  const own = typeof component.text === "string" ? [component.text] : [];
  const children = Array.isArray(component.children)
    ? component.children.flatMap((child) => collectText(child))
    : [];
  return [...own, ...children];
}

test("shortenPath only shortens the home directory and its descendants", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { shortenPath } = await import(moduleUrl);
    const home = os.homedir();

    assert.equal(shortenPath(home), "~");
    assert.equal(shortenPath(path.join(home, "project", "src")), path.join("~", "project", "src"));
    assert.equal(shortenPath(`${home}-other/project`), `${home}-other/project`);
    assert.equal(shortenPath("relative/project"), "relative/project");
  } finally {
    cleanup();
  }
});

test("call renderer marks parent cloning and distinguishes inactivity from wall timeout", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderCall } = await import(moduleUrl);
    const component = renderCall(
      {
        calls: [{
          agent: "review",
          prompt: "Review this",
          initialContext: "parent",
          inactivityTimeout: 30,
          timeout: 300,
        }],
      },
      theme,
    );

    assert.match(component.text, /⚠ parent context requested/);
    assert.match(component.text, /idle=30s/);
    assert.match(component.text, /wall=300s/);
  } finally {
    cleanup();
  }
});

test("expanded renderer tolerates legacy pre-prompt results with task", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderResult } = await import(moduleUrl);
    const component = renderResult(
      {
        content: [{ type: "text", text: "legacy" }],
        details: {
          projectAgentsDir: null,
          results: [
            {
              callIndex: 0,
              agent: "review",
              agentSource: "user",
              task: "old task field",
              initialContext: "empty",
              exitCode: 0,
              messages: [],
              stderr: "",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
              },
            },
          ],
        },
      },
      true,
      theme,
    );

    const renderedText = collectText(component);
    assert.ok(renderedText.some((text) => text.includes("1: review")));
    assert.ok(renderedText.some((text) => text.includes("Prompt: old task field")));
  } finally {
    cleanup();
  }
});

test("renderers use the Agent tool title and surface job identity", async () => {
  const { moduleUrl, cleanup } = createTestableRenderModule();
  try {
    const { renderCall, renderResult } = await import(moduleUrl);
    const call = renderCall({ calls: [{ agent: "review", prompt: "Check" }] }, theme);
    assert.match(call.text, /Agent 1 call/);
    assert.doesNotMatch(call.text, /subagent 1 call/);

    const component = renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          projectAgentsDir: null,
          results: [
            {
              callIndex: 0,
              agent: "review",
              agentSource: "user",
              initialContext: "empty",
              exitCode: 0,
              messages: [],
              stderr: "",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
              },
              job: {
                id: "job-abc123",
                agent: "review",
                status: "done",
                childSessionId: null,
                childSessionFile: null,
                model: null,
                cwd: "/tmp",
                spawnedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          ],
        },
      },
      true,
      theme,
    );

    const renderedText = collectText(component);
    assert.ok(
      renderedText.some((text) => /Agent \d+\/\d+ succeeded/.test(text)),
      "result title uses the Agent name",
    );
    assert.ok(renderedText.some((text) => text.includes("job-abc123 (done)")), "expanded results show job id and status");
  } finally {
    cleanup();
  }
});
