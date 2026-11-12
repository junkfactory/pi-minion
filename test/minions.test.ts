import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setAdaptersForTest } from "../src/adapters/registry.js";
import { buildArgs, createClaudeAdapter } from "../src/adapters/claude.js";
import { MINION_OPERATIONAL_TAIL, MINION_PROMPT_BASE } from "../src/adapters/util.js";
import {
  MINION_DIR,
  listMinions,
  resolveMinion,
  type MinionLog
} from "../src/minions.js";
import { validateRequest } from "../src/job-runner.js";
import { pinScheduleRequest } from "../src/tools.js";
import { createFakeAdapter, fakeConfig, fakeRequest } from "./fakes.js";

type Logged = { event: string; id: string; model: string; detail?: string };

// Each case gets its own temp dir standing in for MINION_DIR plus a collecting
// logger, so nothing touches the user's real minion files or log.
async function withMinions(
  files: Record<string, string>,
  run: (dir: string, logs: Logged[], log: MinionLog) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-minion-minions-"));
  const logs: Logged[] = [];
  const log: MinionLog = (event, info) => logs.push({ event, ...info });
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, "utf8");
    }
    await run(dir, logs, log);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REVIEW = `---
description: Reviews changes for correctness and security
model: qwen-flash
effort: high
tools: [Bash, Glob, Grep]
maxTurns: 100
maxBudgetUsd: 2
timeoutMs: 600000
reviewed: true
---
You are a code review specialist.
Report findings as a list.
`;

const MINIMAL = `---
description: Prompt-only minion
---
Do the thing.
`;

describe("MINION_DIR", () => {
  it("points at the pi-minion minion directory under the user's pi home", () => {
    assert.equal(MINION_DIR, join(homedir(), ".pi", "agent", "pi-minion", "minions"));
  });
});

describe("listMinions", () => {
  it("returns name, description, model and effort, sorted, for valid .md files", async () => {
    await withMinions({ "zebra.md": MINIMAL, "review.md": REVIEW }, async (dir, _logs, log) => {
      assert.deepEqual(await listMinions(dir, log), [
        {
          name: "review",
          description: "Reviews changes for correctness and security",
          model: "qwen-flash",
          effort: "high"
        },
        { name: "zebra", description: "Prompt-only minion", model: null, effort: null }
      ]);
    });
  });

  it("surfaces model and effort from frontmatter", async () => {
    const content = `---
description: Sonnet minion
model: sonnet
effort: high
---
body
`;
    await withMinions({ "sonnet.md": content }, async (dir, _logs, log) => {
      assert.deepEqual(await listMinions(dir, log), [
        { name: "sonnet", description: "Sonnet minion", model: "sonnet", effort: "high" }
      ]);
    });
  });

  it("returns an empty list (no error) when the directory is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-minions-"));
    try {
      assert.deepEqual(await listMinions(join(dir, "missing")), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rescans on every call — a new file is picked up with no cache", async () => {
    await withMinions({}, async (dir, _logs, log) => {
      assert.deepEqual(await listMinions(dir, log), []);
      await writeFile(join(dir, "fresh.md"), MINIMAL, "utf8");
      assert.deepEqual(await listMinions(dir, log), [
        { name: "fresh", description: "Prompt-only minion", model: null, effort: null }
      ]);
    });
  });

  it("skips and warns a non-.md file", async () => {
    await withMinions({ "README.md.bak": REVIEW, "notes.txt": MINIMAL }, async (dir, logs, log) => {
      assert.deepEqual(await listMinions(dir, log), []);
      assert.equal(logs.length, 2);
      assert.equal(logs[0].event, "minion_invalid");
      assert.equal(logs[0].id, "README.md.bak");
      assert.match(logs[0].detail ?? "", /\.md/);
      assert.equal(logs[1].id, "notes.txt");
    });
  });

  it("skips dotfiles silently — editor swap files are not minion mistakes", async () => {
    await withMinions(
      { ".notes.md.swp": REVIEW, ".gitkeep": "", "fresh.md": MINIMAL },
      async (dir, logs, log) => {
        assert.deepEqual(await listMinions(dir, log), [
          { name: "fresh", description: "Prompt-only minion", model: null, effort: null }
        ]);
        assert.equal(logs.length, 0);
      }
    );
  });

  it("skips and warns a non-kebab-case file name", async () => {
    await withMinions({ "Bad_Name.md": REVIEW }, async (dir, logs, log) => {
      assert.deepEqual(await listMinions(dir, log), []);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].event, "minion_invalid");
      assert.equal(logs[0].id, "Bad_Name.md");
      assert.match(logs[0].detail ?? "", /kebab-case/);
    });
  });
});

