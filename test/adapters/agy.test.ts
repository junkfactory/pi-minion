import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildArgs,
  describeUnsupported,
  environment,
  ownsModel,
  parseLine
} from "../../src/adapters/agy.js";
import type { MinionConfig, MinionRequest } from "../../src/adapters/types.js";

function fakeConfig(overrides: Partial<MinionConfig> = {}): MinionConfig {
  return {
    allowedModels: ["gemini-flash", "gemini-pro", "gpt-oss"],
    allowedTools: [],
    maxBudgetUsd: 5,
    timeoutMs: 900_000,
    ...overrides
  };
}

function fakeRequest(overrides: Partial<MinionRequest> = {}): MinionRequest {
  return {
    task: "Explore the repo",
    workspace: "/tmp/workspace",
    model: "gemini-flash",
    effort: "medium",
    ...overrides
  } as MinionRequest;
}

describe("ownsModel", () => {
  it("recognizes the short aliases and any literal gemini-/gpt-oss- slug", () => {
    assert.equal(ownsModel("gemini-flash"), true);
    assert.equal(ownsModel("gemini-pro"), true);
    assert.equal(ownsModel("gpt-oss"), true);
    assert.equal(ownsModel("gemini-3.6-flash-low"), true);
    assert.equal(ownsModel("gpt-oss-120b-medium"), true);
  });

  it("does not claim claude models, even though agy can also serve them", () => {
    assert.equal(ownsModel("claude-sonnet-4-6"), false);
    assert.equal(ownsModel("sonnet"), false);
  });

  it("returns false for an unrelated model string", () => {
    assert.equal(ownsModel("totally-unknown"), false);
  });
});

describe("buildArgs", () => {
  it("resolves a short alias to its bare model id and always includes --effort", () => {
    const args = buildArgs(fakeRequest({ effort: "low" }), fakeConfig());
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "gemini-3.8-flash"
    ]);
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), [
      "--effort",
      "low"
    ]);
  });

  it("passes the request's effort through to --effort", () => {
    const args = buildArgs(fakeRequest({ effort: "high" }), fakeConfig());
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), [
      "--effort",
      "high"
    ]);
  });

  it("passes a literal, unaliased model id through unresolved", () => {
    const args = buildArgs(fakeRequest({ model: "gemini-3.6-flash-low" }), fakeConfig());
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "gemini-3.6-flash-low"
    ]);
  });

  it("always includes --dangerously-skip-permissions and --disable-slash-commands", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(args.includes("--disable-slash-commands"));
  });

  it("never emits --allowedTools or --max-budget-usd — agy has no equivalent flags", () => {
    const args = buildArgs(fakeRequest(), fakeConfig({ allowedTools: ["Bash"] }));
    assert.ok(!args.includes("--allowedTools"));
    assert.ok(!args.includes("--max-budget-usd"));
  });

  it("prepends the minion prompt to the task text — agy has no --append-system-prompt flag", () => {
    const args = buildArgs(fakeRequest({ context: "some evidence" }), fakeConfig());
    const task = args[0] ?? "";
    assert.ok(task.startsWith("-p=You are an independent pi minion"));
    assert.ok(task.endsWith("Explore the repo\n\nContext:\nsome evidence"));
  });

  it("tells the minion not to background work and report back later", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    assert.match(args[0] ?? "", /no later turn to report back in/);
  });

  it("folds -p and the task into a single token so no later flag can be swallowed as its value", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    assert.ok(args[0].startsWith("-p="));
    assert.ok(!args.includes("-p"));
    assert.equal(args[1], "--disable-slash-commands");
  });
});

describe("describeUnsupported", () => {
  it("always warns about the missing cost ceiling/reporting and the permission-skip posture", () => {
    const warnings = describeUnsupported(fakeRequest(), fakeConfig());
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /cost ceiling or reporting/);
    assert.match(warnings[1], /permission classifier/);
  });
});

describe("environment", () => {
  it("never includes an ANTHROPIC_API_KEY — agy auth is cached-credential based", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      assert.ok(!("ANTHROPIC_API_KEY" in environment()));
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

describe("parseLine", () => {
  it("extracts the resolved model id from the init event", () => {
    const line = JSON.stringify({ event: "init", init: { model: "gpt-oss-120b", cwd: "/tmp" } });
    assert.deepEqual(parseLine(line), [{ kind: "model", model: "gpt-oss-120b" }]);
  });

  it("extracts a text delta from an in-progress agent_response step", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "pong" }
    });
    assert.deepEqual(parseLine(line), [{ kind: "text", text: "pong" }]);
  });

  it("emits a usageDelta when a DONE agent_response step carries usage, folding thinking into output", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "\n",
        usage: { input_tokens: 13328, output_tokens: 1, thinking_tokens: 160, cache_read_tokens: 0 }
      }
    });
    assert.deepEqual(parseLine(line), [
      { kind: "text", text: "\n" },
      { kind: "usageDelta", delta: { input: 13328, output: 161, cacheWrite: 0, cacheRead: 0 } }
    ]);
  });

  it("ignores non-agent_response, non-tool step_update events", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: { step_index: 0, state: "DONE", step_type: "user_input" }
    });
    assert.deepEqual(parseLine(line), []);
  });

  it("emits toolUse with its args when a tool step becomes ACTIVE", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "find_by_name",
        tool_info: { name: "find_by_name", parameters: { Pattern: "*.json" } }
      }
    });
    assert.deepEqual(parseLine(line), [
      { kind: "toolUse", id: "2", name: "find_by_name", args: { Pattern: "*.json" } }
    ]);
  });

  it("emits toolResult with duration and output when the same tool step reports DONE", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "find_by_name",
        duration_seconds: 0.06,
        tool_info: { name: "find_by_name", parameters: { Pattern: "*.json" }, output: "3 matches" }
      }
    });
    assert.deepEqual(parseLine(line), [
      { kind: "toolResult", id: "2", durationMs: 60, output: "3 matches", isError: false }
    ]);
  });

  it("emits toolResult with isError true and the error message when a tool step reports ERROR", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 6,
        state: "ERROR",
        step_type: "tool",
        tool_name: "read_url_content",
        duration_seconds: 1.2,
        tool_info: { name: "read_url_content", parameters: { url: "https://example.com" }, error: { message: "403 Forbidden" } }
      }
    });
    assert.deepEqual(parseLine(line), [
      { kind: "toolResult", id: "6", durationMs: 1200, output: "403 Forbidden", isError: true }
    ]);
  });

  it("extracts the result and usage from a successful terminal result event", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "pong\n",
        usage: { input_tokens: 13328, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 5 }
      }
    });
    assert.deepEqual(parseLine(line), [
      { kind: "result", result: "pong\n" },
      {
        kind: "usage",
        usage: {
          totalCostUsd: undefined,
          inputTokens: 13328,
          outputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 5,
          perModel: []
        }
      }
    ]);
  });

  it("does not emit a result event on a failed status", () => {
    const line = JSON.stringify({
      event: "result",
      result: { status: "ERROR", response: "", error: "invalid model selection" }
    });
    assert.deepEqual(parseLine(line), []);
  });

  it("emits permissionDenied when the terminal result carries denied_actions", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "",
        denied_actions: [{ action: "command", display_name: "RunCommand" }]
      }
    });
    const events = parseLine(line);
    assert.ok(events.some((event) => event.kind === "permissionDenied"));
  });

  it("ignores malformed JSON", () => {
    assert.deepEqual(parseLine("not json"), []);
  });
});
