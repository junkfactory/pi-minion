import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildArgs,
  createFmAdapter,
  DEFAULT_SCHEMA,
  describeUnsupported,
  FM_USAGE_NOTES,
  getSchemaPath,
  parseLine,
  rawOwnsModel,
  refreshCatalog
} from "../../src/adapters/fm.js";
import type { MinionConfig, MinionRequest } from "../../src/adapters/types.js";

// The bundled schema shipped next to the adapter (fm-schema.json); --schema
// must point at this exact content, which the adapter validates on every use.
const BUNDLED_SCHEMA_PATH = fileURLToPath(
  new URL("../../src/adapters/fm-schema.json", import.meta.url)
);

function fakeConfig(overrides: Partial<MinionConfig> = {}): MinionConfig {
  return {
    // Empty filters by default: the fm cases below assert routing on the
    // CLI-intrinsic strings, so no allow/block list should hide one.
    models: { allowed: [], blocked: [] },
    allowedTools: [],
    maxBudgetUsd: 5,
    timeoutMs: 900_000,
    ...overrides
  };
}

function fakeRequest(overrides: Partial<MinionRequest> = {}): MinionRequest {
  return {
    task: "Classify this text",
    workspace: "/tmp/workspace",
    model: "fm",
    effort: "medium",
    ...overrides
  } as MinionRequest;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

// Every value for a repeated flag (--image can appear once per image).
function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg === flag) values.push(args[index + 1]);
  });
  return values;
}

// Ownership/enumeration assertions are about the CLI-intrinsic claim, so
// they run on an adapter built with empty filters; the config-gated cases
// below build their own.
const ungated = createFmAdapter(fakeConfig());

describe("rawOwnsModel", () => {
  it("claims the three fm model strings", () => {
    assert.equal(rawOwnsModel("fm"), true);
    assert.equal(rawOwnsModel("fm:system"), true);
    assert.equal(rawOwnsModel("fm:pcc"), true);
  });

  it("rejects other CLIs' models and near-miss strings", () => {
    for (const model of [
      "claude-3-opus",
      "gpt-4",
      "gemini-flash",
      "sonnet",
      "opus",
      "fm:cloud",
      "fm:",
      "fmx",
      "system",
      "pcc",
      "FM",
      "fm "
    ]) {
      assert.equal(rawOwnsModel(model), false, `unexpectedly claimed "${model}"`);
    }
  });

  it("stays ungated on the adapter while ownsModel applies the bound config", () => {
    const adapter = createFmAdapter(fakeConfig({ models: { allowed: [], blocked: ["fm:pcc"] } }));
    assert.equal(adapter.rawOwnsModel("fm:pcc"), true);
    assert.equal(adapter.ownsModel("fm:pcc"), false);
    assert.equal(adapter.ownsModel("fm"), true);

    const allowlisted = createFmAdapter(fakeConfig({ models: { allowed: ["fm:system"], blocked: [] } }));
    assert.equal(allowlisted.ownsModel("fm"), false);
    assert.equal(allowlisted.ownsModel("fm:system"), true);
  });
});

