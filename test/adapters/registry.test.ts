import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAdapter, listAdapterNames, resolveAdapterForModel } from "../../src/adapters/registry.js";

describe("getAdapter / listAdapterNames", () => {
  it("returns the claude adapter by name", () => {
    assert.equal(getAdapter("claude").name, "Claude");
  });

  it("returns the agy adapter by name", () => {
    assert.equal(getAdapter("agy").name, "Antigravity");
  });

  it("returns the pi adapter by name", () => {
    assert.equal(getAdapter("pi").name, "pi");
  });

  it("throws a clear error for an unregistered name", () => {
    assert.throws(() => getAdapter("nonexistent"), /Unknown agentCli "nonexistent"/);
  });

  it("lists every registered adapter name", () => {
    assert.deepEqual(listAdapterNames(), ["claude", "agy", "pi"]);
  });
});

describe("resolveAdapterForModel", () => {
  it("resolves claude's short aliases to the claude adapter", () => {
    assert.equal(resolveAdapterForModel("haiku").name, "Claude");
    assert.equal(resolveAdapterForModel("sonnet").name, "Claude");
    assert.equal(resolveAdapterForModel("opus").name, "Claude");
    assert.equal(resolveAdapterForModel("fable").name, "Claude");
  });

  it("resolves agy's aliases to the agy adapter", () => {
    assert.equal(resolveAdapterForModel("gemini-flash").name, "Antigravity");
    assert.equal(resolveAdapterForModel("gemini-pro").name, "Antigravity");
    assert.equal(resolveAdapterForModel("gpt-oss").name, "Antigravity");
  });

  it("resolves gpt-<digit> ids and provider/id models to the pi adapter", () => {
    assert.equal(resolveAdapterForModel("gpt-6-luna").name, "pi");
    assert.equal(resolveAdapterForModel("gpt-5.6-terra").name, "pi");
    assert.equal(resolveAdapterForModel("openai-codex/gpt-6-sol").name, "pi");
    assert.equal(resolveAdapterForModel("luna").name, "pi");
    assert.equal(resolveAdapterForModel("sol").name, "pi");
  });

  it("throws a clear error when no adapter recognizes the model", () => {
    assert.throws(
      () => resolveAdapterForModel("totally-unknown"),
      /Unknown model "totally-unknown"/
    );
  });
});
