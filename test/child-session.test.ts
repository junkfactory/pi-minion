import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startWorkflowSession, writeChildSession } from "../src/child-session.js";

describe("writeChildSession", () => {
  const base = {
    cwd: "/w",
    name: "sonnet: Review the diff",
    prompt: "Review the diff",
    resultText: "LGTM",
    provider: "claude",
    model: "sonnet",
    startedAt: 0,
    finishedAt: 1000
  };
  const readEntries = async (file: string) =>
    (await readFile(file, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

  it("threads under the parent session with one assistant message per model carrying usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-child-"));
    try {
      const parentSessionFile = join(dir, "parent.jsonl");
      const file = writeChildSession({
        ...base,
        parentSessionFile,
        effort: "high",
        usage: {
          totalCostUsd: 0.3,
          inputTokens: 3,
          outputTokens: 30,
          cacheWriteTokens: 300,
          cacheReadTokens: 3000,
          perModel: [
            { model: "claude-sonnet-5", costUsd: 0.2, inputTokens: 1, outputTokens: 10, cacheWriteTokens: 100, cacheReadTokens: 1000 },
            { model: "claude-haiku-4-5-20251001", costUsd: 0.1, inputTokens: 2, outputTokens: 20, cacheWriteTokens: 200, cacheReadTokens: 2000 }
          ]
        }
      });
      assert.equal(dirname(file!), dir);
      const entries = await readEntries(file!);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentSessionFile);
      assert.equal(entries[0].cwd, "/w");
      assert.equal(entries.find((e) => e.type === "thinking_level_change").thinkingLevel, "high");
      assert.equal(entries.find((e) => e.type === "session_info").name, "sonnet: Review the diff");
      const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
      assert.equal(messages[0].role, "user");
      assert.deepEqual(
        messages.slice(1).map((m) => [m.provider, m.model, m.timestamp, m.usage.cost.total, m.content.length]),
        [
          ["claude", "claude-sonnet-5", 1000, 0.2, 0],
          ["claude", "claude-haiku-4-5-20251001", 1001, 0.1, 1]
        ]
      );
      assert.equal(messages[2].content[0].text, "LGTM");
      assert.equal(messages[1].usage.cacheRead, 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to usageRoot without a parent, using totals and $0 when the CLI reports no cost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-child-"));
    try {
      const file = writeChildSession({
        ...base,
        model: "gemini-3.1-pro",
        usageRoot: dir,
        usage: { totalCostUsd: undefined, inputTokens: 5, outputTokens: 6, cacheWriteTokens: 0, cacheReadTokens: 7, perModel: [] }
      });
      assert.equal(dirname(file!), join(dir, "1970-01"));
      const entries = await readEntries(file!);
      assert.equal(entries[0].parentSession, undefined);
      const assistant = entries.filter((e) => e.type === "message" && e.message.role === "assistant");
      assert.equal(assistant.length, 1);
      assert.equal(assistant[0].message.model, "gemini-3.1-pro");
      assert.deepEqual(
        [assistant[0].message.usage.input, assistant[0].message.usage.output, assistant[0].message.usage.cacheRead, assistant[0].message.usage.cost.total],
        [5, 6, 7, 0]
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("startWorkflowSession", () => {
  it("writes a zero-usage session at start, under the parent, and appends the summary on finish", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-wf-"));
    try {
      const parentSessionFile = join(dir, "parent.jsonl");
      const ws = startWorkflowSession({ parentSessionFile, cwd: "/w", name: "⛓ Review", plan: "PLAN", startedAt: 0 });
      const read = async () =>
        (await readFile(ws.file!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
      let entries = await read();
      assert.equal(dirname(ws.file!), dir);
      assert.equal(entries[0].parentSession, parentSessionFile);
      assert.equal(entries.find((e) => e.type === "session_info").name, "⛓ Review");
      let messages = entries.filter((e) => e.type === "message").map((e) => e.message);
      assert.deepEqual(messages.map((m) => [m.role, m.content[0]?.text]), [["user", "PLAN"], ["assistant", "Running…"]]);
      assert.equal(messages[1].usage.totalTokens, 0);
      assert.equal(messages[1].usage.cost.total, 0);
      ws.finish("SUMMARY", 5000);
      messages = (await read()).filter((e) => e.type === "message").map((e) => e.message);
      assert.equal(messages.at(-1).content[0].text, "SUMMARY");
      assert.equal(messages.at(-1).usage.cost.total, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