describe("buildArgs", () => {
  it("requests structured output with the default schema for a text task", () => {
    const args = buildArgs(fakeRequest(), fakeConfig());
    assert.equal(args[0], "respond");
    assert.ok(args.includes("--no-stream"));
    assert.equal(flagValue(args, "--model"), "system");
    assert.match(flagValue(args, "--instructions") ?? "", /independent pi minion/);
    assert.ok(args.includes("--schema"));
  });

  it("points --schema at the bundled schema file, content-matched to the expected schema", () => {
    const schemaPath = flagValue(buildArgs(fakeRequest(), fakeConfig()), "--schema");
    assert.ok(schemaPath, "--schema missing");
    assert.equal(schemaPath, BUNDLED_SCHEMA_PATH);
    assert.ok(existsSync(schemaPath), `bundled schema file missing: ${schemaPath}`);
    assert.deepEqual(JSON.parse(readFileSync(schemaPath, "utf8")), DEFAULT_SCHEMA);
  });

  it("reuses the one schema path across calls", () => {
    assert.equal(
      flagValue(buildArgs(fakeRequest(), fakeConfig()), "--schema"),
      flagValue(buildArgs(fakeRequest({ model: "fm:pcc" }), fakeConfig()), "--schema")
    );
  });

  it("maps fm:system and fm to --model system, and fm:pcc to --model pcc", () => {
    for (const model of ["fm", "fm:system"]) {
      assert.equal(flagValue(buildArgs(fakeRequest({ model }), fakeConfig()), "--model"), "system");
    }
    assert.equal(flagValue(buildArgs(fakeRequest({ model: "fm:pcc" }), fakeConfig()), "--model"), "pcc");
  });

  it("put the task last, after --, so a leading dash isn't parsed as a flag", () => {
    const args = buildArgs(fakeRequest({ task: "-x do it", context: "some evidence" }), fakeConfig());
    assert.equal(args[args.length - 2], "--");
    assert.equal(args[args.length - 1], "-x do it\n\nContext:\nsome evidence");
  });

  it("handles general image Q&A: --image, no --tool, no --label", () => {
    const args = buildArgs(fakeRequest({ context: "[image:/tmp/photo.png] describe it" }), fakeConfig());
    assert.deepEqual(flagValues(args, "--image"), ["/tmp/photo.png"]);
    assert.ok(args.includes("--schema"));
    assert.ok(!args.includes("--tool"));
    assert.ok(!args.includes("--label"));
  });

  it("handles an OCR task via the image modifier: --tool ocr, --image, --schema", () => {
    const args = buildArgs(fakeRequest({ context: "[image:/tmp/receipt.png:ocr]" }), fakeConfig());
    assert.equal(flagValue(args, "--tool"), "ocr");
    assert.deepEqual(flagValues(args, "--image"), ["/tmp/receipt.png"]);
    assert.ok(args.includes("--schema"));
  });

  it("handles an OCR task via an explicit [ocr:] marker", () => {
    const args = buildArgs(
      fakeRequest({ context: "[ocr:/tmp/receipt.png] [image:/tmp/receipt.png]" }),
      fakeConfig()
    );
    assert.equal(flagValue(args, "--tool"), "ocr");
    assert.deepEqual(flagValues(args, "--image"), ["/tmp/receipt.png"]);
    assert.ok(!args.includes("--label"));
  });

  it("handles a barcode task: --tool barcode, --image, --schema", () => {
    const args = buildArgs(fakeRequest({ context: "[image:/tmp/code.png:barcode]" }), fakeConfig());
    assert.equal(flagValue(args, "--tool"), "barcode");
    assert.deepEqual(flagValues(args, "--image"), ["/tmp/code.png"]);
    assert.ok(args.includes("--schema"));
  });

  it("handles a barcode task via an explicit [barcode:] marker", () => {
    const args = buildArgs(
      fakeRequest({ context: "[barcode:/tmp/code.png] [image:/tmp/code.png]" }),
      fakeConfig()
    );
    assert.equal(flagValue(args, "--tool"), "barcode");
    assert.deepEqual(flagValues(args, "--image"), ["/tmp/code.png"]);
  });

  it("adds --label only when --tool is present", () => {
    // General image Q&A: the modifier is a label, but there is no --tool, so
    // fm would reject --label — the adapter must drop it.
    const general = buildArgs(fakeRequest({ context: "[image:/tmp/a.png:front]" }), fakeConfig());
    assert.ok(!general.includes("--tool"));
    assert.ok(!general.includes("--label"));

    // With OCR the same modifier survives as a label.
    const ocr = buildArgs(fakeRequest({ context: "[image:/tmp/a.png:front:ocr]" }), fakeConfig());
    assert.equal(flagValue(ocr, "--tool"), "ocr");
    assert.deepEqual(flagValues(ocr, "--label"), ["front"]);
  });

  it("pairs every image with its own --image and --label for multi-image OCR", () => {
    const args = buildArgs(
      fakeRequest({ context: "[image:/tmp/front.png:front:ocr] [image:/tmp/back.png:back:ocr]" }),
      fakeConfig()
    );
    assert.equal(flagValue(args, "--tool"), "ocr");
    assert.deepEqual(flagValues(args, "--image"), ["/tmp/front.png", "/tmp/back.png"]);
    assert.deepEqual(flagValues(args, "--label"), ["front", "back"]);
  });

  it("emits no --image or --tool when the context carries no image marker", () => {
    const args = buildArgs(fakeRequest({ context: "no images here" }), fakeConfig());
    assert.ok(!args.includes("--image"));
    assert.ok(!args.includes("--tool"));
    assert.ok(!args.includes("--label"));
  });

  it("spreads adapterArgs.fm.args just before the -- separator", () => {
    const args = buildArgs(
      fakeRequest(),
      fakeConfig({ adapterArgs: { fm: { args: ["--verbose"], preExec: [] } } })
    );
    assert.equal(args[args.indexOf("--") - 1], "--verbose");
    assert.equal(args[args.indexOf("--") + 1], "Classify this text");
    assert.ok(!buildArgs(fakeRequest(), fakeConfig()).includes("--verbose"));
  });

  it("never leaks adapterArgs.fm.preExec into the adapter argv", () => {
    const args = buildArgs(
      fakeRequest(),
      fakeConfig({ adapterArgs: { fm: { args: [], preExec: ["env", "-u", "AWS_PROFILE"] } } })
    );
    assert.ok(!args.includes("env"));
    assert.ok(!args.includes("-u"));
    assert.ok(!args.includes("AWS_PROFILE"));
  });

  it("never emits a budget or effort flag — fm has neither", () => {
    const args = buildArgs(fakeRequest({ effort: "high" }), fakeConfig({ allowedTools: ["Bash"] }));
    assert.ok(!args.includes("--max-budget-usd"));
    assert.ok(!args.includes("--effort"));
    assert.ok(!args.includes("--tools"));
    assert.ok(!args.includes("--allowedTools"));
  });
});

