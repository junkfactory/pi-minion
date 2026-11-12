import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAdaptersForTest } from "../src/adapters/registry.js";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import { MINION_OPERATIONAL_TAIL, MINION_PROMPT_BASE } from "../src/adapters/util.js";
import { validateRequest } from "../src/job-runner.js";
import { createFakeAdapter, fakeConfig, fakeRequest } from "./fakes.js";

describe("validateRequest", () => {
  // Pin a config-bound fake so ensureRegistry no-ops: no machine-CLI discovery
  // mid-suite, and providersOfModel() can't depend on what's installed here.
  before(() => setAdaptersForTest([createFakeAdapter(fakeConfig())]));
  after(() => setAdaptersForTest());

  it("rejects a workspace that doesn't match cwd", async () => {
    await assert.rejects(
      validateRequest(fakeRequest({ workspace: "/tmp/a" }), "/tmp/b", fakeConfig()),
      /must be the current Pi workspace/
    );
  });

  it("rejects a workspace that isn't a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");
    try {
      await assert.rejects(validateRequest(fakeRequest({ workspace: file }), file, fakeConfig()), /not a directory/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a model-less request with no minion instructively", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, model: "" }), dir, fakeConfig()),
        /model is required unless `minion` supplies one/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a model outside models.allowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, model: "not-allowed" }), dir, fakeConfig()),
        /Model is not allowed/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a blocked model with the models.blocked message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(
          fakeRequest({ workspace: dir, model: "gemini-pro" }),
          dir,
          fakeConfig({ models: { blocked: ["gemini*"] } })
        ),
        /Model is blocked:/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("distinguishes an allowlist miss from a blocked model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(
          fakeRequest({ workspace: dir, model: "gemini-pro" }),
          dir,
          fakeConfig({ models: { allowed: ["sonnet"], blocked: [] } })
        ),
        /Model is not allowed:/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("allows any model when models.allowed is empty (allow-all default)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await validateRequest(
        fakeRequest({ workspace: dir, model: "any-catalog-id" }),
        dir,
        fakeConfig({ models: { allowed: [] } })
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a non-positive maxBudgetUsd override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, maxBudgetUsd: 0 }), dir, fakeConfig()),
        /maxBudgetUsd must be a positive number/
      );
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, maxBudgetUsd: -5 }), dir, fakeConfig()),
        /maxBudgetUsd must be a positive number/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects an empty task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, task: "   " }), dir, fakeConfig()),
        /task is required/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a missing effort with a hint that tells the minion how to pick one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, effort: undefined }), dir, fakeConfig()),
        /effort is required.*low.*medium.*high/s
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("resolves the workspace to an absolute path on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(fakeRequest({ workspace: dir }), dir, fakeConfig());
      assert.equal(result.workspace, dir);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects context that combines the \"no prior context\" escape hatch with other details", async () => {
    // Regression: an orchestrator once submitted a follow-up job whose
    // context opened with "No prior context for this run, but this is a
    // follow-up to..." — self-contradictory, and a sign the real context was
    // reconstructed from memory rather than restated from the prior job.
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(
          fakeRequest({
            workspace: dir,
            context:
              "No prior context for this run, but this is a follow-up to a previous read-only Sonnet review of Nomad MR !133."
          }),
          dir,
          fakeConfig()
        ),
        /combines "no prior context" with other details/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("accepts the bare \"No prior context.\" escape hatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(
        fakeRequest({ workspace: dir, context: "No prior context." }),
        dir,
        fakeConfig()
      );
      assert.equal(result.context, "No prior context.");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("accepts genuine follow-up context that doesn't use the escape-hatch phrase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(
        fakeRequest({
          workspace: dir,
          context: "Prior review of MR !133 found no issues; verify the Cognito teardown fix landed at HEAD."
        }),
        dir,
        fakeConfig()
      );
      assert.match(result.context ?? "", /Cognito teardown/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("validateRequest minion requests", () => {
  before(() => setAdaptersForTest([createFakeAdapter(fakeConfig())]));
  after(() => setAdaptersForTest());

  const BODY = "You are a code review specialist. Find real bugs, not style nits.";
  const minionFile = (frontmatter: string, body = BODY) => `---\n${frontmatter}\n---\n\n${body}\n`;

  // One temp root per test: `<root>/minions` is the minion dir, and `<root>`
  // itself is the workspace (validateRequest requires workspace === cwd).
  async function withMinionDir(
    files: Record<string, string>,
    run: (dirs: { workspace: string; minions: string }) => Promise<void>
  ): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const minions = join(workspace, "minions");
      await mkdir(minions);
      for (const [name, raw] of Object.entries(files)) await writeFile(join(minions, name), raw);
      await run({ workspace, minions });
    } finally {
      await rm(workspace, { recursive: true });
    }
  }

  it("lets explicit request values beat frontmatter defaults", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Reviews changes\nmodel: opus\neffort: high") },
      async ({ workspace, minions }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, minion: "reviewer", model: "sonnet", effort: "medium" }),
          workspace,
          fakeConfig(),
          minions
        );
        assert.equal(result.model, "sonnet");
        assert.equal(result.effort, "medium");
      }
    );
  });

  it("fills the gaps the request leaves from frontmatter, ahead of config defaults", async () => {
    await withMinionDir(
      {
        "reviewer.md": minionFile(
          "description: Reviews changes\nmodel: opus\neffort: high\nmaxTurns: 5\nmaxBudgetUsd: 2\ntimeoutMs: 60000"
        )
      },
      async ({ workspace, minions }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, minion: "reviewer", model: "", effort: "" }),
          workspace,
          fakeConfig({ maxTurns: 400 }),
          minions
        );
        assert.equal(result.minion, "reviewer");
        assert.equal(result.model, "opus");
        assert.equal(result.effort, "high");
        assert.equal(result.maxTurns, 5); // frontmatter beats config.maxTurns 400
        assert.equal(result.maxBudgetUsd, 2);
        assert.equal(result.timeoutMs, 60_000);
      }
    );
  });

  it("keeps a pinned no-cap maxTurns over the minion's default", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Reviews changes\nmodel: opus\nmaxTurns: 5") },
      async ({ workspace, minions }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, minion: "reviewer", model: "" , effort: "medium", maxTurns: null }),
          workspace,
          fakeConfig(),
          minions
        );
        assert.equal(result.maxTurns, null);
      }
    );
  });

  it("composes the minion body with the operational tail, without the generic identity line", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Reviews changes\nmodel: sonnet") },
      async ({ workspace, minions }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, minion: "reviewer", effort: "medium" }),
          workspace,
          fakeConfig(),
          minions
        );
        assert.equal(result.systemPrompt, `${BODY}\n\n${MINION_OPERATIONAL_TAIL}`);
        assert.ok(result.systemPrompt.startsWith(BODY));
        assert.ok(!result.systemPrompt.includes("You are an independent pi minion"));
        // The tail is exactly the shared prompt minus that identity line.
        assert.ok(MINION_PROMPT_BASE.endsWith(MINION_OPERATIONAL_TAIL));
      }
    );
  });

  it("names the minion when the merged model is empty", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Prompt-only minion") },
      async ({ workspace, minions }) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, minion: "reviewer", model: "" }),
            workspace,
            fakeConfig(),
            minions
          ),
          /minion 'reviewer' defines no model — pass `model` explicitly/
        );
      }
    );
  });

  it("names the minion when the merged effort is empty", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Reviews changes\nmodel: sonnet") },
      async ({ workspace, minions }) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, minion: "reviewer", effort: "" }),
            workspace,
            fakeConfig(),
            minions
          ),
          /minion 'reviewer' defines no effort/
        );
      }
    );
  });

  it("rejects an unknown minion with the available names", async () => {
    await withMinionDir(
      {
        "reviewer.md": minionFile("description: Reviews changes\nmodel: sonnet"),
        "researcher.md": minionFile("description: Researches\nmodel: sonnet")
      },
      async ({ workspace, minions }) => {
        await assert.rejects(
          validateRequest(fakeRequest({ workspace, minion: "nope" }), workspace, fakeConfig(), minions),
          /Unknown minion "nope"\. Available minions: researcher, reviewer\./
        );
      }
    );
  });

  it("treats a blank minion as absent", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Reviews changes\nmodel: opus") },
      async ({ workspace, minions }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, minion: "   " }),
          workspace,
          fakeConfig(),
          minions
        );
        assert.equal(result.minion, undefined);
        assert.equal(result.systemPrompt, undefined);
        assert.equal(result.allowedTools, undefined);
        assert.equal(result.model, "sonnet");
      }
    );
  });

  it("narrows frontmatter tools to config.allowedTools", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Reviews changes\ntools: [Bash, Grep, Read]") },
      async ({ workspace, minions }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, minion: "reviewer" }),
          workspace,
          fakeConfig({ allowedTools: ["Bash", "Read"] }),
          minions
        );
        assert.deepEqual(result.allowedTools, ["Bash", "Read"]);
      }
    );
  });

  it("rejects frontmatter tools that config.allowedTools leaves empty", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Reviews changes\ntools: [Grep]") },
      async ({ workspace, minions }) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, minion: "reviewer" }),
            workspace,
            fakeConfig({ allowedTools: ["Read"] }),
            minions
          ),
          /none of which config.allowedTools permits/
        );
      }
    );
  });

  it("rejects an minion that lists no tools at all", async () => {
    await withMinionDir(
      { "reviewer.md": minionFile("description: Reviews changes\ntools: []") },
      async ({ workspace, minions }) => {
        await assert.rejects(
          validateRequest(fakeRequest({ workspace, minion: "reviewer" }), workspace, fakeConfig(), minions),
          /lists no tools/
        );
      }
    );
  });

  it("keeps the minion's own tools when config.allowedTools pins nothing, and inherits config when the minion omits tools", async () => {
    await withMinionDir(
      {
        "scoped.md": minionFile("description: Scoped\ntools: [Bash, Grep]"),
        "plain.md": minionFile("description: Plain")
      },
      async ({ workspace, minions }) => {
        const scoped = await validateRequest(
          fakeRequest({ workspace, minion: "scoped" }),
          workspace,
          fakeConfig({ allowedTools: [] }),
          minions
        );
        assert.deepEqual(scoped.allowedTools, ["Bash", "Grep"]);
        const plain = await validateRequest(
          fakeRequest({ workspace, minion: "plain" }),
          workspace,
          fakeConfig({ allowedTools: ["Bash"] }),
          minions
        );
        assert.equal(plain.allowedTools, undefined);
      }
    );
  });

  // Tools narrowing is claude-only: the fake adapter's command is not
  // "claude", so a request it owns (fake-model) must skip narrowing and log.
  it("ignores frontmatter tools for a known non-claude adapter and logs why", async () => {
    // Re-pin the fake bound to a config that owns fake-model, so resolution
    // lands on a KNOWN non-claude adapter rather than the conservative
    // unknown-model path.
    setAdaptersForTest([
      createFakeAdapter(fakeConfig({ models: { allowed: ["fake-model"], blocked: [] } }))
    ]);
    try {
      await withMinionDir(
        {
          "reviewer.md": minionFile(
            "description: Reviews changes\nmodel: fake-model\ntools: [bash, read]"
          )
        },
        async ({ workspace, minions }) => {
          const logs: Array<{ event: string; id: string; model: string; detail?: string }> = [];
          const result = await validateRequest(
            fakeRequest({ workspace, minion: "reviewer", model: "" }),
            workspace,
            fakeConfig({
              models: { allowed: ["fake-model"], blocked: [] },
              allowedTools: ["Bash", "Read"]
            }),
            minions,
            (event, info) => logs.push({ event, ...info })
          );
          assert.equal(result.allowedTools, undefined);
          assert.equal(logs.length, 1);
          assert.equal(logs[0].event, "minion_tools_ignored");
          assert.equal(logs[0].id, "reviewer");
          assert.match(logs[0].detail ?? "", /minion=reviewer/);
          assert.match(logs[0].detail ?? "", /adapter=fake-cli/);
          assert.match(logs[0].detail ?? "", /claude only/);
        }
      );
    } finally {
      setAdaptersForTest([createFakeAdapter(fakeConfig())]);
    }
  });

  // The claude path is unchanged: with a real claude adapter pinned, sonnet
  // resolves to it, so narrowing (and its empty-intersection reject) still runs.
  describe("claude adapter", () => {
    before(() =>
      setAdaptersForTest([createFakeAdapter(fakeConfig()), createClaudeAdapter(fakeConfig())])
    );
    after(() => setAdaptersForTest([createFakeAdapter(fakeConfig())]));

    it("still narrows frontmatter tools to config.allowedTools", async () => {
      await withMinionDir(
        { "reviewer.md": minionFile("description: Reviews changes\nmodel: sonnet\ntools: [Bash, Grep, Read]") },
        async ({ workspace, minions }) => {
          const logs: Array<{ event: string }> = [];
          const result = await validateRequest(
            fakeRequest({ workspace, minion: "reviewer" }),
            workspace,
            fakeConfig({ allowedTools: ["Bash", "Read"] }),
            minions,
            (event) => logs.push({ event })
          );
          assert.deepEqual(result.allowedTools, ["Bash", "Read"]);
          assert.equal(logs.length, 0);
        }
      );
    });

    it("still rejects an empty intersection", async () => {
      await withMinionDir(
        { "locked.md": minionFile("description: Locked\nmodel: sonnet\ntools: [WebFetch]") },
        async ({ workspace, minions }) => {
          await assert.rejects(
            validateRequest(
              fakeRequest({ workspace, minion: "locked" }),
              workspace,
              fakeConfig({ allowedTools: ["Read"] }),
              minions
            ),
            /none of which config\.allowedTools permits/
          );
        }
      );
    });
  });

  it("gates the merged model: frontmatter cannot launder a blocked or unlisted model", async () => {
    await withMinionDir(
      {
        "blocked.md": minionFile("description: Blocked model\nmodel: opus"),
        "unlisted.md": minionFile("description: Unlisted model\nmodel: other-model"),
        "fake.md": minionFile("description: Fake provider model\nmodel: fake-model")
      },
      async ({ workspace, minions }) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, minion: "blocked", model: "" }),
            workspace,
            fakeConfig({ models: { allowed: [], blocked: ["opus"] } }),
            minions
          ),
          /Model is blocked: opus/
        );
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, minion: "unlisted", model: "" }),
            workspace,
            fakeConfig(),
            minions
          ),
          /Model is not allowed: other-model/
        );
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, minion: "fake", model: "" }),
            workspace,
            fakeConfig({ providers: { allowed: [], blocked: ["fakeprovider"] } }),
            minions
          ),
          /excluded by the providers config/
        );
      }
    );
  });
});
