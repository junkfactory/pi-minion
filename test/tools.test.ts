import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { Cron } from "croner";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import { createAgyAdapter, parseAgyModelsList, setAgyModelsForTesting } from "../src/adapters/agy.js";
import { createPiAdapter, setModelRegistry } from "../src/adapters/pi.js";
import { createFmAdapter, FM_USAGE_NOTES } from "../src/adapters/fm.js";
import { setAdaptersForTest } from "../src/adapters/registry.js";
import { createFakeAdapter, fakeConfig, fakeModelRegistry } from "./fakes.js";
import {
  buildHelpAgentList,
  buildHelpModelList,
  buildUsageNotes,
  PI_MINION_EXAMPLES,
  PI_MINION_USAGE_NOTES,
  RUN_PI_MINION_PARAMETERS,
  RUN_PI_MINION_WORKFLOW_PARAMETERS,
  SCHEDULE_PI_MINION_PARAMETERS,
  SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS,
  STEER_PI_MINION_PARAMETERS,
  pinScheduleRequest,
  registerTools
} from "../src/tools.js";
import { resolveMaxTurns } from "../src/job-runner.js";
import { jobMeta } from "../src/job-store.js";
import { schedules } from "../src/schedule-store.js";

// Schema introspection helpers shared by the parameter-shape describes below.
type Schema = { properties: Record<string, unknown>; required?: string[] };
const stepSchema = (): Schema =>
  (RUN_PI_MINION_WORKFLOW_PARAMETERS as unknown as { properties: { steps: { items: Schema } } })
    .properties.steps.items;
const descriptionOf = (schema: Schema, key: string): string =>
  (schema.properties[key] as { description?: string } | undefined)?.description ?? "";

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
      // provider-qualified ids. Anything the adapters don't claim is filtered out.
      assert.deepEqual(result, ["opus", "sonnet", "haiku", "fable", "opencode-go/gpt-6-luna", "other-go/gpt-6-luna"]);
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

  it("hides a provider's ref when that provider is blocked", () => {
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
      assert.ok(!blocked.includes("gpt-5.6-luna"), `bare id should not be listed: ${blocked.join(", ")}`);
      const unrelatedConfig = fakeConfig({ models: { allowed: [], blocked: [] }, providers: { blocked: ["antigravity"] } });
      const unrelated = buildHelpModelList([claudeOf(unrelatedConfig), agyOf(unrelatedConfig), piOf(unrelatedConfig)]);
      assert.ok(!unrelated.includes("gpt-6-luna"), `bare id should not be listed: ${unrelated.join(", ")}`);
      assert.ok(unrelated.includes("opencode-go/gpt-6-luna"), `opencode-go/gpt-6-luna missing when no backing provider is blocked: ${unrelated.join(", ")}`);
    } finally {
      setModelRegistry(undefined);
    }
  });
});

