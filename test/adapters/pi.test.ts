import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  availableModelIds,
  buildArgs,
  describeUnsupported,
  environment,
  ownsModel,
  parseLine,
  setModelRegistry
} from "../../src/adapters/pi.js";
import { fakeModelRegistry } from "../fakes.js";
import type { MinionConfig, MinionRequest } from "../../src/adapters/types.js";

function fakeConfig(overrides: Partial<MinionConfig> = {}): MinionConfig {
  return {
    allowedModels: ["gpt-6-luna", "gpt-5.6-terra"],
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
    model: "gpt-6-luna",
    effort: "medium",
    ...overrides
  } as MinionRequest;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("ownsModel", () => {
  beforeEach(() => {
    setModelRegistry(
      fakeModelRegistry([
        { id: "gpt-6-luna", provider: "opencode-go" },
        { id: "gpt-5.6-luna", provider: "opencode-go" },
        { id: "gpt-6.1-sol", provider: "openai-codex" },
        { id: "claude-sonnet-5-5", provider: "anthropic" }
      ])
    );
  });

  afterEach(() => {
    setModelRegistry(undefined);
  });

  it("claims bare ids that exist in the available catalog", () => {
    assert.equal(ownsModel("gpt-6-luna"), true);
    assert.equal(ownsModel("GPT-6-LUNA"), true);
  });

  it("claims provider/id references that exist in the catalog", () => {
    assert.equal(ownsModel("openai-codex/gpt-6.1-sol"), true);
    assert.equal(ownsModel("amazon-bedrock/global.anthropic.claude-opus-5-5"), false);
  });

  it("claims provider/alias references pi itself resolves (opencode-go/luna → gpt-6-luna)", () => {
    // pi accepts provider/alias (`pi auth check --model opencode-go/luna` →
    // ready), so a bare `id ===` slash match would reject a model pi runs.
    assert.equal(ownsModel("opencode-go/luna"), true);
    assert.equal(ownsModel("opencode-go/gpt-6-luna"), true);
    assert.equal(ownsModel("openai-codex/luna"), false);
    assert.equal(ownsModel("opencode-go/sol"), false);
  });

  it("claims short aliases a catalog id ends with (pi fuzzy-matches at spawn)", () => {
    assert.equal(ownsModel("luna"), true);
    assert.equal(ownsModel("sol"), true);
    assert.equal(ownsModel("terra"), false);
    assert.equal(ownsModel("astra"), false);
  });

  it("enumerates trailing-token aliases before bare ids for help_pi_minion", () => {
    // Version- and effort-shaped trailing tokens ("5" from
    // claude-opus-5-5) are not aliases — piAliasCandidates skips them.
    setModelRegistry(
      fakeModelRegistry([
        { id: "gpt-6-luna", provider: "openai-codex" },
        { id: "gpt-6.1-sol", provider: "openai-codex" },
        { id: "gemini-3.1-pro", provider: "google" },
        { id: "claude-opus-5-5", provider: "anthropic" }
      ])
    );
    try {
      assert.deepEqual(availableModelIds(), [
        "luna",
        "sol",
        "pro",
        "gpt-6-luna",
        "gpt-6.1-sol",
        "gemini-3.1-pro",
        "claude-opus-5-5"
      ]);
    } finally {
      setModelRegistry(undefined);
    }
  });

  it("claims nothing without a captured registry", () => {
    setModelRegistry(undefined);
    assert.equal(ownsModel("gpt-6-luna"), false);
    assert.equal(ownsModel("luna"), false);
    assert.equal(ownsModel("openai-codex/gpt-6.1-sol"), false);
  });

  it("claude/gemini ids stay with the claude and agy adapters by check order", () => {
    assert.equal(ownsModel("claude-sonnet-5-5"), true);
    assert.equal(ownsModel("gpt-oss"), false);
    assert.equal(ownsModel("gpt-oss-120b"), false);
    assert.equal(ownsModel("haiku"), false);
    assert.equal(ownsModel("gemini-flash"), false);
  });
});

describe("buildArgs", () => {
  it("runs JSON mode ephemerally with no extensions", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    assert.equal(flagValue(args, "--mode"), "json");
    assert.ok(args.includes("--no-session"));
    assert.ok(args.includes("--no-extensions"));
  });

  it("passes the model through and maps effort to --thinking", () => {
    const args = buildArgs(fakeRequest({ model: "openai-codex/gpt-6-sol", effort: "low" }), fakeConfig());
    assert.equal(flagValue(args, "--model"), "openai-codex/gpt-6-sol");
    assert.equal(flagValue(args, "--thinking"), "low");
  });

  it("passes short aliases through for pi's own pattern matching to resolve", () => {
    for (const alias of ["luna", "terra", "sol", "astra"]) {
      assert.equal(flagValue(buildArgs(fakeRequest({ model: alias }), fakeConfig()), "--model"), alias);
    }
  });

  it("passes the request's effort through to --thinking", () => {
    const args = buildArgs(fakeRequest({ effort: "high" }), fakeConfig());
    assert.equal(flagValue(args, "--thinking"), "high");
  });

  it("appends the minion prompt to the system prompt", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    assert.match(flagValue(args, "--append-system-prompt") ?? "", /no later turn to report back in/);
  });

  it("puts the task last, after -- so a leading dash isn't parsed as a flag", () => {
    const args = buildArgs(fakeRequest({ task: "-x do it", context: "some evidence" }), fakeConfig());
    assert.equal(args[args.length - 2], "--");
    assert.equal(args[args.length - 1], "-x do it\n\nContext:\nsome evidence");
  });

  it("never emits --tools or a budget flag — allowedTools uses Claude tool names", () => {
    const args = buildArgs(fakeRequest(), fakeConfig({ allowedTools: ["Bash"] }));
    assert.ok(!args.includes("--tools"));
    assert.ok(!args.includes("--max-budget-usd"));
  });

  it("spreads adapterArgs.pi just before the -- separator", () => {
    const args = buildArgs(fakeRequest(), fakeConfig({ adapterArgs: { pi: { args: ["--verbose"], preExec: [] } } }));
    assert.equal(args[args.indexOf("--") - 1], "--verbose");
    assert.equal(args[args.indexOf("--") + 1], "Explore the repo");
    assert.ok(!buildArgs(fakeRequest(), fakeConfig()).includes("--verbose"));
  });

  it("never leaks adapterArgs.pi.preExec into the adapter argv", () => {
    const args = buildArgs(
      fakeRequest(),
      fakeConfig({ adapterArgs: { pi: { args: [], preExec: ["env", "-u", "AWS_PROFILE"] } } })
    );
    assert.ok(!args.includes("env"));
    assert.ok(!args.includes("-u"));
    assert.ok(!args.includes("AWS_PROFILE"));
  });
});