describe("getSchemaPath (bundled schema validation)", () => {
  it("accepts the bundled fm-schema.json as-is", () => {
    assert.equal(getSchemaPath(), BUNDLED_SCHEMA_PATH);
  });

  it("accepts an equivalent schema with a different key order", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-minion-fm-schema-"));
    const file = join(dir, "schema.json");
    writeFileSync(
      file,
      JSON.stringify({ required: ["result"], properties: { result: { type: "string" } }, type: "object" })
    );
    assert.equal(getSchemaPath(file), file);
  });

  it("rejects a tampered schema file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-minion-fm-schema-"));
    const file = join(dir, "schema.json");
    writeFileSync(
      file,
      JSON.stringify({ type: "object", properties: { result: { type: "number" } }, required: ["result"] })
    );
    assert.throws(() => getSchemaPath(file), /does not match the expected default schema/);
  });

  it("rejects a missing or unparseable schema file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-minion-fm-schema-"));
    const missing = join(dir, "nope.json");
    assert.throws(() => getSchemaPath(missing), /cannot read the bundled schema file/);
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    assert.throws(() => getSchemaPath(corrupt), /cannot read the bundled schema file/);
  });
});

describe("parseLine", () => {
  it("emits text and result for a non-empty structured result", () => {
    assert.deepEqual(parseLine(JSON.stringify({ result: "The classification is positive." })), [
      { kind: "text", text: "The classification is positive." },
      { kind: "result", result: "The classification is positive." }
    ]);
  });

  it("tolerates surrounding whitespace on the JSON line", () => {
    assert.deepEqual(parseLine(`  ${JSON.stringify({ result: "OK" })}\n`), [
      { kind: "text", text: "OK" },
      { kind: "result", result: "OK" }
    ]);
  });

  it("ignores blank lines", () => {
    assert.deepEqual(parseLine(""), []);
    assert.deepEqual(parseLine("   \n\t"), []);
  });

  it("emits no result event for an empty result — the job must error instead", () => {
    const events = parseLine(JSON.stringify({ result: "" }));
    assert.deepEqual(events, [{ kind: "text", text: "[Empty response from fm]" }]);
    assert.ok(!events.some((event) => event.kind === "result"));
  });

  it("falls back to text for invalid JSON — never fabricating a result", () => {
    const events = parseLine("not json");
    assert.deepEqual(events, [{ kind: "text", text: "not json\n" }]);
    assert.ok(!events.some((event) => event.kind === "result"));
  });

  it("falls back to text for JSON without a string result field", () => {
    const line = JSON.stringify({ result: 5 });
    const events = parseLine(line);
    assert.deepEqual(events, [{ kind: "text", text: `${line}\n` }]);
    assert.ok(!events.some((event) => event.kind === "result"));
  });
});

describe("availableModels", () => {
  it("lists all three fm strings when nothing is filtered", () => {
    assert.deepEqual(ungated.availableModels(), ["fm", "fm:system", "fm:pcc"]);
  });

  it("intersects a non-empty allowlist with the claim, preserving allowlist order", () => {
    const adapter = createFmAdapter(fakeConfig({ models: { allowed: ["fm:pcc", "fm"], blocked: [] } }));
    assert.deepEqual(adapter.availableModels(), ["fm:pcc", "fm"]);
  });

  it("expands a glob allowlist against the fm universe", () => {
    const adapter = createFmAdapter(fakeConfig({ models: { allowed: ["fm:*"], blocked: [] } }));
    assert.deepEqual(adapter.availableModels(), ["fm:system", "fm:pcc"]);
  });

  it("drops entries the allowlist does not cover, and a glob matching nothing", () => {
    const adapter = createFmAdapter(fakeConfig({ models: { allowed: ["fm:cloud", "gpt-4"], blocked: [] } }));
    assert.deepEqual(adapter.availableModels(), []);
  });

  it("honors models.blocked (blocked wins over allowed)", () => {
    const adapter = createFmAdapter(
      fakeConfig({ models: { allowed: ["fm", "fm:pcc"], blocked: ["fm:pcc"] } })
    );
    assert.deepEqual(adapter.availableModels(), ["fm"]);
  });

  it("honors providers.blocked / providers.allowed", () => {
    const blocked = createFmAdapter(
      fakeConfig({ models: { allowed: [], blocked: [] }, providers: { allowed: [], blocked: ["fm"] } })
    );
    assert.deepEqual(blocked.availableModels(), []);
    assert.equal(blocked.ownsModel("fm"), false);

    const allowed = createFmAdapter(
      fakeConfig({ models: { allowed: [], blocked: [] }, providers: { allowed: ["fm"], blocked: [] } })
    );
    assert.deepEqual(allowed.availableModels(), ["fm", "fm:system", "fm:pcc"]);
  });
});