describe("buildUsageNotes", () => {
  // Real factories, permissive config — production-faithful notes; only fm
  // has non-empty lines today (claude/agy/pi return []).
  const permissive = () => fakeConfig({ models: { allowed: [], blocked: [] } });
  const claudeOf = (config = permissive()) => createClaudeAdapter(config);
  const agyOf = (config = permissive()) => createAgyAdapter(config);
  const piOf = (config = permissive()) => createPiAdapter(config);
  const fmOf = (config = permissive()) => createFmAdapter(config);

  it("orders shared notes first, adapter notes after, user notes last", () => {
    const notes = buildUsageNotes([claudeOf(), agyOf(), piOf(), fmOf()], { usageNotes: ["user note"] });
    assert.deepEqual(notes.slice(0, PI_MINION_USAGE_NOTES.length), PI_MINION_USAGE_NOTES);
    const fmStart = notes.indexOf(FM_USAGE_NOTES[0]);
    assert.ok(fmStart !== -1, "fm lines missing");
    assert.ok(fmStart >= PI_MINION_USAGE_NOTES.length, "adapter lines intrude on the shared block");
    assert.equal(notes[fmStart + 1], FM_USAGE_NOTES[1]);
    assert.equal(notes.at(-1), "user note");
  });

  it("omits an unregistered adapter's lines entirely", () => {
    const notes = buildUsageNotes([claudeOf(), agyOf(), piOf()], { usageNotes: [] });
    assert.equal(notes.indexOf(FM_USAGE_NOTES[0]), -1);
  });

  it("contributes nothing from adapters whose usageNotes are all empty", () => {
    // Substantiate the precondition: only fm emits built-in adapter lines.
    assert.deepEqual(
      [claudeOf(), agyOf(), piOf()].flatMap((adapter) => adapter.usageNotes()),
      []
    );
    const configNotes = ["a", "b"];
    assert.deepEqual(
      buildUsageNotes([claudeOf(), agyOf(), piOf()], { usageNotes: configNotes }),
      [...PI_MINION_USAGE_NOTES, ...configNotes]
    );
  });

  it("returns just shared + user notes when no adapters are registered", () => {
    assert.deepEqual(buildUsageNotes([], { usageNotes: ["x"] }), [...PI_MINION_USAGE_NOTES, "x"]);
  });

  it("pins the config.usageNotes fallback when the key is absent", () => {
    assert.deepEqual(buildUsageNotes([fmOf()], {}), [...PI_MINION_USAGE_NOTES, ...FM_USAGE_NOTES]);
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

  it("still rejects a call missing task, but takes model only from the agent", () => {
    const { task, ...withoutTask } = baseArgs();
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, withoutTask), false);
    const { model, ...withoutModel } = baseArgs();
    // Optional in the schema so a prompt-only agent can be named instead; an
    // omitted model with no agent still fails, but in validateRequest.
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, withoutModel), true);
    assert.match(descriptionOf(RUN_PI_MINION_PARAMETERS, "model"), /Required unless the named `agent` supplies one/);
  });

  it("accepts an agent, which is the only way model/effort may be omitted", () => {
    const { model, effort, ...withoutModelEffort } = baseArgs({ agent: "code-reviewer" });
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, { ...withoutModelEffort, agent: "code-reviewer" }), true);
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, { ...baseArgs(), agent: 7 }), false);
    const agent = descriptionOf(RUN_PI_MINION_PARAMETERS, "agent");
    assert.match(agent, /help_pi_minion's `agents` list/);
    assert.match(agent, /unknown name fails with the list of valid names/);
    assert.match(descriptionOf(RUN_PI_MINION_PARAMETERS, "effort"), /Required unless the named `agent` supplies one/);
  });

  it("accepts a timeoutMs and rejects a non-number", () => {
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, baseArgs({ timeoutMs: 300_000 })), true);
    assert.equal(Check(RUN_PI_MINION_PARAMETERS, baseArgs({ timeoutMs: "5m" })), false);
  });

  it("accepts a maxTurns bounded 1..100000 and rejects anything outside it", () => {
    for (const maxTurns of [1, 100_000]) {
      assert.equal(Check(RUN_PI_MINION_PARAMETERS, baseArgs({ maxTurns })), true, `maxTurns=${maxTurns}`);
    }
    for (const maxTurns of [0, -1, 100_001, 2.5]) {
      assert.equal(Check(RUN_PI_MINION_PARAMETERS, baseArgs({ maxTurns })), false, `maxTurns=${maxTurns} should fail`);
    }
  });

  it("describes maxTurns with the enforced bounds and the real default chain", () => {
    const description = (schema: Schema) => descriptionOf(schema, "maxTurns");
    const run = description(RUN_PI_MINION_PARAMETERS as Schema);
    assert.match(run, /1\.\.100000/);
    assert.match(run, /config maxTurns applies \(400 in the shipped config\)/);
    assert.match(run, /omitting never silently means unlimited/);
    assert.match(run, /maxTurns=N reached/);
    const workflow = description(RUN_PI_MINION_WORKFLOW_PARAMETERS as Schema);
    assert.match(workflow, /step resolves its own maxTurns, then this value, then the config maxTurns/);
    assert.match(workflow, /unlimited only when all are absent/);
    const step = description(
      (RUN_PI_MINION_WORKFLOW_PARAMETERS as unknown as { properties: { steps: { items: Schema } } }).properties
        .steps.items
    );
    assert.match(step, /resolves this value, then the workflow default, then the config maxTurns/);
    // Both schedule schemas reuse those descriptions verbatim.
    assert.equal(description(SCHEDULE_PI_MINION_PARAMETERS as Schema), run);
    assert.equal(description(SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS as Schema), workflow);
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

describe("STEER_PI_MINION_PARAMETERS", () => {
  it("requires id and message and accepts only the two delivery modes", () => {
    const call = { id: "job-1", message: "go left instead" };
    assert.equal(Check(STEER_PI_MINION_PARAMETERS, call), true);
    assert.equal(Check(STEER_PI_MINION_PARAMETERS, { ...call, deliverAs: "steer" }), true);
    assert.equal(Check(STEER_PI_MINION_PARAMETERS, { ...call, deliverAs: "followUp" }), true);
    assert.equal(Check(STEER_PI_MINION_PARAMETERS, { ...call, deliverAs: "later" }), false);
    assert.equal(Check(STEER_PI_MINION_PARAMETERS, { id: "job-1" }), false);
    assert.equal(Check(STEER_PI_MINION_PARAMETERS, { message: "go left" }), false);
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

  it("rejects missing context or an empty step list, but takes a step's model/effort from its agent", () => {
    const { context, ...withoutContext } = args;
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, withoutContext), false);
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, steps: [] }), false);
    const { model, effort, ...stepWithoutModelEffort } = args.steps[0];
    assert.equal(
      Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, steps: [{ ...stepWithoutModelEffort, agent: "reviewer" }] }),
      true
    );
    assert.match(descriptionOf(stepSchema(), "agent"), /help_pi_minion's `agents` list/);
  });

  it("accepts a step's own timeoutMs and a workflow-level one", () => {
    assert.equal(
      Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, steps: [{ ...args.steps[0], timeoutMs: 300_000 }] }),
      true
    );
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, timeoutMs: 600_000 }), true);
  });

  it("accepts a step's own maxTurns and a workflow-level one, bounded 1..100000", () => {
    assert.equal(
      Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, steps: [{ ...args.steps[0], maxTurns: 5 }] }),
      true
    );
    assert.equal(Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, maxTurns: 100_000 }), true);
    for (const maxTurns of [0, -1, 100_001, 2.5]) {
      assert.equal(
        Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, maxTurns }),
        false,
        `workflow maxTurns=${maxTurns} should fail`
      );
      assert.equal(
        Check(RUN_PI_MINION_WORKFLOW_PARAMETERS, { ...args, steps: [{ ...args.steps[0], maxTurns }] }),
        false,
        `step maxTurns=${maxTurns} should fail`
      );
    }
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

