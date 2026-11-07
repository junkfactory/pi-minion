import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildArgs,
  createClaudeAdapter,
  assistantTurnId,
  initModel,
  isTerminalResult,
  isTextBlockStart,
  isThinkingDelta,
  parseLine,
  rawOwnsModel,
  streamedMessageDeltaTokens,
  streamedResult,
  streamedText,
  streamedUsage,
  toolResults,
  toolUseArgs,
  toolUseStarted,
  userMessageFrame
} from "../../src/adapters/claude.js";
import type { MinionConfig, MinionRequest } from "../../src/adapters/types.js";

function fakeConfig(overrides: Partial<MinionConfig> = {}): MinionConfig {
  return {
    models: { allowed: ["sonnet", "opus"] },
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

describe("rawOwnsModel", () => {
  it("recognizes claude's short aliases and any claude-* id", () => {
    const adapter = createClaudeAdapter(fakeConfig());
    assert.equal(adapter.rawOwnsModel("opus"), true);
    assert.equal(adapter.rawOwnsModel("sonnet"), true);
    assert.equal(adapter.rawOwnsModel("haiku"), true);
    assert.equal(adapter.rawOwnsModel("fable"), true);
    assert.equal(adapter.rawOwnsModel("claude-haiku-4-5-20251001"), true);
  });

  it("returns false for an unrelated model string", () => {
    assert.equal(rawOwnsModel("gemini-3.8-flash-high"), false);
  });
});

describe("ownsModel / availableModels (config-gated)", () => {
  it("gates ownsModel against the bound config without touching the raw claim", () => {
    const adapter = createClaudeAdapter(
      fakeConfig({ models: { allowed: [], blocked: ["sonnet"] } })
    );
    assert.equal(adapter.ownsModel("sonnet"), false);
    assert.equal(adapter.rawOwnsModel("sonnet"), true);
  });

  it("availableModels intersects an allowlist with rawOwnsModel", () => {
    const adapter = createClaudeAdapter(
      fakeConfig({ models: { allowed: ["claude-haiku-5-5", "gemini*"], blocked: [] } })
    );
    assert.ok(adapter.availableModels().includes("claude-haiku-5-5"));
    assert.ok(!adapter.availableModels().includes("gemini-3.8-flash-high"));
  });

  it("treats a glob allowlist as a pattern, not a literal id", () => {
    const glob = createClaudeAdapter(fakeConfig({ models: { allowed: ["claude-*"], blocked: [] } }));
    assert.deepEqual(glob.availableModels(), []);
    const exact = createClaudeAdapter(fakeConfig({ models: { allowed: ["claude-haiku-5-5"], blocked: [] } }));
    assert.deepEqual(exact.availableModels(), ["claude-haiku-5-5"]);
  });

  it("availableModels lists the four aliases when the allowlist is empty", () => {
    const adapter = createClaudeAdapter(fakeConfig({ models: { allowed: [], blocked: [] } }));
    assert.deepEqual(adapter.availableModels(), ["opus", "sonnet", "haiku", "fable"]);
  });

  it("availableModels is empty when the provider is config-blocked", () => {
    const adapter = createClaudeAdapter(
      fakeConfig({ models: { allowed: [], blocked: [] }, providers: { allowed: [], blocked: ["claude"] } })
    );
    assert.deepEqual(adapter.availableModels(), []);
  });
});

describe("assistantTurnId / isTerminalResult", () => {
  it("takes the id from the stream_event that OPENS an assistant message", () => {
    assert.deepEqual(
      assistantTurnId(JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } })),
      { id: "msg_1", opens: true }
    );
    // The consolidated line for the same message repeats its id, without
    // claiming to open the turn.
    assert.deepEqual(assistantTurnId(JSON.stringify({ type: "assistant", message: { id: "msg_1", content: [] } })), {
      id: "msg_1",
      opens: false
    });
    assert.equal(isTerminalResult(JSON.stringify({ type: "result", subtype: "success" })), true);
  });

  it("falls back to a stable id when the line carries none", () => {
    assert.deepEqual(assistantTurnId(JSON.stringify({ type: "assistant", message: { content: [] } })), {
      id: "current",
      opens: false
    });
    assert.deepEqual(
      assistantTurnId(JSON.stringify({ type: "stream_event", event: { type: "message_start", message: {} } })),
      { id: "current", opens: true }
    );
  });

  it("ignores every other event type and malformed JSON", () => {
    for (const line of [
      JSON.stringify({ type: "user", message: { content: [] } }),
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
      JSON.stringify({ type: "stream_event", event: { type: "text_delta", delta: { text: "hi" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } }),
      "not json"
    ]) {
      assert.equal(assistantTurnId(line), undefined);
      assert.equal(isTerminalResult(line), false);
    }
  });
});

