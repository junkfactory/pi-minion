import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { getAdapter, listAdapterNames, resolveAdapterForModel, resolveAdapterForModelRefreshed } from "../../src/adapters/registry.js";
import { setModelRegistry } from "../../src/adapters/pi.js";
import { setAgyModelsForTesting } from "../../src/adapters/agy.js";
import { parseAgyModelsList } from "../../src/adapters/agy.js";
import { fakeModelRegistry } from "../fakes.js";

// ownsModel routes against the captured catalogs — seed fakes for this file
// (node:test isolates files in their own process, so no cleanup needed).
setModelRegistry(
  fakeModelRegistry([
    { id: "gpt-6-luna", provider: "opencode-go" },
    { id: "gpt-5.6-terra", provider: "opencode-go" },
    { id: "gpt-6-sol", provider: "openai-codex" },
    { id: "gpt-6.1-sol", provider: "openai-codex" }
  ])
);

// Same fixture the agy suite uses: the captured `agy models` payload,
// parsed and claude-filtered.
const AGY_CATALOG = parseAgyModelsList(
  JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        models: [
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
          { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
          { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
          { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
          { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
          { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
          { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
          { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
          { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
          { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
          { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
          { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" }
        ]
      }
    }
  })
);

before(() => {
  setAgyModelsForTesting(AGY_CATALOG);
});

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

describe("resolveAdapterForModelRefreshed", () => {
  const restoreSeed = () =>
    setModelRegistry(
      fakeModelRegistry([
        { id: "gpt-6-luna", provider: "opencode-go" },
        { id: "gpt-5.6-terra", provider: "opencode-go" },
        { id: "gpt-6-sol", provider: "openai-codex" },
        { id: "gpt-6.1-sol", provider: "openai-codex" }
      ])
    );

  it("claims the model once the refresh brings its catalog up", async () => {
    setModelRegistry(undefined); // pi's catalog not captured yet (cold start)
    try {
      let refreshed = 0;
      const adapter = await resolveAdapterForModelRefreshed("luna", async () => {
        refreshed++;
        setModelRegistry(fakeModelRegistry([{ id: "gpt-6-luna", provider: "opencode-go" }]));
      });
      assert.equal(adapter.name, "pi");
      assert.equal(refreshed, 1);
    } finally {
      restoreSeed();
    }
  });

  it("rethrows the original Unknown model error when the refresh claims nothing", async () => {
    let refreshed = 0;
    await assert.rejects(
      resolveAdapterForModelRefreshed("totally-unknown", async () => {
        refreshed++;
      }),
      /Unknown model "totally-unknown"/
    );
    assert.equal(refreshed, 1);
  });
});