describe("parameter schema shape", () => {
  // Pins the exact property names and required lists so a schema edit that
  // renames a field, drops a required flag or adds an optional one fails.
  const keys = (schema: { properties: Record<string, unknown> }): string[] =>
    Object.keys(schema.properties).sort();
  const required = (schema: { required?: string[] }): string[] => [...(schema.required ?? [])].sort();

  it("pins the run schema properties and required fields", () => {
    assert.deepEqual(keys(RUN_PI_MINION_PARAMETERS), [
      "agent",
      "context",
      "effort",
      "maxBudgetUsd",
      "maxTurns",
      "model",
      "task",
      "timeoutMs"
    ]);
    // model/effort moved to optional so a named agent can supply them.
    assert.deepEqual(required(RUN_PI_MINION_PARAMETERS), ["context", "task"]);
  });

  it("pins the workflow schema properties and required fields", () => {
    assert.deepEqual(keys(RUN_PI_MINION_WORKFLOW_PARAMETERS), [
      "context",
      "maxBudgetUsd",
      "maxTurns",
      "steps",
      "timeoutMs",
      "title"
    ]);
    assert.deepEqual(required(RUN_PI_MINION_WORKFLOW_PARAMETERS), ["context", "steps", "title"]);
  });

  it("pins the workflow step properties and required fields", () => {
    const step = stepSchema();
    assert.deepEqual(keys(step), [
      "agent",
      "dependsOn",
      "effort",
      "id",
      "maxBudgetUsd",
      "maxTurns",
      "model",
      "task",
      "timeoutMs"
    ]);
    assert.deepEqual(required(step), ["id", "task"]);
  });

  it("pins the steer schema properties and required fields", () => {
    assert.deepEqual(keys(STEER_PI_MINION_PARAMETERS), ["deliverAs", "id", "message"]);
    assert.deepEqual(required(STEER_PI_MINION_PARAMETERS), ["id", "message"]);
  });

  it("pins the schedule schemas to the run/workflow fields plus cron", () => {
    assert.deepEqual(keys(SCHEDULE_PI_MINION_PARAMETERS), [
      "agent",
      "context",
      "cron",
      "effort",
      "maxBudgetUsd",
      "maxTurns",
      "model",
      "task",
      "timeoutMs"
    ]);
    assert.deepEqual(required(SCHEDULE_PI_MINION_PARAMETERS), ["context", "cron", "task"]);
    assert.deepEqual(keys(SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS), [
      "context",
      "cron",
      "maxBudgetUsd",
      "maxTurns",
      "steps",
      "timeoutMs",
      "title"
    ]);
    assert.deepEqual(required(SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS), ["context", "cron", "steps", "title"]);
  });
});

