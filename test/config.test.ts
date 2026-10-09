import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MinionConfig } from "../src/adapters/types.js";
import {
  applyConfigOverride,
  isModelAllowed,
  isModelBlocked,
  isProviderAllowed,
  isProviderBlocked,
  loadConfig,
  readShortcutConfigSync,
  resolveShortcut,
  USER_CONFIG_PATH
} from "../src/config.js";
import { fakeConfig } from "./fakes.js";

describe("loadConfig", () => {
  it("resolves pi-minion.json at the package root, not a hardcoded homedir path", async () => {
    // Regression test: CONFIG_PATH used to be hardcoded to
    // ~/.pi/agent/extensions/pi-minion.json, which broke once the
    // extension moved to the extensions/pi-minion/index.ts subdirectory
    // convention (the config lives at the package root, one level above src/).
    // That same path is now reused as the optional user-override path
    // (see the "user override" describe block below) — pass an explicit,
    // guaranteed-nonexistent override path here so this test stays
    // hermetic regardless of whether the real override file exists.
    const config = await loadConfig(join(tmpdir(), "pi-minion-test-no-override.json"));
    assert.deepEqual(config.models, { allowed: [], blocked: [] });
    assert.equal(config.maxOutputBytes, 15_000_000);
    assert.equal(config.maxResultPreviewBytes, 50_000);
    assert.equal(config.maxResultContextBytes, 4_000);
    assert.equal(config.shortcut, "alt+j");
  });

  it("merges a real user-override file on disk over the built-in config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ maxBudgetUsd: 1 }), "utf8");
      const config = await loadConfig(overridePath);
      assert.equal(config.maxBudgetUsd, 1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when a merged override gives models.allowed the wrong type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ models: { allowed: "oops" } }), "utf8");
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when a merged override gives models.blocked the wrong type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ models: { blocked: "oops" } }), "utf8");
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("passes adapterArgs through the merge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(
        overridePath,
        JSON.stringify({ adapterArgs: { pi: ["--flag", "val"] } }),
        "utf8"
      );
      const config = await loadConfig(overridePath);
      assert.deepEqual(config.adapterArgs, { pi: { args: ["--flag", "val"], preExec: [] } });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("normalizes an adapterArgs object entry with only preExec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(
        overridePath,
        JSON.stringify({ adapterArgs: { pi: { preExec: ["env", "-u", "AWS_PROFILE"] } } }),
        "utf8"
      );
      const config = await loadConfig(overridePath);
      assert.deepEqual(config.adapterArgs, {
        pi: { args: [], preExec: ["env", "-u", "AWS_PROFILE"] }
      });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when an adapterArgs object entry has non-string args", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(
        overridePath,
        JSON.stringify({ adapterArgs: { pi: { args: [3] } } }),
        "utf8"
      );
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration \(after merging/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when an adapterArgs object entry has non-string preExec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(
        overridePath,
        JSON.stringify({ adapterArgs: { pi: { preExec: ["ok", 3] } } }),
        "utf8"
      );
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration \(after merging/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when adapterArgs is not an object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ adapterArgs: "oops" }), "utf8");
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when an adapterArgs value is not an array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(
        overridePath,
        JSON.stringify({ adapterArgs: { pi: "--flag" } }),
        "utf8"
      );
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when an adapterArgs item is not a string", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(
        overridePath,
        JSON.stringify({ adapterArgs: { pi: ["--flag", 3] } }),
        "utf8"
      );
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("ignores a leftover defaultEffort key from older override files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ defaultEffort: "medium" }), "utf8");
      const config = await loadConfig(overridePath);
      assert.deepEqual(config.models, { allowed: [], blocked: [] });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("ignores legacy allowedModels/blockedModels keys from older override files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ allowedModels: ["sonnet"], blockedModels: ["gemini*"] }), "utf8");
      const config = await loadConfig(overridePath);
      assert.deepEqual(config.models, { allowed: [], blocked: [] });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("passes a valid providers override through the merge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(
        overridePath,
        JSON.stringify({ providers: { blocked: ["antigravity"] } }),
        "utf8"
      );
      const config = await loadConfig(overridePath);
      assert.deepEqual(config.providers, { blocked: ["antigravity"] });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when providers is not an object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ providers: [] }), "utf8");
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when a providers side is not a string array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ providers: { allowed: "x" } }), "utf8");
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("isModelAllowed / isModelBlocked", () => {
  it("treats an empty models.blocked as nothing blocked", () => {
    const config = fakeConfig({ models: { allowed: ["sonnet"], blocked: [] } });
    assert.equal(isModelAllowed(config, "sonnet"), true);
    assert.equal(isModelAllowed(config, "haiku"), false);
    assert.equal(isModelBlocked(config, "haiku"), false);
  });

  it("blocks every id matching a trailing-'*' prefix pattern", () => {
    const config = fakeConfig({ models: { allowed: [], blocked: ["gemini*"] } });
    for (const model of ["gemini-flash", "gemini-pro", "gemini-3.1-pro"]) {
      assert.equal(isModelBlocked(config, model), true, `${model} not blocked`);
      assert.equal(isModelAllowed(config, model), false, `${model} not blocked`);
    }
    assert.equal(isModelAllowed(config, "sonnet"), true);
  });

  it("allows every id matching a trailing-'*' prefix pattern in models.allowed", () => {
    const config = fakeConfig({ models: { allowed: ["gemini*"], blocked: [] } });
    for (const model of ["gemini-flash", "gemini-pro", "gemini-3.1-pro"]) {
      assert.equal(isModelAllowed(config, model), true, `${model} not allowed`);
    }
    assert.equal(isModelAllowed(config, "sonnet"), false);
  });

  it("lets models.blocked win over models.allowed (precedence)", () => {
    const config = fakeConfig({ models: { allowed: ["gemini-flash"], blocked: ["gemini*"] } });
    assert.equal(isModelBlocked(config, "gemini-flash"), true);
    assert.equal(isModelAllowed(config, "gemini-flash"), false);
  });

  it("matches a pattern without '*' exactly, not as a prefix", () => {
    const config = fakeConfig({ models: { allowed: [], blocked: ["kimi-k3"] } });
    assert.equal(isModelBlocked(config, "kimi-k3"), true);
    assert.equal(isModelBlocked(config, "kimi-k3-flash"), false);
    assert.equal(isModelAllowed(config, "kimi-k3-flash"), true);
  });

  it("reports nothing blocked when models.blocked is absent", () => {
    assert.equal(isModelBlocked({}, "sonnet"), false);
    assert.equal(isModelAllowed({ models: {} }, "sonnet"), true);
  });
});