describe("resolveMinion", () => {
  it("resolves a fully specified file with every optional field typed", async () => {
    await withMinions({ "review.md": REVIEW }, async (dir, _logs, log) => {
      assert.deepEqual(await resolveMinion("review", dir, log), {
        name: "review",
        description: "Reviews changes for correctness and security",
        model: "qwen-flash",
        effort: "high",
        tools: ["Bash", "Glob", "Grep"],
        maxTurns: 100,
        maxBudgetUsd: 2,
        timeoutMs: 600000,
        body: "You are a code review specialist.\nReport findings as a list."
      });
    });
  });

  it("leaves absent optional fields undefined and accepts a body-only prompt", async () => {
    await withMinions({ "minimal.md": MINIMAL }, async (dir, _logs, log) => {
      const minion = await resolveMinion("minimal", dir, log);
      assert.deepEqual(minion, {
        name: "minimal",
        description: "Prompt-only minion",
        model: undefined,
        effort: undefined,
        tools: undefined,
        maxTurns: undefined,
        maxBudgetUsd: undefined,
        timeoutMs: undefined,
        body: "Do the thing."
      });
    });
  });

  it("normalizes a comma-separated tools string to a trimmed string array", async () => {
    await withMinions(
      { "t.md": "---\ndescription: d\ntools: Bash, Glob ,  Grep\n---\nbody\n" },
      async (dir, _logs, log) => {
        assert.deepEqual((await resolveMinion("t", dir, log)).tools, ["Bash", "Glob", "Grep"]);
      }
    );
  });

  it("throws with the available names for an unknown minion", async () => {
    await withMinions({ "alpha.md": MINIMAL, "beta.md": MINIMAL }, async (dir, _logs, log) => {
      await assert.rejects(resolveMinion("gamma", dir, log), (error: Error) => {
        assert.match(error.message, /Unknown minion "gamma"/);
        assert.match(error.message, /Available minions: alpha, beta\./);
        assert.match(error.message, /help_pi_minion/);
        return true;
      });
    });
  });

  it("treats an invalid file as unknown while still logging why it was skipped", async () => {
    await withMinions(
      { "good.md": MINIMAL, "broken.md": "---\nmodel: x\n---\nbody\n" },
      async (dir, logs, log) => {
        await assert.rejects(resolveMinion("broken", dir, log), /Unknown minion "broken"/);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].event, "minion_invalid");
        assert.equal(logs[0].id, "broken.md");
        assert.match(logs[0].detail ?? "", /description/);
      }
    );
  });

  it("reports no-available-minions when the directory is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-minions-"));
    try {
      await assert.rejects(resolveMinion("x", join(dir, "missing")), (error: Error) => {
        assert.match(error.message, /Unknown minion "x"/);
        assert.match(error.message, /No minion files are defined/);
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// End to end: a written minion file is resolved by the real request validator
// and lands in a real adapter's argv — the seams steps 1-4 built, exercised
// together rather than one unit at a time.
describe("minion flow (end to end)", () => {
  const BODY = "You are a code review specialist.\nReport real bugs, not style nits.";
  const FILE = `---
description: Reviews changes for correctness and security
model: sonnet
effort: high
tools: [Bash, Read]
---
${BODY}
`;
  // config.allowedTools is deliberately wider than the minion's list, so the
  // argv assertion proves the narrowing happened.
  const config = fakeConfig({ allowedTools: ["Bash", "Read", "Grep"] });

  // A non-claude model: only claude consumes `tools`, so this path is where
  // the ignored-tools log line (and its dedupe) is observable.
  const fakeModelConfig = fakeConfig({
    models: { allowed: ["sonnet", "opus", "fake-model"], blocked: [] },
    allowedTools: ["Bash", "Read", "Grep"]
  });
  const NON_CLAUDE = `---
description: Runs on a non-claude adapter
model: fake-model
effort: high
tools: [Bash]
---
${BODY}
`;

  // Pin a fake adapter so ensureRegistry never discovers the machine's CLIs.
  // Its config owns fake-model too, so the non-claude path resolves; the real
  // claude adapter owns sonnet, so the argv/narrowing path resolves too.
  before(() => setAdaptersForTest([createFakeAdapter(fakeModelConfig), createClaudeAdapter(fakeModelConfig)]));
  after(() => setAdaptersForTest());

  // The temp dir doubles as the workspace: validateRequest requires
  // workspace === cwd, and the minion dir is injected positionally.
  it("turns a file into a validated request whose argv carries its model, prompt, and tools", async () => {
    await withMinions({ "code-review.md": FILE }, async (dir) => {
      const request = await validateRequest(
        fakeRequest({ workspace: dir, minion: "code-review", model: "", effort: "" }),
        dir,
        config,
        dir
      );
      const args = buildArgs(request, config);
      assert.equal(args[args.indexOf("--model") + 1], "sonnet");
      assert.equal(args[args.indexOf("--effort") + 1], "high");
      assert.equal(
        args[args.indexOf("--append-system-prompt") + 1],
        `${BODY}\n\n${MINION_OPERATIONAL_TAIL}`
      );
      assert.deepEqual(
        args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 3),
        ["--allowedTools", "Bash", "Read"]
      );
      assert.ok(!args.includes(MINION_PROMPT_BASE), "the generic prompt is replaced, not appended");
    });
  });

  it("replays a captured schedule request through the tick's re-validation", async () => {
    await withMinions({ "code-review.md": FILE }, async (dir) => {
      // The handler stores the merged request for display/logs and the raw
      // pre-merge one for ticks (tools.ts schedules.set): the raw capture is
      // what makes frontmatter model/effort/limit edits reach the next run.
      const raw = fakeRequest({ workspace: dir, minion: "code-review", model: "", effort: "" });
      const captured = pinScheduleRequest(
        await validateRequest(raw, dir, config, dir),
        { timeoutMs: 60_000, maxTurns: 3 }
      );
      assert.equal(captured.minion, "code-review");
      // Ticks replay the raw request (startJob re-validates it), so a file
      // edit between ticks — prompt, model, or limits — reaches the next run.
      await writeFile(
        join(dir, "code-review.md"),
        FILE.replace("Report real bugs", "Report only real bugs").replace("model: sonnet", "model: opus")
      );
      const tick = await validateRequest({ ...raw, task: `${raw.task}\n\nreplayed` }, dir, config, dir);
      assert.equal(tick.minion, "code-review");
      assert.equal(tick.model, "opus");
      assert.match(tick.systemPrompt ?? "", /Report only real bugs/);
      assert.ok(tick.systemPrompt?.endsWith(MINION_OPERATIONAL_TAIL));
      assert.equal(buildArgs(tick, config)[buildArgs(tick, config).indexOf("--model") + 1], "opus");
    });
  });

  it("applies the minion once per run, so a re-validated merged request logs minion_tools_ignored only once", async () => {
    await withMinions({ "fake-tools.md": NON_CLAUDE }, async (dir, logs, log) => {
      const raw = fakeRequest({ workspace: dir, minion: "fake-tools", model: "", effort: "" });
      const merged = await validateRequest(raw, dir, fakeModelConfig, dir, log);
      assert.deepEqual(
        logs.map((entry) => entry.event),
        ["minion_tools_ignored"]
      );
      // run_pi_minion validates first, then hands the merged request to
      // startJob, which re-validates: that second pass must not merge again.
      const again = await validateRequest(merged, dir, fakeModelConfig, dir, log);
      assert.equal(logs.length, 1);
      assert.equal(again.minion, "fake-tools");
      assert.equal(again.model, "fake-model");
      assert.equal(again.systemPrompt, merged.systemPrompt);
    });
  });

  it("reports an invalid minion file through the injected log seam, not the real log", async () => {
    await withMinions(
      { "broken.md": "---\nmodel: sonnet\n---\nbody\n" },
      async (dir, logs, log) => {
        await assert.rejects(
          validateRequest(fakeRequest({ workspace: dir, minion: "broken" }), dir, config, dir, log),
          /Unknown minion "broken"/
        );
        assert.equal(logs.length, 1);
        assert.equal(logs[0].event, "minion_invalid");
        assert.equal(logs[0].id, "broken.md");
      }
    );
  });

  it("fails instructively when the minion defines no model and the caller names none", async () => {
    await withMinions({ "prompt-only.md": MINIMAL }, async (dir) => {
      await assert.rejects(
        validateRequest(
          fakeRequest({ workspace: dir, minion: "prompt-only", model: "" }),
          dir,
          config,
          dir
        ),
        /minion 'prompt-only' defines no model — classify the task against help_pi_minion's `modelRouting` table and pass `model` explicitly\. Confirm the resolved id appears in help_pi_minion's `models` list\./
      );
    });
  });

  it("rejects an minion whose tools intersect config.allowedTools to nothing", async () => {
    await withMinions(
      { "locked.md": "---\ndescription: Locked down\nmodel: sonnet\ntools: [WebFetch]\n---\nbody\n" },
      async (dir) => {
        await assert.rejects(
          validateRequest(fakeRequest({ workspace: dir, minion: "locked" }), dir, config, dir),
          /none of which config\.allowedTools permits/
        );
      }
    );
  });

  it("lets the model gate win over a tools error for a blocked model", async () => {
    // Narrowing runs after the model gates, so a gated model fails with the
    // model error even when its tools list would also have failed.
    const blockedConfig = fakeConfig({
      models: { allowed: [], blocked: ["ghost*"] },
      allowedTools: ["Bash", "Read", "Grep"]
    });
    await withMinions(
      { "locked.md": "---\ndescription: Locked down\nmodel: ghost\ntools: [WebFetch]\n---\nbody\n" },
      async (dir) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace: dir, minion: "locked", model: "" }),
            dir,
            blockedConfig,
            dir
          ),
          /Model is blocked: ghost/
        );
      }
    );
  });
});