describe("parseLine (turn boundaries)", () => {
  const messageStart = (id: string) =>
    JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id } } });
  const assistant = (id: string, text: string) =>
    JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }] } });

  it("counts a turn at the message_start that opens it, not at its completion", () => {
    const state = {};
    // Regression (F1): the boundary used to be the consolidated assistant
    // message, i.e. AFTER the turn streamed, so turn N+1 ran to completion
    // before a cap counted it.
    assert.deepEqual(parseLine(messageStart("msg_1"), state), [{ kind: "turnStart" }]);
    // Streaming content for the same message is not a new turn.
    assert.deepEqual(
      parseLine(
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }),
        state
      ).filter((event) => event.kind === "turnStart"),
      []
    );
    // Its completion repeats the id: exactly one turnStart for the response.
    assert.deepEqual(
      parseLine(assistant("msg_1", "hi"), state).filter((event) => event.kind === "turnStart"),
      []
    );
    // The next message's opening event is the second turn.
    assert.deepEqual(parseLine(messageStart("msg_2"), state), [{ kind: "turnStart" }]);
  });

  it("adopts the real id when an id-less opening event left the turn anonymous", () => {
    // A message_start without message.id still opens the turn ("current"); its
    // consolidated line naming msg_9 must UPDATE that turn, not count a second.
    const state = {};
    assert.deepEqual(
      parseLine(JSON.stringify({ type: "stream_event", event: { type: "message_start", message: {} } }), state),
      [{ kind: "turnStart" }]
    );
    assert.deepEqual(
      parseLine(assistant("msg_9", "hi"), state).filter((event) => event.kind === "turnStart"),
      []
    );
    assert.deepEqual(parseLine(messageStart("msg_10"), state), [{ kind: "turnStart" }]);
  });

  it("still counts a consolidated assistant message that arrives without a stream event", () => {
    const state = {};
    assert.deepEqual(parseLine(assistant("msg_1", "hi"), state), [{ kind: "turnStart" }]);
    assert.deepEqual(parseLine(assistant("msg_2", "again"), state), [{ kind: "turnStart" }]);
    // A replayed line (no parse state) always counts, as before.
    assert.deepEqual(parseLine(assistant("msg_2", "again")), [{ kind: "turnStart" }]);
  });

  it("keeps the result and usage events on the terminal result line", () => {
    const events = parseLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0.5,
        usage: { input_tokens: 1, output_tokens: 2 }
      })
    );
    assert.deepEqual(events.map((event) => event.kind), ["result", "usage", "runSettled"]);
    assert.deepEqual(events[0], { kind: "result", result: "done" });
  });

  it("maps the terminal result to runSettled, including a failed run", () => {
    const ok = parseLine(JSON.stringify({ type: "result", subtype: "success", result: "done" }));
    assert.deepEqual(ok[0], { kind: "result", result: "done" });
    assert.deepEqual(ok[ok.length - 1], { kind: "runSettled" });
    const failed = parseLine(JSON.stringify({ type: "result", subtype: "error_max_turns", result: "" }));
    assert.deepEqual(failed[failed.length - 1], { kind: "runSettled" });
  });

  it("emits neither event for a user message or a stream event", () => {
    for (const line of [
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } })
    ]) {
      const kinds = parseLine(line).map((event) => event.kind);
      assert.ok(!kinds.includes("turnStart"));
      assert.ok(!kinds.includes("runSettled"));
    }
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
    // The task no longer rides in argv: it is the first stdin frame.
    assert.ok(!args.includes("Explore the repo"));
    assert.deepEqual(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 2), [
      "--input-format",
      "stream-json"
    ]);
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

  it("carries the task and its context in the stdin frame, not argv", () => {
    const adapter = createClaudeAdapter(fakeConfig());
    const frame = adapter.stdinPrompt?.(fakeRequest({ context: "some evidence" }));
    assert.equal(frame, userMessageFrame("Explore the repo\n\nContext:\nsome evidence"));
    assert.ok(!buildArgs(fakeRequest({ context: "some evidence" }), fakeConfig()).join(" ").includes("some evidence"));
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

  it("instructs the minion to return a concise structured summary", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1];
    assert.match(systemPrompt, /covering outcome, key findings or changed files, verification .*?blockers/);
  });

  it("spreads adapterArgs.claude as the last argv entries", () => {
    const args = buildArgs(fakeRequest(), fakeConfig({ adapterArgs: { claude: { args: ["--strict-mcp-config"], preExec: [] } } }));
    assert.equal(args.at(-1), "--strict-mcp-config");
    assert.ok(!buildArgs(fakeRequest(), fakeConfig()).includes("--strict-mcp-config"));
  });
});

describe("stdin channel frame", () => {
  it("builds the SDK user-message frame as one newline-terminated JSON line", () => {
    assert.equal(
      userMessageFrame("do it"),
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "do it" }] },
        parent_tool_use_id: null
      })}\n`
    );
  });

  it("marks a shouldQuery:false frame for context-only delivery", () => {
    assert.deepEqual(JSON.parse(userMessageFrame("later", { shouldQuery: false })), {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "later" }] },
      parent_tool_use_id: null,
      shouldQuery: false
    });
    assert.equal("shouldQuery" in JSON.parse(userMessageFrame("now")), false);
  });

  it("exposes the interrupt cap frame and the steering frames through the interface", () => {
    const adapter = createClaudeAdapter(fakeConfig());
    const interrupt = JSON.parse(adapter.capStopFrame?.() ?? "");
    assert.equal(interrupt.type, "control_request");
    assert.equal(interrupt.subtype, "interrupt");
    assert.equal(typeof interrupt.request_id, "string");
    assert.ok(interrupt.request_id.length > 0);
    // A fresh id per stop request keeps two interrupts on one channel apart.
    assert.notEqual(JSON.parse(adapter.capStopFrame?.() ?? "").request_id, interrupt.request_id);
    assert.equal(adapter.steerFrame?.("turn left", "steer"), userMessageFrame("turn left"));
    assert.equal(adapter.steerFrame?.("then", "followUp"), userMessageFrame("then", { shouldQuery: false }));
  });
});
