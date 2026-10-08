import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import { createAgyAdapter, parseAgyModelsList, setAgyModelsForTesting } from "../src/adapters/agy.js";
import { createPiAdapter, setModelRegistry } from "../src/adapters/pi.js";
import { fakeConfig, fakeModelRegistry } from "./fakes.js";
import {
  buildHelpModelList,
  PI_MINION_EXAMPLES,
  RUN_PI_MINION_PARAMETERS,
  RUN_PI_MINION_WORKFLOW_PARAMETERS,
  SCHEDULE_PI_MINION_PARAMETERS,
  SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS
} from "../src/tools.js";

describe("adapter boundary", () => {
  // AgentCliAdapter (src/adapters/types.ts) is the only published surface
  // outside the adapter implementation files — CLI-specific modules
  // (claude.ts, agy.ts, pi.ts) must not be imported by outside code. This
  // turns that boundary comment into a red test: the registry is the only
  // door, and a new adapter module gets scanned automatically.
  it("no src file outside adapters/ imports a specific adapter module", async () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files = (await readdir(srcDir)).filter((name) => name.endsWith(".ts"));
    const offenders: string[] = [];
    for (const name of files) {
      const text = await readFile(join(srcDir, name), "utf8");
      if (/from "\.\/adapters\/(claude|agy|pi)\.js"/.test(text)) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      `CLI-specific adapters leaked outside adapters/: ${offenders.join(", ")} — ` +
        "route through registry.ts and the AgentCliAdapter interface instead"
    );
  });
});
describe("buildHelpModelList", () => {
  // Seed agy's live catalog for this file (node:test isolates files in their
  // own process) — parsed from the captured `agy models` payload.
  setAgyModelsForTesting(
    parseAgyModelsList(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            models: [
              { id: "gemini-3.8-flash-high" },
              { id: "gemini-3.8-flash-medium" },
              { id: "gemini-3.8-flash-low" },
              { id: "gemini-3.1-pro-high" },
              { id: "gemini-3.1-pro-low" },
              { id: "claude-sonnet-4-6" },
              { id: "gpt-oss-120b-medium" }
            ]
          }
        }
      })
    )
  );

  // Adapters are config-bound factories now: the config each test used to
  // pass alongside the candidate list goes into the factory instead. The
  // permissive default mirrors fakeConfig()'s registry.test override.
  const permissive = () => fakeConfig({ models: { allowed: [], blocked: [] } });
  const claudeOf = (config = permissive()) => createClaudeAdapter(config);
  const agyOf = (config = permissive()) => createAgyAdapter(config);
  const piOf = (config = permissive()) => createPiAdapter(config);

  it("only offers models of the adapters passed in (an absent adapter offers nothing)", () => {
    const config = fakeConfig({ models: { allowed: ["sonnet", "opus", "gemini-flash"], blocked: [] } });
    const result = buildHelpModelList([claudeOf(config)]);
    assert.deepEqual(result, ["sonnet", "opus"]);
  });

  it("keeps models.allowed order within an adapter and unions across adapters", () => {
    const config = fakeConfig({ models: { allowed: ["gemini-flash", "sonnet", "gpt-oss"], blocked: [] } });
    const result = buildHelpModelList([claudeOf(config), agyOf(config)]);
    assert.deepEqual(result, ["sonnet", "gemini-flash", "gpt-oss"]);
  });

  it("returns an empty list when no adapter is registered", () => {
    assert.deepEqual(buildHelpModelList([]), []);
  });

  it("with an empty allowlist, lists available catalog ids the registered adapters own", () => {
    setModelRegistry(
      fakeModelRegistry([
        { id: "gpt-6-luna", provider: "opencode-go" },
        { id: "gpt-6-luna", provider: "other-go" }
      ])
    );
    try {
      const result = buildHelpModelList([claudeOf(), piOf()]);
      // claude's own aliases (sonnet/opus/haiku/fable) + pi's live catalog:
      // exact bare ids, then provider-qualified pairs, deduped across
      // providers. Anything the adapters don't claim is filtered out.
      assert.deepEqual(result, ["opus", "sonnet", "haiku", "fable", "gpt-6-luna", "opencode-go/gpt-6-luna", "other-go/gpt-6-luna"]);
    } finally {
      setModelRegistry(undefined);
    }
  });

  it("with an empty allowlist, lists non-pi adapter ids even when the pi registry is unset", () => {
    // Regression: help_pi_minion used to source its universe from
    // availableModelIds() (the pi registry only), so claude/agy models
    // weren't listed when their CLIs were present, and "run opus minion"
    // later errored as an unsupported model.
    setModelRegistry(undefined);
    const result = buildHelpModelList([claudeOf(), agyOf(), piOf()]);
    assert.ok(result.includes("opus"), "claude alias missing");
    assert.ok(result.includes("sonnet"), "claude alias missing");
    assert.ok(result.includes("gemini-3.8-flash-high"), "agy id missing");
    assert.ok(result.includes("gpt-oss-120b-medium"), "agy id missing");
  });

  it("filters blocked ids out of an explicit allowlist", () => {
    const config = fakeConfig({ models: { allowed: ["sonnet", "gemini-flash"], blocked: ["gemini*"] } });
    const result = buildHelpModelList([claudeOf(config), agyOf(config)]);
    assert.deepEqual(result, ["sonnet"]);
  });

  it("filters blocked ids out of the allow-all universe", () => {
    const config = fakeConfig({ models: { allowed: [], blocked: ["gemini*"] } });
    const result = buildHelpModelList([claudeOf(config), agyOf(config)]);
    assert.ok(result.includes("sonnet"), "sonnet missing");
    assert.ok(!result.some((model) => model.startsWith("gemini")), `gemini ids leaked: ${result.join(", ")}`);
  });

  it("filters out every model of a blocked provider", () => {
    const config = fakeConfig({ models: { allowed: [], blocked: [] }, providers: { blocked: ["antigravity"] } });
    const result = buildHelpModelList([claudeOf(config), agyOf(config), piOf(config)]);
    assert.ok(result.includes("sonnet"), "claude models must survive an unrelated provider block");
    assert.ok(!result.includes("gpt-oss-120b-medium"), `agy gpt-oss leaked: ${result.join(", ")}`);
    assert.ok(!result.includes("gemini-flash"), `agy gemini-flash leaked: ${result.join(", ")}`);
  });

  it("keeps only models of an allowlisted provider", () => {
    const config = fakeConfig({ models: { allowed: [], blocked: [] }, providers: { allowed: ["claude"] } });
    const claude = claudeOf(config);
    const result = buildHelpModelList([claude, agyOf(config), piOf(config)]);
    assert.ok(result.includes("sonnet"), "claude models missing");
    assert.ok(
      result.every((model) => claude.ownsModel(model)),
      `non-claude model leaked under providers.allowed=[claude]: ${result.join(", ")}`
    );
  });

  it("hides a shared alias when any backing provider is blocked", () => {
    setModelRegistry(
      fakeModelRegistry([
        { id: "gpt-6-luna", provider: "opencode-go" },
        { id: "gpt-5.6-luna", provider: "amazon-bedrock" }
      ])
    );
    try {
      const blockedConfig = fakeConfig({ models: { allowed: [], blocked: [] }, providers: { blocked: ["opencode-go"] } });
      const blocked = buildHelpModelList([claudeOf(blockedConfig), agyOf(blockedConfig), piOf(blockedConfig)]);
      assert.ok(!blocked.includes("luna"), `shared alias leaked over a blocked provider: ${blocked.join(", ")}`);
      assert.ok(!blocked.includes("gpt-6-luna"), `blocked provider's id leaked: ${blocked.join(", ")}`);
      assert.ok(!blocked.includes("opencode-go/gpt-6-luna"), `blocked provider's qualified id leaked: ${blocked.join(", ")}`);
      assert.ok(blocked.includes("amazon-bedrock/gpt-5.6-luna"), `unblocked provider's qualified id missing: ${blocked.join(", ")}`);
      assert.ok(blocked.includes("gpt-5.6-luna"), `unblocked provider's id missing: ${blocked.join(", ")}`);
      const unrelatedConfig = fakeConfig({ models: { allowed: [], blocked: [] }, providers: { blocked: ["antigravity"] } });
      const unrelated = buildHelpModelList([claudeOf(unrelatedConfig), agyOf(unrelatedConfig), piOf(unrelatedConfig)]);
      assert.ok(unrelated.includes("gpt-6-luna"), `gpt-6-luna missing when no backing provider is blocked: ${unrelated.join(", ")}`);
      assert.ok(unrelated.includes("opencode-go/gpt-6-luna"), `opencode-go/gpt-6-luna missing when no backing provider is blocked: ${unrelated.join(", ")}`);
    } finally {
      setModelRegistry(undefined);
    }
  });
});

