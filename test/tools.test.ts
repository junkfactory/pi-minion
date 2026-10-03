import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { claudeAdapter } from "../src/adapters/claude.js";
import { agyAdapter } from "../src/adapters/agy.js";
import {
  buildHelpModelList,
  PI_MINION_EXAMPLES,
  RUN_PI_MINION_PARAMETERS,
  RUN_PI_MINION_WORKFLOW_PARAMETERS,
  SCHEDULE_PI_MINION_PARAMETERS,
  SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS
} from "../src/tools.js";

describe("buildHelpModelList", () => {
  it("drops models whose adapter binary isn't present, keeps the rest", () => {
    const result = buildHelpModelList(
      [
        { adapter: claudeAdapter, present: true },
        { adapter: agyAdapter, present: false }
      ],
      ["sonnet", "opus", "gemini-flash"]
    );
    assert.deepEqual(result, ["sonnet", "opus"]);
  });

  it("keeps allowedModels order across present adapters", () => {
    const result = buildHelpModelList(
      [
        { adapter: claudeAdapter, present: true },
        { adapter: agyAdapter, present: true }
      ],
      ["gemini-flash", "sonnet", "gpt-oss"]
    );
    assert.deepEqual(result, ["gemini-flash", "sonnet", "gpt-oss"]);
  });

  it("returns an empty list when no candidate is present", () => {
    assert.deepEqual(buildHelpModelList([{ adapter: claudeAdapter, present: false }], ["sonnet"]), []);
  });
});

describe("RUN_PI_MINION_PARAMETERS", () => {
  function baseArgs(overrides: Record<string, unknown> = {}) {
    return { task: "Explore the repo", model: "sonnet", context: "No prior context.", ...overrides };
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
  const runArgs = { task: "Explore the repo", model: "sonnet", context: "No prior context." };

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
    steps: [{ id: "a", task: "Find bugs", model: "sonnet" }]
  };

  it("accepts a minimal one-step workflow", () => {
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, args), true);
  });

  it("rejects missing context or an empty step list", () => {
    const { context, ...withoutContext } = args;
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, withoutContext), false);
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, steps: [] }), false);
  });
});

describe("SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS", () => {
  const args = {
    title: "Review",
    context: "No prior context.",
    steps: [{ id: "a", task: "Find bugs", model: "sonnet" }]
  };

  it("requires cron on top of the workflow fields", () => {
    assert.equal(Check(SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS, { ...args, cron: "0 9 * * 1-5" }), true);
    assert.equal(Check(SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS, args), false);
  });
});
