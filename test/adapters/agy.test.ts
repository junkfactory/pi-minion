import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  buildArgs,
  deriveAliases,
  describeUnsupported,
  environment,
  ownsModel,
  parseAgyModelsList,
  parseLine,
  refreshAgyModels,
  setAgyModelsForTesting
} from "../../src/adapters/agy.js";
import { resolveAlias } from "../../src/adapters/util.js";
import type { MinionConfig, MinionRequest } from "../../src/adapters/types.js";

// The `agy --output-format=json models` payload captured in-session
// (2026-10-05) — the fixture parseAgyModelsList tests re-parse and the
// seeded-catalog tests derive from. agy isn't installed on this machine, so
// this paste is the source of truth for the wire format.
const AGY_MODELS_STDOUT = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n...",
  duration_seconds: 0,
  num_turns: 0,
  usage: {},
  command: {
    name: "models",
    data: {
      models: [
        { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
        { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
        { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
        { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
        { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
        { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
        { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
        { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
        { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
        { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
        { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
        { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
        { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" }
      ]
    }
  }
});

// Same catalog as AGY_MODELS_STDOUT, pre-parsed and claude-filtered, so tests
// that operate on the parsed shape don't repeat the JSON.
const AGY_CATALOG = parseAgyModelsList(AGY_MODELS_STDOUT)!;

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

beforeEach(() => {
  setAgyModelsForTesting(AGY_CATALOG);
});

describe("parseAgyModelsList", () => {
  it("parses a real `agy models` payload into claude-filtered entries", () => {
    assert.deepEqual(parseAgyModelsList(AGY_MODELS_STDOUT), [
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
      { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
      { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
      { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
      { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
      { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
      { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" }
    ]);
  });

  it("returns undefined on malformed JSON, non-SUCCESS status, or a wrong shape", () => {
    assert.equal(parseAgyModelsList("not json"), undefined);
    assert.equal(
      parseAgyModelsList(JSON.stringify({ status: "ERROR", command: { data: { models: [] } } })),
      undefined
    );
    assert.equal(parseAgyModelsList(JSON.stringify({ status: "SUCCESS" })), undefined);
    assert.equal(
      parseAgyModelsList(JSON.stringify({ status: "SUCCESS", command: { data: { models: "nope" } } })),
      undefined
    );
  });

  it("returns [] only for a SUCCESS response with a genuinely empty list", () => {
    assert.deepEqual(
      parseAgyModelsList(JSON.stringify({ status: "SUCCESS", command: { data: { models: [] } } })),
      []
    );
  });

  it("keeps entries with a missing label but not a missing/empty id", () => {
    const stdout = JSON.stringify({
      status: "SUCCESS",
      command: { data: { models: [{ label: "no id" }, { id: "" }, { id: "gemini-9.9-flash-high" }] } }
    });
    assert.deepEqual(parseAgyModelsList(stdout), [{ id: "gemini-9.9-flash-high", label: undefined }]);
  });
});

describe("deriveAliases", () => {
  it("derives gemini-flash/gemini-pro/gpt-oss from the captured catalog", () => {
    const derived = deriveAliases(AGY_CATALOG).map((cluster) => cluster.name);
    assert.deepEqual(derived, ["gemini-flash", "gemini-pro", "gpt-oss"]);
  });

  it("groups ids whose only difference is a digit-led version token", () => {
    const clusters = deriveAliases([{ id: "gpt-oss-120b-medium" }, { id: "gpt-oss-20b-low" }]);
    assert.deepEqual(
      clusters.map((cluster) => [cluster.name, cluster.members.length]),
      [["gpt-oss", 2]]
    );
  });

  it("keeps an id without a digit-led token as its own single-member cluster", () => {
    // Plan rule: no version segment -> the stem is the full id; the trailing
    // token isn't effort-stripped (a version-less id would leak a meaningful
    // word from its alias name).
    const clusters = deriveAliases([{ id: "foo-medium" }, { id: "bar-high" }]);
    assert.deepEqual(
      clusters.map((alias) => alias.name),
      ["foo-medium", "bar-high"]
    );
    for (const cluster of clusters) {
      for (const member of cluster.members) {
        assert.equal(member.version, undefined);
        assert.equal(member.effort, undefined);
      }
    }
  });
});

describe("resolveAlias", () => {
  const alias = (name: string) => deriveAliases(AGY_CATALOG).find((cluster) => cluster.name === name);
  const geminiFlash = alias("gemini-flash");
  const geminiPro = alias("gemini-pro");
  const gptOss = alias("gpt-oss");

  it("picks the latest version's exact-effort member", () => {
    assert.equal(resolveAlias(geminiFlash!, "high"), "gemini-3.8-flash-high");
    assert.equal(resolveAlias(geminiFlash!, "low"), "gemini-3.8-flash-low");
  });

  it("falls back to the nearest effort rank, preferring higher", () => {
    assert.equal(resolveAlias(geminiPro!, "medium"), "gemini-3.1-pro-high");
    assert.equal(resolveAlias(gptOss!, "high"), "gpt-oss-120b-medium");
    assert.equal(resolveAlias(gptOss!, "low"), "gpt-oss-120b-medium");
  });

  it("returns the bare latest id when the cluster has no effort suffixes", () => {
    const cluster = deriveAliases([{ id: "future-9.9-model" }])[0];
    assert.equal(resolveAlias(cluster, "medium"), "future-9.9-model");
  });

  it("returns the only member's id for an unknown effort string", () => {
    assert.equal(resolveAlias(geminiPro!, "turbo"), "gemini-3.1-pro-high");
  });
});

describe("ownsModel", () => {
  it("claims exact catalog ids and derived aliases", () => {
    assert.equal(ownsModel("gemini-3.8-flash-high"), true);
    assert.equal(ownsModel("GEMINI-3.8-FLASH-HIGH"), true);
    assert.equal(ownsModel("gemini-flash"), true);
    assert.equal(ownsModel("gemini-pro"), true);
    assert.equal(ownsModel("gpt-oss"), true);
  });

  it("does not claim claude models, even though agy can also serve them", () => {
    assert.equal(ownsModel("claude-sonnet-4-6"), false);
    assert.equal(ownsModel("claude-opus-4-6-thinking"), false);
    assert.equal(ownsModel("sonnet"), false);
  });

  it("returns false for an unrelated model string", () => {
    assert.equal(ownsModel("totally-unknown"), false);
    assert.equal(ownsModel("gemini-9.9-flash-high"), false);
  });

  it("claims nothing with an empty catalog — a failed refresh routes to nothing", () => {
    setAgyModelsForTesting([]);
    assert.equal(ownsModel("gemini-flash"), false);
    assert.equal(ownsModel("gemini-3.8-flash-high"), false);
  });
});

describe("buildArgs", () => {
  it("resolves a derived alias to the latest version's effort-matched id", () => {
    const args = buildArgs(fakeRequest({ effort: "low" }), fakeConfig());
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "gemini-3.8-flash-low"
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

  it("passes a literal catalog id through unchanged", () => {
    const args = buildArgs(fakeRequest({ model: "gemini-3.6-flash-low" }), fakeConfig());
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "gemini-3.6-flash-low"
    ]);
  });

  it("passes an unresolvable model through unresolved when the catalog is empty", () => {
    setAgyModelsForTesting([]);
    const args = buildArgs(fakeRequest(), fakeConfig());
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "gemini-flash"
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

  it("appends adapterArgs.agy at the very end of the argv", () => {
    const args = buildArgs(fakeRequest(), fakeConfig({ adapterArgs: { agy: { args: ["--flag", "v"], preExec: [] } } }));
    assert.deepEqual(args.slice(-2), ["--flag", "v"]);
    assert.ok(!buildArgs(fakeRequest(), fakeConfig()).includes("--flag"));
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

describe("refreshAgyModels", () => {
  const bin = mkdtempSync(join(tmpdir(), "pi-minion-agy-"));
  const realPath = process.env.PATH;
  const fakeAgy = (payload: string) => {
    writeFileSync(join(bin, "agy"), `#!/bin/sh\necho '${payload}'\n`);
    chmodSync(join(bin, "agy"), 0o755);
    process.env.PATH = `${bin}:${realPath}`;
  };
  // Expired snapshot so refreshAgyModels actually spawns the fake agy.
  const seedExpired = () => setAgyModelsForTesting(AGY_CATALOG, 0);

  it("keeps the previous snapshot when agy answers with a non-SUCCESS status", async () => {
    seedExpired();
    fakeAgy('{"status":"ERROR","response":"not logged in"}');
    try {
      await refreshAgyModels();
      assert.equal(ownsModel("gpt-oss"), true);
    } finally {
      process.env.PATH = realPath;
      setAgyModelsForTesting(AGY_CATALOG);
    }
  });

  it("empties the snapshot only on a successful empty response", async () => {
    seedExpired();
    fakeAgy('{"status":"SUCCESS","command":{"data":{"models":[]}}}');
    try {
      await refreshAgyModels();
      assert.equal(ownsModel("gpt-oss"), false);
    } finally {
      process.env.PATH = realPath;
      setAgyModelsForTesting(AGY_CATALOG);
    }
  });
});
