import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  ensureRegistry,
  getAdapter,
  isModelProviderAllowed,
  listAdapterNames,
  providersOfModel,
  resolveAdapterForModel,
  resolveAdapterForModelRefreshed,
  setAdaptersForTest
} from "../../src/adapters/registry.js";
import type { MinionConfig } from "../../src/adapters/types.js";
import { createClaudeAdapter } from "../../src/adapters/claude.js";
import { createAgyAdapter, parseAgyModelsList, setAgyModelsForTesting } from "../../src/adapters/agy.js";
import { createPiAdapter, setModelRegistry } from "../../src/adapters/pi.js";
import { fakeConfig, fakeModelRegistry } from "../fakes.js";

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

// Permissive bound config: no model/provider filters, so gated claims reduce
// to the adapters' raw claims. (fakeConfig() itself pins a non-empty
// models.allowed — exactly what must NOT gate this file's raw-claim fixtures.)
const PERMISSIVE: MinionConfig = fakeConfig({ models: { allowed: [], blocked: [] } });
const configWith = (patch: Partial<MinionConfig>): MinionConfig => ({ ...PERMISSIVE, ...patch });

// The registry starts EMPTY; the claim suites below pin real adapters (bound
// to PERMISSIVE) instead of relying on any implicit default. The detect path
// of ensureRegistry() shells out to the environment (commandExists) and is
// not mocked — setAdaptersForTest() is the seam: it pins exactly the state
// detection would produce.
const pinDefaults = () =>
  setAdaptersForTest([
    createClaudeAdapter(PERMISSIVE),
    createAgyAdapter(PERMISSIVE),
    createPiAdapter(PERMISSIVE)
  ]);

// Restores the file-seed pi registry after a test swaps in its own catalog.
const restoreSeed = () =>
  setModelRegistry(
    fakeModelRegistry([
      { id: "gpt-6-luna", provider: "opencode-go" },
      { id: "gpt-5.6-terra", provider: "opencode-go" },
      { id: "gpt-6-sol", provider: "openai-codex" },
      { id: "gpt-6.1-sol", provider: "openai-codex" }
    ])
  );

describe("empty registry (before ensure/pin)", () => {
  it("lists no adapters and owns no model", () => {
    assert.deepEqual(listAdapterNames(), []);
    assert.throws(() => resolveAdapterForModel("haiku"), /Unknown model "haiku"/);
    assert.deepEqual(providersOfModel("haiku"), []);
  });

  it("getAdapter throws for every name", () => {
    assert.throws(() => getAdapter("claude"), /Unknown agentCli "claude"/);
  });
});

