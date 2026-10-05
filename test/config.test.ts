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
    assert.deepEqual(config.allowedModels, []);
    assert.equal(config.maxOutputBytes, 15_000_000);
    assert.equal(config.maxResultPreviewBytes, 50_000);
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

  it("throws when a merged override strips a required field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ allowedModels: "oops" }), "utf8");
      await assert.rejects(loadConfig(overridePath), /Invalid pi-minion configuration/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("throws when a merged override gives blockedModels the wrong type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const overridePath = join(dir, "pi-minion.json");
    try {
      await writeFile(overridePath, JSON.stringify({ blockedModels: "oops" }), "utf8");
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
      assert.deepEqual(config.allowedModels, []);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("isModelAllowed / isModelBlocked", () => {
  it("treats an empty blockedModels as nothing blocked", () => {
    const config = fakeConfig({ allowedModels: ["sonnet"], blockedModels: [] });
    assert.equal(isModelAllowed(config, "sonnet"), true);
    assert.equal(isModelAllowed(config, "haiku"), false);
    assert.equal(isModelBlocked(config, "haiku"), false);
  });

  it("blocks every id matching a trailing-'*' prefix pattern", () => {
    const config = fakeConfig({ allowedModels: [], blockedModels: ["gemini*"] });
    for (const model of ["gemini-flash", "gemini-pro", "gemini-3.1-pro"]) {
      assert.equal(isModelBlocked(config, model), true, `${model} not blocked`);
      assert.equal(isModelAllowed(config, model), false, `${model} not blocked`);
    }
    assert.equal(isModelAllowed(config, "sonnet"), true);
  });

  it("allows every id matching a trailing-'*' prefix pattern in allowedModels", () => {
    const config = fakeConfig({ allowedModels: ["gemini*"], blockedModels: [] });
    for (const model of ["gemini-flash", "gemini-pro", "gemini-3.1-pro"]) {
      assert.equal(isModelAllowed(config, model), true, `${model} not allowed`);
    }
    assert.equal(isModelAllowed(config, "sonnet"), false);
  });

  it("lets blockedModels win over allowedModels (precedence)", () => {
    const config = fakeConfig({ allowedModels: ["gemini-flash"], blockedModels: ["gemini*"] });
    assert.equal(isModelBlocked(config, "gemini-flash"), true);
    assert.equal(isModelAllowed(config, "gemini-flash"), false);
  });

  it("matches a pattern without '*' exactly, not as a prefix", () => {
    const config = fakeConfig({ allowedModels: [], blockedModels: ["kimi-k3"] });
    assert.equal(isModelBlocked(config, "kimi-k3"), true);
    assert.equal(isModelBlocked(config, "kimi-k3-flash"), false);
    assert.equal(isModelAllowed(config, "kimi-k3-flash"), true);
  });

  it("reports nothing blocked when blockedModels is absent", () => {
    assert.equal(isModelBlocked({}, "sonnet"), false);
    assert.equal(isModelAllowed({ allowedModels: [], blockedModels: undefined }, "sonnet"), true);
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
    const base = fakeConfig({ allowedModels: ["sonnet", "opus"] });
    const merged = applyConfigOverride(base, JSON.stringify({ allowedModels: ["haiku"] }));
    assert.deepEqual(merged.allowedModels, ["haiku"]);
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
