import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { claudeAdapter } from "../src/adapters/claude.js";
import { agyAdapter, parseAgyModelsList, setAgyModelsForTesting } from "../src/adapters/agy.js";
import { piAdapter, setModelRegistry } from "../src/adapters/pi.js";
import { fakeModelRegistry } from "./fakes.js";
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
  it("drops models whose adapter binary isn't present, keeps the rest", () => {
    const result = buildHelpModelList(
      [
        { adapter: claudeAdapter, present: true },
        { adapter: agyAdapter, present: false }
      ],
      { allowedModels: ["sonnet", "opus", "gemini-flash"], blockedModels: [] }
    );
    assert.deepEqual(result, ["sonnet", "opus"]);
  });

  it("keeps allowedModels order across present adapters", () => {
    const result = buildHelpModelList(
      [
        { adapter: claudeAdapter, present: true },
        { adapter: agyAdapter, present: true }
      ],
      { allowedModels: ["gemini-flash", "sonnet", "gpt-oss"], blockedModels: [] }
    );
    assert.deepEqual(result, ["gemini-flash", "sonnet", "gpt-oss"]);
  });

  it("returns an empty list when no candidate is present", () => {
    assert.deepEqual(
      buildHelpModelList([{ adapter: claudeAdapter, present: false }], { allowedModels: ["sonnet"], blockedModels: [] }),
      []
    );
  });

  it("with an empty allowlist, lists available catalog ids the present adapters own", () => {
    setModelRegistry(
      fakeModelRegistry([
        { id: "gpt-6-luna", provider: "opencode-go" },
        { id: "gpt-6-luna", provider: "other-go" }
      ])
    );
    try {
      const result = buildHelpModelList(
        [
          { adapter: claudeAdapter, present: true },
          { adapter: piAdapter, present: true }
        ],
        { allowedModels: [], blockedModels: [] }
      );
      // claude's own aliases (sonnet/opus/haiku/fable) + pi's live
      // catalog (gpt-6-luna, deduped across providers); anything the
      // adapters don't claim is filtered out.
      assert.deepEqual(result, ["opus", "sonnet", "haiku", "fable", "gpt-6-luna"]);
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
    const result = buildHelpModelList(
      [
        { adapter: claudeAdapter, present: true },
        { adapter: agyAdapter, present: true },
        { adapter: piAdapter, present: true }
      ],
      { allowedModels: [], blockedModels: [] }
    );
    assert.ok(result.includes("opus"), "claude alias missing");
    assert.ok(result.includes("sonnet"), "claude alias missing");
    assert.ok(result.includes("gemini-flash"), "agy alias missing");
    assert.ok(result.includes("gpt-oss"), "agy alias missing");
  });

  it("filters blocked ids out of an explicit allowlist", () => {
    const result = buildHelpModelList(
      [
        { adapter: claudeAdapter, present: true },
        { adapter: agyAdapter, present: true }
      ],
      { allowedModels: ["sonnet", "gemini-flash"], blockedModels: ["gemini*"] }
    );
    assert.deepEqual(result, ["sonnet"]);
  });

  it("filters blocked ids out of the allow-all universe", () => {
    const result = buildHelpModelList(
      [
        { adapter: claudeAdapter, present: true },
        { adapter: agyAdapter, present: true }
      ],
      { allowedModels: [], blockedModels: ["gemini*"] }
    );
    assert.ok(result.includes("sonnet"), "sonnet missing");
    assert.ok(!result.some((model) => model.startsWith("gemini")), `gemini ids leaked: ${result.join(", ")}`);
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