describe("invalid minion files", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["missing description", "---\nmodel: sonnet\n---\nbody\n", /description/],
    ["blank description", "---\ndescription: '   '\n---\nbody\n", /description/],
    ["non-string description", "---\ndescription: 42\n---\nbody\n", /description/],
    ["empty body", "---\ndescription: d\n---\n\n   \n", /empty body/],
    ["missing frontmatter", "# Just notes\n", /frontmatter/],
    ["non-mapping frontmatter", "---\n- a\n- b\n---\nbody\n", /mapping/],
    ["malformed YAML", "---\ndescription: [unclosed\n---\nbody\n", /YAML/],
    ["numeric model", "---\ndescription: d\nmodel: 5\n---\nbody\n", /model/],
    ["blank effort", "---\ndescription: d\neffort: ''\n---\nbody\n", /effort/],
    ["tools with a non-string entry", "---\ndescription: d\ntools: [Bash, 5]\n---\nbody\n", /tools/],
    ["fractional maxTurns", "---\ndescription: d\nmaxTurns: 2.5\n---\nbody\n", /maxTurns/],
    ["maxTurns above the cap", "---\ndescription: d\nmaxTurns: 100001\n---\nbody\n", /maxTurns/],
    ["non-positive maxBudgetUsd", "---\ndescription: d\nmaxBudgetUsd: 0\n---\nbody\n", /maxBudgetUsd/],
    ["string maxBudgetUsd", "---\ndescription: d\nmaxBudgetUsd: '2'\n---\nbody\n", /maxBudgetUsd/],
    ["timeoutMs above Node's setTimeout limit", "---\ndescription: d\ntimeoutMs: 2147483648\n---\nbody\n", /timeoutMs/],
    ["negative timeoutMs", "---\ndescription: d\ntimeoutMs: -1\n---\nbody\n", /timeoutMs/]
  ];

  for (const [label, content, reason] of cases) {
    it(`skips and warns: ${label}`, async () => {
      await withMinions({ "minion.md": content }, async (dir, logs, log) => {
        assert.deepEqual(await listMinions(dir, log), []);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].event, "minion_invalid");
        assert.equal(logs[0].id, "minion.md");
        assert.match(logs[0].detail ?? "", reason);
      });
    });
  }
});