describe("RUN_PI_MINION_PARAMETERS", () => {
  function baseArgs(overrides: Record<string, unknown> = {}) {
    return { task: "Explore the repo", model: "sonnet", effort: "medium", context: "No prior context.", ...overrides };
  }

  it("rejects a call that omits context", () => {
    const { context, ...withoutContext } = baseArgs();
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, withoutContext), false);
  });

  it("accepts a call that states there is no prior context", () => {
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, baseArgs()), true);
  });

  it("still rejects a call missing task or model", () => {
    const { task, ...withoutTask } = baseArgs();
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, withoutTask), false);
    const { model, ...withoutModel } = baseArgs();
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, withoutModel), false);
  });

  it("rejects a call missing effort", () => {
    const { effort, ...withoutEffort } = baseArgs();
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, withoutEffort), false);
  });
});

describe("PI_MINION_EXAMPLES", () => {
  it("stays in sync with README.md's \"Using pi-minion\" section", async () => {
    const readmePath = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
    const readme = await readFile(readmePath, "utf8");
    for (const example of PI_MINION_EXAMPLES) {
      assert.ok(
        readme.includes(example),
        `README.md is missing the example prompt: "${example}"`
      );
    }
  });
});

describe("SCHEDULE_PI_MINION_PARAMETERS", () => {
  const runArgs = { task: "Explore the repo", model: "sonnet", effort: "medium", context: "No prior context." };

  it("accepts run_pi_minion's fields plus cron", () => {
    assert.equal(Check(SCHEDULE_PI_MINION_PARAMETERS, { ...runArgs, cron: "0 9 * * 1-5" }), true);
  });

  it("rejects a call without cron", () => {
    assert.equal(Check(SCHEDULE_PI_MINION_PARAMETERS, runArgs), false);
  });
});

describe("RUN_PI_MINION_WORKFLOW_PARAMETERS", () => {
  const args = {
    title: "Review",
    context: "No prior context.",
    steps: [{ id: "a", task: "Find bugs", model: "sonnet", effort: "medium" }]
  };

  it("accepts a minimal one-step workflow", () => {
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, args), true);
  });

  it("rejects missing context, an empty step list, or a step without effort", () => {
    const { context, ...withoutContext } = args;
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, withoutContext), false);
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, steps: [] }), false);
    const { effort, ...stepWithoutEffort } = args.steps[0];
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, steps: [stepWithoutEffort] }), false);
  });
});

describe("SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS", () => {
  const args = {
    title: "Review",
    context: "No prior context.",
    steps: [{ id: "a", task: "Find bugs", model: "sonnet", effort: "medium" }]
  };

  it("requires cron on top of the workflow fields", () => {
    assert.equal(Check(SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS, { ...args, cron: "0 9 * * 1-5" }), true);
    assert.equal(Check(SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS, args), false);
  });
});