describe("getAdapter / listAdapterNames", () => {
  before(pinDefaults);

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
  before(pinDefaults);

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

describe("gated claim vs raw claim", () => {
  it("a provider-blocked string keeps its providers via the raw claim but resolves as unknown via the gate", () => {
    try {
      // Rebind only agy with antigravity blocked: the raw claim still names
      // the provider, the gated claim drops the string entirely.
      setAdaptersForTest([
        createClaudeAdapter(PERMISSIVE),
        createAgyAdapter(configWith({ providers: { blocked: ["antigravity"] } })),
        createPiAdapter(PERMISSIVE)
      ]);
      assert.deepEqual(providersOfModel("gpt-oss"), ["antigravity"]);
      assert.throws(() => resolveAdapterForModel("gpt-oss"), /Unknown model "gpt-oss"/);
    } finally {
      pinDefaults();
    }
  });

  it("rebinding the config changes gated outcomes", () => {
    try {
      setAdaptersForTest([
        createClaudeAdapter(PERMISSIVE),
        createAgyAdapter(configWith({ providers: { blocked: ["antigravity"] } })),
        createPiAdapter(PERMISSIVE)
      ]);
      assert.throws(() => resolveAdapterForModel("gpt-oss"), /Unknown model/);
      // Rebind to a permissive config: the same string resolves again.
      pinDefaults();
      assert.equal(resolveAdapterForModel("gpt-oss").name, "Antigravity");
    } finally {
      pinDefaults();
    }
  });

  it("an unregistered adapter's strings are owned by nobody", () => {
    try {
      setAdaptersForTest([createClaudeAdapter(PERMISSIVE), createPiAdapter(PERMISSIVE)]);
      assert.throws(() => resolveAdapterForModel("gemini-flash"), /Unknown model "gemini-flash"/);
      assert.deepEqual(providersOfModel("gemini-flash"), []);
    } finally {
      pinDefaults();
    }
  });
});

describe("ensureRegistry", () => {
  it("no-ops while the registry is test-pinned", async () => {
    pinDefaults();
    try {
      await ensureRegistry(PERMISSIVE); // detection would be environment-dependent; pinned wins
      assert.deepEqual(listAdapterNames(), ["claude", "agy", "pi"]);
      assert.equal(resolveAdapterForModel("haiku").name, "Claude");
    } finally {
      pinDefaults();
    }
  });

  // The unpinned detect path (commandExists over the blueprints) is not
  // exercised here: it shells out to PATH and its outcome depends on the
  // host. setAdaptersForTest() pins the state detection produces, which is
  // what every consumer of the registry actually sees.
});

describe("resolveAdapterForModelRefreshed", () => {
  before(pinDefaults);

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

describe("providersOfModel / isModelProviderAllowed", () => {
  before(pinDefaults);

  it("attributes claude's aliases and claude-* ids to claude", () => {
    assert.deepEqual(providersOfModel("haiku"), ["claude"]);
    assert.deepEqual(providersOfModel("claude-whatever"), ["claude"]);
  });

  it("attributes agy's aliases to antigravity", () => {
    assert.deepEqual(providersOfModel("gpt-oss"), ["antigravity"]);
  });

  it("attributes pi's ids and provider/alias refs to the catalog provider", () => {
    assert.deepEqual(providersOfModel("gpt-6-luna"), ["opencode-go"]);
    assert.deepEqual(providersOfModel("opencode-go/luna"), ["opencode-go"]);
  });

  it("returns [] for a model no adapter claims", () => {
    assert.deepEqual(providersOfModel("totally-unknown"), []);
  });

  it("returns every distinct provider an alias suffix matches", () => {
    try {
      setModelRegistry(
        fakeModelRegistry([
          { id: "gpt-6-luna", provider: "opencode-go" },
          { id: "gpt-5.6-luna", provider: "amazon-bedrock" }
        ])
      );
      assert.deepEqual(providersOfModel("luna").sort(), ["amazon-bedrock", "opencode-go"]);
    } finally {
      restoreSeed();
    }
  });

  it("hides a model whose provider is blocked and keeps unaffected ones", () => {
    assert.equal(isModelProviderAllowed({ providers: { blocked: ["antigravity"] } }, "gpt-oss"), false);
    assert.equal(isModelProviderAllowed({ providers: { blocked: ["antigravity"] } }, "gpt-6-luna"), true);
  });

  it("hides a model whose provider is outside a non-empty allowlist", () => {
    assert.equal(isModelProviderAllowed({ providers: { allowed: ["antigravity"] } }, "gpt-6-luna"), false);
  });

  it("hides a shared alias when any backing provider fails the filter", () => {
    try {
      setModelRegistry(
        fakeModelRegistry([
          { id: "gpt-6-luna", provider: "opencode-go" },
          { id: "gpt-5.6-luna", provider: "amazon-bedrock" }
        ])
      );
      assert.equal(isModelProviderAllowed({ providers: { blocked: ["opencode-go"] } }, "luna"), false);
      assert.equal(isModelProviderAllowed({ providers: { allowed: ["amazon-bedrock"] } }, "luna"), false);
      assert.equal(isModelProviderAllowed({ providers: { blocked: ["antigravity"] } }, "luna"), true);
    } finally {
      restoreSeed();
    }
  });
});