describe("isProviderAllowed / isProviderBlocked", () => {
  it("allows everything when providers is absent", () => {
    const config = fakeConfig();
    assert.equal(isProviderAllowed(config, "any"), true);
    assert.equal(isProviderBlocked(config, "any"), false);
  });

  it("lets blockedProviders win over allowedProviders (precedence)", () => {
    const config = fakeConfig({ providers: { allowed: ["opencode-go", "deepseek"], blocked: ["deepseek"] } });
    assert.equal(isProviderAllowed(config, "opencode-go"), true);
    assert.equal(isProviderAllowed(config, "deepseek"), false);
    assert.equal(isProviderAllowed(config, "glm-5.3-flash"), false);
  });

  it("blocks every provider matching a trailing-'*' prefix pattern", () => {
    const config = fakeConfig({ providers: { blocked: ["amazon-*"] } });
    assert.equal(isProviderBlocked(config, "amazon-bedrock"), true);
    assert.equal(isProviderAllowed(config, "amazon-bedrock"), false);
    assert.equal(isProviderAllowed(config, "openai-codex"), true);
  });

  it("folds case on both sides of the match", () => {
    const config = fakeConfig({ providers: { allowed: ["OpenAI-Codex"] } });
    assert.equal(isProviderAllowed(config, "openai-codex"), true);
  });
});

describe("applyConfigOverride", () => {
  it("returns base unchanged when there is no override text", () => {
    const base = fakeConfig();
    assert.deepEqual(applyConfigOverride(base, undefined), base);
  });

  it("lets override values win per top-level key", () => {
    const base = fakeConfig({ maxBudgetUsd: 5 });
    const merged = applyConfigOverride(base, JSON.stringify({ maxBudgetUsd: 10 }));
    assert.equal(merged.maxBudgetUsd, 10);
  });

  it("replaces array fields wholesale rather than concatenating", () => {
    const base = fakeConfig({ models: { allowed: ["sonnet", "opus"] } });
    const merged = applyConfigOverride(base, JSON.stringify({ models: { allowed: ["haiku"] } }));
    assert.deepEqual(merged.models, { allowed: ["haiku"] });
  });

  it("ignores malformed JSON and falls back to base", () => {
    const base = fakeConfig();
    assert.deepEqual(applyConfigOverride(base, "{not json"), base);
  });

  it("ignores a non-object override (array/string/number) and falls back to base", () => {
    const base = fakeConfig();
    assert.deepEqual(applyConfigOverride(base, JSON.stringify(["oops"])), base);
    assert.deepEqual(applyConfigOverride(base, JSON.stringify("oops")), base);
    assert.deepEqual(applyConfigOverride(base, JSON.stringify(42)), base);
  });

  it("merges the narrower shortcut-only shape the same way", () => {
    const base: Pick<MinionConfig, "shortcut"> = { shortcut: "alt+j" };
    const merged = applyConfigOverride(base, JSON.stringify({ shortcut: "ctrl+j" }));
    assert.equal(merged.shortcut, "ctrl+j");
  });
});

describe("USER_CONFIG_PATH", () => {
  it("resolves to ~/.pi/agent/extensions/pi-minion.json via the SDK's getAgentDir", () => {
    assert.equal(USER_CONFIG_PATH, join(getAgentDir(), "extensions", "pi-minion.json"));
  });
});

describe("resolveShortcut", () => {
  it("defaults to alt+j when unset", () => {
    assert.equal(resolveShortcut(fakeConfig()), "alt+j");
  });

  it("uses the configured shortcut when present", () => {
    assert.equal(resolveShortcut(fakeConfig({ shortcut: "ctrl+j" })), "ctrl+j");
  });
});

describe("readShortcutConfigSync", () => {
  it("reads the real pi-minion.json's shortcut field synchronously", () => {
    // Regression test: this must stay synchronous — pi.registerShortcut()
    // has to be called before the extension factory returns, or pi's
    // one-time shortcut snapshot never sees it. See the export's own
    // comment in src/pi-minion.ts for the full timing bug this guards against.
    // Pass an explicit, guaranteed-nonexistent override path so this stays
    // hermetic regardless of whether a real user-override file exists.
    assert.equal(
      readShortcutConfigSync(join(tmpdir(), "pi-minion-test-no-override.json")).shortcut,
      "alt+j"
    );
  });

  it("prefers a real user-override file's shortcut over the built-in one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ shortcut: "ctrl+j" }), "utf8");
      assert.equal(readShortcutConfigSync(overridePath).shortcut, "ctrl+j");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
