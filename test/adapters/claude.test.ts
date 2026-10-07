import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildArgs,
  initModel,
  isTextBlockStart,
  isThinkingDelta,
  ownsModel,
  streamedMessageDeltaTokens,
  streamedResult,
  streamedText,
  streamedUsage,
  toolResults,
  toolUseArgs,
  toolUseStarted
} from "../../src/adapters/claude.js";
import type { MinionConfig, MinionRequest } from "../../src/adapters/types.js";

function fakeConfig(overrides: Partial<MinionConfig> = {}): MinionConfig {
  return {
    allowedModels: ["sonnet", "opus"],
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
    model: "sonnet",
    effort: "medium",
    ...overrides
  } as MinionRequest;
}

describe("ownsModel", () => {
  it("recognizes claude's short aliases and any claude-* id", () => {
    assert.equal(ownsModel("opus"), true);
    assert.equal(ownsModel("sonnet"), true);
    assert.equal(ownsModel("haiku"), true);
    assert.equal(ownsModel("fable"), true);
    assert.equal(ownsModel("claude-haiku-4-5-20251001"), true);
  });

  it("returns false for an unrelated model string", () => {
    assert.equal(ownsModel("gemini-3.8-flash-high"), false);
  });
});

describe("initModel", () => {
  it("extracts the resolved model id from the system/init event only", () => {
    assert.equal(
      initModel('{"type":"system","subtype":"init","model":"claude-opus-5-5"}'),
      "claude-opus-5-5"
    );
    assert.equal(initModel('{"type":"system","subtype":"status","model":"x"}'), undefined);
    assert.equal(initModel("not json"), undefined);
  });
});

describe("streamedResult / streamedText", () => {
  it("streamedResult extracts the final result string", () => {
    assert.equal(streamedResult('{"type":"result","result":"done"}'), "done");
    assert.equal(streamedResult('{"type":"other"}'), undefined);
    assert.equal(streamedResult("not json"), undefined);
  });

  it("streamedText extracts only text_delta stream events", () => {
    assert.equal(
      streamedText('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"hi"}}}'),
      "hi"
    );
    assert.equal(
      streamedText('{"type":"stream_event","event":{"delta":{"type":"other"}}}'),
      undefined
    );
    assert.equal(streamedText("not json"), undefined);
  });
});

describe("streamedUsage", () => {
  it("extracts total cost and splits the token fields from the terminal result event", () => {
    const line = JSON.stringify({
      type: "result",
      total_cost_usd: 0.0221861,
      usage: {
        input_tokens: 10,
        output_tokens: 39,
        cache_creation_input_tokens: 9140,
        cache_read_input_tokens: 22461
      }
    });
    assert.deepEqual(streamedUsage(line), {
      totalCostUsd: 0.0221861,
      inputTokens: 10,
      outputTokens: 39,
      cacheWriteTokens: 9140,
      cacheReadTokens: 22461,
      perModel: []
    });
  });

  it("still returns cost/tokens when the run ended in error (e.g. budget exhausted)", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      total_cost_usd: 0.063494,
      usage: { input_tokens: 0, output_tokens: 0 }
    });
    assert.deepEqual(streamedUsage(line), {
      totalCostUsd: 0.063494,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      perModel: []
    });
  });

  it("ignores non-result events and malformed JSON", () => {
    assert.equal(streamedUsage('{"type":"other","total_cost_usd":1}'), undefined);
    assert.equal(streamedUsage('{"type":"result"}'), undefined);
    assert.equal(streamedUsage("not json"), undefined);
  });

  it("sums tokens from modelUsage instead of the outer usage when a subagent was billed", () => {
    // Mirrors a real run: the top-level `usage` only covers the outermost
    // turn, but a Task-tool subagent invoked under a different model was
    // billed separately and total_cost_usd includes both.
    const line = JSON.stringify({
      type: "result",
      total_cost_usd: 1.2372148,
      usage: { input_tokens: 10, output_tokens: 2237, cache_creation_input_tokens: 3859, cache_read_input_tokens: 35590 },
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 172960,
          outputTokens: 28003,
          cacheReadInputTokens: 693113,
          cacheCreationInputTokens: 378548,
          costUSD: 1.2372148
        }
      }
    });
    assert.deepEqual(streamedUsage(line), {
      totalCostUsd: 1.2372148,
      inputTokens: 172960,
      outputTokens: 28003,
      cacheWriteTokens: 378548,
      cacheReadTokens: 693113,
      perModel: [
        {
          model: "claude-haiku-4-5-20251001",
          costUsd: 1.2372148,
          inputTokens: 172960,
          outputTokens: 28003,
          cacheWriteTokens: 378548,
          cacheReadTokens: 693113
        }
      ]
    });
  });

  it("sums modelUsage across every model billed, not just one", () => {
    const line = JSON.stringify({
      type: "result",
      total_cost_usd: 0.4079491499999999,
      usage: { input_tokens: 8, output_tokens: 5037, cache_creation_input_tokens: 23471, cache_read_input_tokens: 172378 },
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 27052,
          outputTokens: 2176,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 41519,
          costUSD: 0.13983075000000003
        },
        "claude-sonnet-5": {
          inputTokens: 8,
          outputTokens: 5037,
          cacheReadInputTokens: 172378,
          cacheCreationInputTokens: 23471,
          costUSD: 0.2681184
        }
      }
    });
    assert.deepEqual(streamedUsage(line), {
      totalCostUsd: 0.4079491499999999,
      inputTokens: 27060,
      outputTokens: 7213,
      cacheWriteTokens: 64990,
      cacheReadTokens: 172378,
      perModel: [
        {
          model: "claude-haiku-4-5-20251001",
          costUsd: 0.13983075000000003,
          inputTokens: 27052,
          outputTokens: 2176,
          cacheWriteTokens: 41519,
          cacheReadTokens: 0
        },
        {
          model: "claude-sonnet-5",
          costUsd: 0.2681184,
          inputTokens: 8,
          outputTokens: 5037,
          cacheWriteTokens: 23471,
          cacheReadTokens: 172378
        }
      ]
    });
  });

  it("falls back to the outer usage sum when modelUsage is absent or empty", () => {
    const line = JSON.stringify({
      type: "result",
      total_cost_usd: 0.063494,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {}
    });
    assert.deepEqual(streamedUsage(line), {
      totalCostUsd: 0.063494,
      inputTokens: 1,
      outputTokens: 2,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      perModel: []
    });
  });
});