describe("schedule cap pinning", () => {
  const base = { task: "t", workspace: "/w", model: "haiku", effort: "low" };

  it("pins the config default at creation, so a later config edit cannot retarget the schedule", () => {
    // Regression (F5): the tick used to resolve `request.maxTurns ?? config`
    // against the config CURRENT at tick time.
    const pinned = pinScheduleRequest(base, { timeoutMs: 1_000, maxTurns: 3 });
    assert.equal(pinned.maxTurns, 3);
    assert.equal(pinned.timeoutMs, 1_000);
    // A running schedule's config was edited afterwards: the pinned cap wins.
    assert.equal(resolveMaxTurns(pinned, { maxTurns: 99 }), 3);
  });

  it("pins an explicit no-cap, so a schedule created unlimited stays unlimited", () => {
    const pinned = pinScheduleRequest(base, { timeoutMs: 1_000 });
    assert.equal(pinned.maxTurns, null);
    assert.equal(resolveMaxTurns(pinned, { maxTurns: 99 }), undefined);
  });

  it("keeps a request's own cap over the config default", () => {
    const pinned = pinScheduleRequest({ ...base, maxTurns: 2 }, { timeoutMs: 1_000, maxTurns: 3 });
    assert.equal(pinned.maxTurns, 2);
    assert.equal(resolveMaxTurns(pinned, { maxTurns: 99 }), 2);
  });
});

describe("agent param", () => {
  it("keeps the named agent on the captured schedule request, so every tick replays it", () => {
    const pinned = pinScheduleRequest(
      { task: "t", workspace: "/w", model: "haiku", effort: "low", agent: "code-reviewer" },
      { timeoutMs: 1_000, maxTurns: 3 }
    );
    assert.equal(pinned.agent, "code-reviewer");
  });

  it("adds one help note pointing a matching task at `agent` instead of model+effort", () => {
    const note = PI_MINION_USAGE_NOTES.find((line) => line.includes("pass `agent`"));
    assert.ok(note, "PI_MINION_USAGE_NOTES carries the agent usage note");
    assert.match(note!, /rather than picking model\+effort yourself/);
  });
});

