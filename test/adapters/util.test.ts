import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandExists, selectAllowedModels, selectAvailableModels, truncate } from "../../src/adapters/util.js";
import { isModelAllowed, modelMatchesPattern } from "../../src/config.js";
import { fakeConfig } from "../fakes.js";

describe("commandExists", () => {
  it("resolves true for a binary guaranteed present on PATH", async () => {
    assert.equal(await commandExists("sh"), true);
  });

  it("resolves false for a name that isn't a real command", async () => {
    assert.equal(await commandExists("definitely-not-a-real-binary-xyz"), false);
  });
});

describe("truncate", () => {
  it("returns the input unchanged when it fits", () => {
    assert.equal(truncate("hello", 10), "hello");
  });

  it("truncates to exactly maxLength, ending in an ellipsis", () => {
    const result = truncate("hello world", 5);
    assert.equal(result, "hell…");
    assert.equal(result.length, 5);
  });
});

describe("selectAllowedModels", () => {
  const universe = ["opencode-go/gpt-6-luna", "opencode-go/gpt-5.6-luna", "opencode/gpt-5-codex"];
  const owns = (model: string) => model.startsWith("opencode") || model === "luna";

  it("preserves order and keeps a plain entry the universe lacks", () => {
    assert.deepEqual(selectAllowedModels(["opencode-go/gpt-5.6-luna", "luna"], universe, owns), [
      "opencode-go/gpt-5.6-luna",
      "luna"
    ]);
  });

  it("expands a glob and drops non-owned or non-matching universe entries", () => {
    assert.deepEqual(selectAllowedModels(["opencode-go/gpt-*-luna"], universe, owns), [
      "opencode-go/gpt-6-luna",
      "opencode-go/gpt-5.6-luna"
    ]);
  });

  it("does not emit a glob literally when it matches nothing", () => {
    assert.deepEqual(selectAllowedModels(["opencode/jev*"], universe, () => true), []);
  });

  it("uses a custom matches predicate over the raw-string glob", () => {
    const matches = (model: string, entry: string) =>
      modelMatchesPattern(model, entry) || modelMatchesPattern(model.split("/")[1] ?? model, entry);
    assert.deepEqual(selectAllowedModels(["gpt-6*"], universe, owns, matches), ["opencode-go/gpt-6-luna"]);
  });

  it("collapses a duplicate produced by a glob and an exact entry", () => {
    assert.deepEqual(selectAllowedModels(["opencode-go/gpt-6-luna", "opencode-go/gpt-6-*"], universe, owns), [
      "opencode-go/gpt-6-luna"
    ]);
  });
});

describe("selectAvailableModels", () => {
  it("defaults to isModelAllowed, so a bare pattern does not match a qualified ref", () => {
    const config = fakeConfig({ models: { allowed: ["gpt-6*"], blocked: [] } });
    assert.equal(isModelAllowed(config, "opencode-go/gpt-6-luna"), false);
    assert.deepEqual(selectAvailableModels(["opencode-go/gpt-6-luna"], config, () => []), []);
  });

  it("uses a custom isAllowed predicate when one is passed", () => {
    const config = fakeConfig({ models: { allowed: ["gpt-6*"], blocked: [] } });
    assert.deepEqual(
      selectAvailableModels(["opencode-go/gpt-6-luna"], config, () => [], (model) => model.endsWith("gpt-6-luna")),
      ["opencode-go/gpt-6-luna"]
    );
  });
});