describe("streamedMessageDeltaTokens", () => {
  it("extracts the per-field usage delta from a message_delta stream event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: {
          input_tokens: 2,
          output_tokens: 231,
          cache_creation_input_tokens: 27218,
          cache_read_input_tokens: 0
        }
      }
    });
    assert.deepEqual(streamedMessageDeltaTokens(line), {
      input: 2,
      output: 231,
      cacheWrite: 27218,
      cacheRead: 0
    });
  });

  it("ignores every other event type and malformed JSON", () => {
    assert.equal(
      streamedMessageDeltaTokens(
        JSON.stringify({ type: "assistant", message: { usage: { output_tokens: 1 } } })
      ),
      undefined
    );
    assert.equal(
      streamedMessageDeltaTokens(
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta" } })
      ),
      undefined
    );
    assert.equal(streamedMessageDeltaTokens('{"type":"result"}'), undefined);
    assert.equal(streamedMessageDeltaTokens("not json"), undefined);
  });
});

describe("isThinkingDelta", () => {
  it("detects only thinking_delta stream events", () => {
    assert.equal(
      isThinkingDelta('{"type":"stream_event","event":{"delta":{"type":"thinking_delta","thinking":"hm"}}}'),
      true
    );
    assert.equal(
      isThinkingDelta('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"hi"}}}'),
      false
    );
    assert.equal(isThinkingDelta("not json"), false);
  });
});

describe("isTextBlockStart", () => {
  it("detects a content_block_start event for a text block", () => {
    assert.equal(
      isTextBlockStart(
        '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}'
      ),
      true
    );
  });

  it("ignores a content_block_start event for a non-text block", () => {
    assert.equal(
      isTextBlockStart(
        '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use"}}}'
      ),
      false
    );
  });

  it("ignores other stream event types and malformed JSON", () => {
    assert.equal(
      isTextBlockStart('{"type":"stream_event","event":{"type":"content_block_delta"}}'),
      false
    );
    assert.equal(isTextBlockStart("not json"), false);
  });
});