describe("buildHelpAgentList", () => {
  it("lists agents from a populated dir and nothing from an empty one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-agents-"));
    try {
      assert.deepEqual(await buildHelpAgentList(dir), [], "an empty dir lists nothing");
      await writeFile(
        join(dir, "code-reviewer.md"),
        "---\ndescription: Reviews changes for correctness\n---\n\nYou review code.\n"
      );
      assert.deepEqual(await buildHelpAgentList(dir), [
        { name: "code-reviewer", description: "Reviews changes for correctness" }
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("registerTools prompt footprint", () => {
  // Minimal fake ExtensionAPI: registerTools() only calls pi.registerTool()
  // at registration time. Captured definitions are asserted below.
  const registered: ToolDefinition[] = [];
  registerTools({
    registerTool: (definition: ToolDefinition) => {
      registered.push(definition);
    }
  } as unknown as ExtensionAPI);

  const byName = new Map(registered.map((def) => [def.name, def]));
  const exposure = (name: string): string => byName.get(name)?.exposure ?? "direct";

  it("registers all 12 tools and no others", () => {
    assert.equal(registered.length, 12);
    assert.deepEqual(
      [...byName.keys()].sort(),
      [
        "cancel_pi_minion",
        "cancel_pi_minion_schedule",
        "cancel_pi_minion_workflow",
        "help_pi_minion",
        "list_pi_minion_schedules",
        "list_pi_minion_workflows",
        "list_pi_minions",
        "run_pi_minion",
        "run_pi_minion_workflow",
        "schedule_pi_minion",
        "schedule_pi_minion_workflow",
        "steer_pi_minion"
      ].sort()
    );
  });

  it("defers 11 tools and keeps help_pi_minion direct", () => {
    const deferred = [
      "cancel_pi_minion",
      "cancel_pi_minion_schedule",
      "cancel_pi_minion_workflow",
      "list_pi_minion_schedules",
      "list_pi_minion_workflows",
      "list_pi_minions",
      "run_pi_minion",
      "run_pi_minion_workflow",
      "schedule_pi_minion",
      "schedule_pi_minion_workflow",
      "steer_pi_minion"
    ];
    for (const name of deferred) assert.equal(exposure(name), "deferred", name);
    const help = registered.find((t: any) => t.name === "help_pi_minion");
    assert.ok(help, "help_pi_minion is registered");
    assert.notEqual(help.exposure, "deferred", "help_pi_minion should not be deferred");
  });

  it("keeps every tool description within 300 characters", () => {
    for (const def of registered) {
      assert.ok(
        def.description.length <= 300,
        `${def.name} description is ${def.description.length} chars (> 300): ${def.description}`
      );
    }
  });

  it("allows promptGuidelines up to 15 bullets", () => {
    for (const def of registered) {
      const guidelines = def.promptGuidelines ?? [];
      assert.ok(
        guidelines.length <= 15,
        `${def.name} has ${guidelines.length} promptGuidelines bullets (> 15)`
      );
    }
  });

  it("pins the exact promptGuidelines bullet count per tool", () => {
    const expected: Record<string, number> = {
      cancel_pi_minion: 1,
      cancel_pi_minion_schedule: 0,
      cancel_pi_minion_workflow: 0,
      help_pi_minion: 3,
      list_pi_minion_schedules: 0,
      list_pi_minion_workflows: 0,
      list_pi_minions: 0,
      run_pi_minion: 12,
      run_pi_minion_workflow: 11,
      schedule_pi_minion: 1,
      schedule_pi_minion_workflow: 1,
      steer_pi_minion: 1
    };
    for (const [name, count] of Object.entries(expected)) {
      const def = byName.get(name);
      assert.ok(def, `${name} is not registered`);
      assert.equal((def.promptGuidelines ?? []).length, count, `${name} promptGuidelines count`);
    }
  });

  it("steer_pi_minion validates args and reports a non-running job instead of throwing", async () => {
    const steer = byName.get("steer_pi_minion");
    assert.ok(steer, "steer_pi_minion is registered");
    const call = (message: string, id = "job-missing") =>
      steer.execute(
        "call-steer",
        { id, message },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "test-session" } } as unknown as ExtensionToolContext
      );
    const empty = await call("   ");
    assert.equal((empty.details as { delivered: boolean }).delivered, false);
    assert.match((empty.content[0] as { text: string }).text, /message is required/);
    const missing = await call("go left");
    assert.equal((missing.details as { delivered: boolean }).delivered, false);
    assert.match((missing.content[0] as { text: string }).text, /No running pi minion job job-missing/);
  });

  it("help payload carries the model routing table and the agents list", async () => {
    const help = byName.get("help_pi_minion");
    assert.ok(help, "help_pi_minion is not registered");
    // Pin a config-bound fake so ensureRegistry() no-ops inside execute():
    // no machine-CLI discovery (`which`/`fm models`) mid-test — same seam
    // job-runner tests use (see test/job-runner.test.ts).
    setAdaptersForTest([createFakeAdapter(fakeConfig())]);
    try {
      const result = await help.execute(
        "call-help",
        {},
        undefined,
        undefined,
        {} as ExtensionToolContext
      );
      const payload = result.details as {
        modelRouting?: string;
        agents?: Array<{ name: string; description: string }>;
        usageNotes?: string[];
      };
      assert.ok(Array.isArray(payload.agents), "payload.agents must be a list");
      assert.ok(
        payload.agents!.every((agent) => typeof agent.name === "string" && typeof agent.description === "string"),
        "every listed agent carries a name and description"
      );
      assert.ok(
        payload.usageNotes?.some((note) => note.includes("pass `agent`")),
        "payload.usageNotes carries the agent note"
      );
      assert.equal(typeof payload.modelRouting, "string", "payload.modelRouting must be a string");
      assert.ok(
        payload.modelRouting?.includes("**Model Routing:**"),
        "payload.modelRouting must contain the **Model Routing:** table"
      );
    } finally {
      setAdaptersForTest();
    }
  });

  it("schedule rows name the captured agent", async () => {
    const list = byName.get("list_pi_minion_schedules");
    assert.ok(list, "list_pi_minion_schedules is registered");
    const job = new Cron("0 9 * * *", () => {});
    schedules.set("s-agent", {
      title: "Nightly review",
      cron: "0 9 * * *",
      request: {
        task: "t",
        workspace: "/w",
        model: "haiku",
        effort: "low",
        agent: "code-reviewer"
      },
      effort: "low",
      cwd: "/w",
      sessionId: "test-session",
      job,
      runs: 0,
      skipped: 0
    });
    try {
      const result = await list.execute(
        "call-list",
        {},
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "test-session" } } as unknown as ExtensionToolContext
      );
      const rows = result.details as { schedules: Array<{ id: string; agent?: string }> };
      assert.equal(rows.schedules.find((row) => row.id === "s-agent")?.agent, "code-reviewer");
    } finally {
      schedules.delete("s-agent");
      job.stop();
    }
  });

  it("job rows expose the captured agent alongside the agent-led title", async () => {
    const list = byName.get("list_pi_minions");
    assert.ok(list, "list_pi_minions is registered");
    jobMeta.set("j-agent", {
      title: "reviewer: Review the diff",
      agent: "reviewer",
      model: "haiku",
      prompt: "Review the diff",
      workspace: "/w",
      sessionId: "test-session",
      status: "done"
    });
    try {
      const result = await list.execute(
        "call-list",
        {},
        undefined,
        undefined,
        { cwd: "/w", sessionManager: { getSessionId: () => "test-session" } } as unknown as ExtensionToolContext
      );
      const rows = result.details as { jobs: Array<{ id: string; title: string; agent?: string }> };
      const row = rows.jobs.find((job) => job.id === "j-agent");
      assert.equal(row?.agent, "reviewer");
      assert.equal(row?.title, "reviewer: Review the diff");
    } finally {
      jobMeta.delete("j-agent");
    }
  });

  it("keeps every tool description within 2 sentences", () => {
    for (const def of registered) {
      const sentences = def.description
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0);
      assert.ok(
        sentences.length <= 2,
        `${def.name} description has ${sentences.length} sentences (> 2): ${def.description}`
      );
    }
  });
});