describe("describeUnsupported", () => {
  it("warns about no agent tools, no cost tracking, and no effort levels", () => {
    const warnings = describeUnsupported(fakeRequest(), fakeConfig());
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /no agent tools/);
    assert.match(warnings[1], /no cost ceiling or reporting/i);
    assert.match(warnings[2], /no effort levels/i);
  });

  it("says the same three things for fm:system", () => {
    assert.equal(describeUnsupported(fakeRequest({ model: "fm:system" }), fakeConfig()).length, 3);
  });

  it("adds the Terminal.app requirement warning for fm:pcc", () => {
    const warnings = describeUnsupported(fakeRequest({ model: "fm:pcc" }), fakeConfig());
    assert.equal(warnings.length, 4);
    assert.match(warnings[3], /Terminal\.app/);
    assert.match(warnings[3], /fm:pcc/);
  });
});

describe("capabilities", () => {
  it("reports every capability as unsupported — fm is a one-shot text model", () => {
    assert.deepEqual(ungated.capabilities, {
      supportsAllowedTools: false,
      supportsEffort: false,
      supportsMaxBudgetUsd: false
    });
  });

  it("exposes fm-specific metadata and a refreshCatalog hook", () => {
    assert.equal(ungated.name, "fm");
    assert.equal(ungated.command, "fm");
    assert.equal(typeof ungated.refreshCatalog, "function");
    assert.match(ungated.permissionDeniedWarning, /Foundation Models/);
  });
});

describe("refreshCatalog", () => {
  const bin = mkdtempSync(join(tmpdir(), "pi-minion-fm-"));
  const realPath = process.env.PATH;
  // A fake `fm` is the only way to drive refreshCatalog: it shells out to
  // whatever `fm` PATH resolves to, so the fixtures below shadow the real
  // binary (or the absence of one) for the duration of each test.
  const fakeFm = (script: string) => {
    writeFileSync(join(bin, "fm"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "fm"), 0o755);
    process.env.PATH = `${bin}:${realPath}`;
  };

  it("resolves when `fm models` lists the on-device system model", async () => {
    fakeFm('printf "system\\tAFM 3 Core (on-device)\\npcc\\tPrivate Cloud Compute\\n"');
    try {
      await assert.doesNotReject(refreshCatalog());
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("throws on a binary collision — `fm models` output lists no system model", async () => {
    fakeFm('echo "fm: fast file manager"');
    try {
      await assert.rejects(refreshCatalog(), /not the Apple Foundation Models CLI/);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("throws when the probe prints nothing and exits non-zero", async () => {
    fakeFm("exit 1");
    try {
      await assert.rejects(refreshCatalog(), /not the Apple Foundation Models CLI/);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("resolves when fm vanished after detection (ENOENT leaves the static catalog)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pi-minion-fm-empty-"));
    process.env.PATH = empty;
    try {
      await assert.doesNotReject(refreshCatalog());
    } finally {
      process.env.PATH = realPath;
    }
  });
});

describe("usageNotes", () => {
  it("returns the two fm capability lines from the bound adapter", () => {
    const notes = createFmAdapter(fakeConfig()).usageNotes();
    assert.equal(notes.length, 2);
    assert.match(notes[0], /one-shot/);
    assert.match(notes[0], /no agent tools/);
    assert.match(notes[1], /\[image:/);
    assert.match(notes[1], /:ocr/);
    assert.match(notes[1], /:barcode/);
  });

  it("keeps the notes agent-facing: no internal \"adapter\" wording, stable across calls", () => {
    const fm = createFmAdapter(fakeConfig());
    for (const note of fm.usageNotes()) {
      assert.ok(!/\badapter\b/i.test(note), `leaks internal wording: ${note}`);
    }
    // The lines are the module constant; a fresh call must read identically.
    assert.deepEqual(fm.usageNotes(), FM_USAGE_NOTES);
    assert.deepEqual(fm.usageNotes(), fm.usageNotes());
  });
});