describe("toolUseStarted", () => {
  it("extracts the tool id and name from a content_block_start/tool_use event", () => {
    assert.deepEqual(
      toolUseStarted(
        '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01Mzqt4QeP7NorUtvEnpBzDm","name":"Bash","input":{}}}}'
      ),
      { id: "toolu_01Mzqt4QeP7NorUtvEnpBzDm", name: "Bash" }
    );
  });

  it("ignores a content_block_start event for a non-tool_use block", () => {
    assert.equal(
      toolUseStarted(
        '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}'
      ),
      undefined
    );
  });

  it("ignores other stream event types and malformed JSON", () => {
    assert.equal(
      toolUseStarted(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}}'
      ),
      undefined
    );
    assert.equal(toolUseStarted("not json"), undefined);
  });
});

describe("toolUseArgs", () => {
  it("extracts fully-parsed args for each tool_use block in a consolidated assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }
        ]
      }
    });
    assert.deepEqual(toolUseArgs(line), [{ id: "toolu_1", args: { command: "ls" } }]);
  });

  it("skips a tool_use block with no args (empty input object)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "ToolSearch", input: {} }] }
    });
    assert.deepEqual(toolUseArgs(line), []);
  });

  it("ignores non-assistant messages and malformed JSON", () => {
    assert.deepEqual(toolUseArgs('{"type":"user","message":{"content":[]}}'), []);
    assert.deepEqual(toolUseArgs("not json"), []);
  });
});

describe("toolResults", () => {
  it("extracts a string-content tool_result, correlated by tool_use_id", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { tool_use_id: "toolu_1", type: "tool_result", content: "output text", is_error: false }
        ]
      }
    });
    assert.deepEqual(toolResults(line), [{ id: "toolu_1", output: "output text", isError: false }]);
  });

  it("stringifies non-string content (e.g. ToolSearch's tool_reference array)", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [{ type: "tool_reference", tool_name: "WebSearch" }]
          }
        ]
      }
    });
    assert.deepEqual(toolResults(line), [
      { id: "toolu_2", output: JSON.stringify([{ type: "tool_reference", tool_name: "WebSearch" }]), isError: false }
    ]);
  });

  it("marks isError true when is_error is set", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ tool_use_id: "toolu_3", type: "tool_result", content: "failed", is_error: true }]
      }
    });
    assert.deepEqual(toolResults(line), [{ id: "toolu_3", output: "failed", isError: true }]);
  });

  it("ignores non-user messages and malformed JSON", () => {
    assert.deepEqual(toolResults('{"type":"assistant","message":{"content":[]}}'), []);
    assert.deepEqual(toolResults("not json"), []);
  });
});

describe("buildArgs", () => {
  it("omits optional flags when not requested", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    assert.ok(!args.includes("--allowedTools"));
    assert.equal(args.at(-1), "Explore the repo");
  });

  it("includes allowedTools and effort when present", () => {
    const args = buildArgs(
      fakeRequest({ effort: "high" }),
      fakeConfig({ allowedTools: ["Bash", "Read"] })
    );
    assert.deepEqual(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 3), [
      "--allowedTools",
      "Bash",
      "Read"
    ]);
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
  });

  it("appends context to the task text", () => {
    const args = buildArgs(fakeRequest({ context: "some evidence" }), fakeConfig());
    assert.equal(args.at(-1), "Explore the repo\n\nContext:\nsome evidence");
  });

  it("falls back to config.maxBudgetUsd when the request omits an override", () => {
    const args = buildArgs(fakeRequest(), fakeConfig({ maxBudgetUsd: 5 }));
    assert.deepEqual(
      args.slice(args.indexOf("--max-budget-usd"), args.indexOf("--max-budget-usd") + 2),
      ["--max-budget-usd", "5"]
    );
  });

  it("prefers a request-level maxBudgetUsd over config.maxBudgetUsd", () => {
    const args = buildArgs(fakeRequest({ maxBudgetUsd: 10 }), fakeConfig({ maxBudgetUsd: 5 }));
    assert.deepEqual(
      args.slice(args.indexOf("--max-budget-usd"), args.indexOf("--max-budget-usd") + 2),
      ["--max-budget-usd", "10"]
    );
  });

  it("tells the minion not to background work and report back later", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1];
    assert.match(systemPrompt, /no later turn to report back in/);
  });

  it("spreads adapterArgs.claude just before the task positional", () => {
    const args = buildArgs(fakeRequest(), fakeConfig({ adapterArgs: { claude: { args: ["--strict-mcp-config"], preExec: [] } } }));
    assert.equal(args.at(-1), "Explore the repo");
    assert.equal(args.at(-2), "--strict-mcp-config");
    assert.ok(!buildArgs(fakeRequest(), fakeConfig()).includes("--strict-mcp-config"));
  });
});