describe("describeUnsupported", () => {
  it("warns about the missing budget ceiling and tool allowlist", () => {
    const warnings = describeUnsupported(fakeRequest(), fakeConfig());
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /maxBudgetUsd is unenforced/);
    assert.match(warnings[1], /auto-approved/);
  });
});

describe("environment", () => {
  it("passes PI_CODING_AGENT_DIR but not ANTHROPIC_API_KEY", () => {
    const original = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
    try {
      const env = environment();
      assert.ok(!("ANTHROPIC_API_KEY" in env));
      assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/pi-agent");
    } finally {
      for (const name of ["ANTHROPIC_API_KEY", "PI_CODING_AGENT_DIR"]) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
    }
  });
});

const usage = (input: number, output: number, cacheRead: number, total: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }
});

describe("parseLine", () => {
  it("ignores malformed and unrelated lines", () => {
    assert.deepEqual(parseLine("not json"), []);
    assert.deepEqual(parseLine(JSON.stringify({ type: "session", version: 3, id: "x" })), []);
    assert.deepEqual(parseLine(JSON.stringify({ type: "turn_start" })), []);
  });

  it("maps streamed text and thinking updates", () => {
    const update = (assistantMessageEvent: object) =>
      parseLine(JSON.stringify({ type: "message_update", usage: usage(0, 0, 0, 0), assistantMessageEvent }));
    assert.deepEqual(update({ type: "text_start", contentIndex: 0 }), [{ kind: "textBlockStart" }]);
    assert.deepEqual(update({ type: "text_delta", contentIndex: 0, delta: "OK" }), [
      { kind: "text", text: "OK" }
    ]);
    assert.deepEqual(update({ type: "thinking_delta", contentIndex: 0, delta: "hmm" }), [{ kind: "thinking" }]);
    assert.deepEqual(update({ type: "toolcall_delta", contentIndex: 0, delta: "{" }), []);
  });

  it("emits model, usageDelta and result for a final assistant message_end", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        model: "gpt-6-luna",
        responseModel: null,
        provider: "openai-codex",
        usage: usage(258, 5, 3584, 0.00006),
        stopReason: "stop"
      }
    });
    assert.deepEqual(parseLine(line), [
      { kind: "model", model: "gpt-6-luna" },
      { kind: "usageDelta", delta: { input: 258, output: 5, cacheWrite: 0, cacheRead: 3584 } },
      { kind: "result", result: "OK" }
    ]);
  });

  it("emits an error event for a failed assistant message_end", () => {
    const failed = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Region is missing" }
    });
    assert.deepEqual(parseLine(failed), [{ kind: "error", message: "Region is missing" }]);
  });

  it("emits a generic error event when the failed message has no errorMessage", () => {
    const failed = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" }
    });
    assert.deepEqual(parseLine(failed), [
      { kind: "error", message: "the model turn failed before producing a result" }
    ]);
  });

  it("emits no result for a tool-use turn or a user message_end", () => {
    const toolTurn = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
        model: "gpt-6-luna",
        responseModel: "gpt-6-luna-2026",
        usage: usage(10, 2, 0, 0.001),
        stopReason: "toolUse"
      }
    });
    assert.deepEqual(parseLine(toolTurn), [
      { kind: "model", model: "gpt-6-luna-2026" },
      { kind: "usageDelta", delta: { input: 10, output: 2, cacheWrite: 0, cacheRead: 0 } }
    ]);
    const userEnd = JSON.stringify({ type: "message_end", message: { role: "user", content: "hi" } });
    assert.deepEqual(parseLine(userEnd), []);
  });

  it("maps tool execution start/end", () => {
    const start = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "echo hi" }
    });
    assert.deepEqual(parseLine(start), [
      { kind: "toolUse", id: "c1", name: "bash", args: { command: "echo hi" } }
    ]);
    const end = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hi\n" }] },
      isError: false
    });
    assert.deepEqual(parseLine(end), [{ kind: "toolResult", id: "c1", output: "hi\n", isError: false }]);
  });

  it("sums assistant usage and cost per model at agent_end", () => {
    const line = JSON.stringify({
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", model: "gpt-6-luna", usage: usage(100, 10, 0, 0.25) },
        { role: "toolResult", content: [] },
        { role: "assistant", model: "gpt-6-luna", usage: usage(50, 5, 20, 0.5) }
      ]
    });
    assert.deepEqual(parseLine(line), [
      {
        kind: "usage",
        usage: {
          totalCostUsd: 0.75,
          inputTokens: 150,
          outputTokens: 15,
          cacheWriteTokens: 0,
          cacheReadTokens: 20,
          perModel: [
            {
              model: "gpt-6-luna",
              costUsd: 0.75,
              inputTokens: 150,
              outputTokens: 15,
              cacheWriteTokens: 0,
              cacheReadTokens: 20
            }
          ]
        }
      }
    ]);
  });
});
