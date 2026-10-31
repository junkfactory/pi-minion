import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AdapterCapabilities,
  AgentCliAdapter,
  MinionConfig,
  MinionRequest,
  NormalizedEvent
} from "./types.js";
import {
  MINION_PROMPT_BASE,
  resolveTaskText,
  selectAllowedModels,
  selectAvailableModels
} from "./util.js";
import { isModelAllowed, isProviderAllowed } from "../config.js";

// Apple Foundation Models CLI (`/usr/bin/fm`, ships with macOS 27.x). It is a
// one-shot text/vision model, not an agent CLI: no tool use, no cost concept,
// no effort levels. Its response text is not delimited on stdout by default
// (`fm respond` prints plain text), and job-runner only marks a job done when
// parseLine emits a "result" event — so every run passes `--schema`, forcing
// fm to print one JSON object shaped like DEFAULT_SCHEMA below.
// Shipped as fm-schema.json next to this file; kept here as the expected
// value that the file's content is validated against on every use.
export const DEFAULT_SCHEMA = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"]
};

// help_pi_minion lines advertising what fm can do beyond plain text. Worded
// agent-facing: no "adapter" anywhere; the fm family is named by its model ids.
export const FM_USAGE_NOTES = [
  "fm (fm:system) is one-shot with no agent tools — the task must be self-contained; there is no cost reporting and effort is ignored.",
  "fm image tasks: name images anywhere in the context with [image:<path>][:<label>]; append :ocr or :barcode (or write [ocr:…] / [barcode:…]) to enable that tool."
];

// Bundled, read-only path: resolved relative to this module, so the extension
// install layout carries the schema (no runtime writes, nothing to sweep from
// /tmp, no write race). Content-validated on each call: a tampered or drifted
// file fails loudly instead of routing jobs through an unknown schema.
const SCHEMA_PATH = fileURLToPath(new URL("./fm-schema.json", import.meta.url));

// Key-order-insensitive comparison so a re-serialized-but-equivalent schema
// still validates; any real difference throws.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Key-order-insensitive comparison so a re-serialized-but-equivalent schema
// still validates; any real difference throws. Exported for tests, which
// point it at temp copies — the bundled path is not overridable in buildArgs.
export function getSchemaPath(path: string = SCHEMA_PATH): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `fm adapter: cannot read the bundled schema file at ${path}: ${(error as Error).message}`
    );
  }
  if (canonicalJson(parsed) !== canonicalJson(DEFAULT_SCHEMA)) {
    throw new Error(
      `fm adapter: the bundled schema file at ${path} does not match the expected default schema; reinstall pi-minion`
    );
  }
  return path;
}

// Model strings this CLI recognizes. `fm` is the bare form ("on-device
// system model", the sane default); `fm:pcc` selects Private Cloud Compute,
// which fm only serves inside a Terminal.app context.
// Ungated, CLI-intrinsic claim; config gating (providers/models) is layered
// on top in ownsModel.
export function rawOwnsModel(model: string): boolean {
  return model === "fm" || model === "fm:system" || model === "fm:pcc";
}

const FM_MODELS = ["fm", "fm:system", "fm:pcc"];

// Whatever the underlying model, fm serves it under its own provider
// identity; [] for a string this adapter doesn't claim.
export function providersOf(model: string): string[] {
  return rawOwnsModel(model) ? ["fm"] : [];
}

// The `--model` value fm expects: its own LLM choice is system-vs-pcc, not a
// model id from a catalog.
export function fmModelName(model: string): string {
  return model === "fm:pcc" ? "pcc" : "system";
}

type FmTaskType = "ocr" | "barcode";
type ExtractedImage = { path: string; label?: string; taskType?: FmTaskType };

// Context markers: [image:<path>], [image:<path>:<label>], and the task-type
// forms [image:<path>:ocr] / [image:<path>:barcode], optionally with a label
// in front ([image:<path>:front:ocr] — the regex captures everything up to
// the closing bracket as one modifier, so the trailing token is what names
// the task type and the rest is the label). Note that a label is only
// allowed when --tool is present, so the task type is tracked separately.
export function extractImages(context: string | undefined): ExtractedImage[] {
  if (!context) return [];
  const images: ExtractedImage[] = [];
  const regex = /\[image:([^:\]]+)(?::([^\]]+))?\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(context)) !== null) {
    const parts = match[2]?.split(":") ?? [];
    const last = parts[parts.length - 1];
    const taskType: FmTaskType | undefined =
      last === "ocr" || last === "barcode" ? last : undefined;
    const labelParts = taskType ? parts.slice(0, -1) : parts;
    images.push({
      path: match[1],
      label: labelParts.length ? labelParts.join(":") : undefined,
      taskType
    });
  }
  return images;
}

// Explicit markers ([ocr:...] / [barcode:...]) or an image's task-type
// modifier. Anything else is general image Q&A, which needs no --tool.
export function detectTaskType(
  context: string | undefined,
  images: ExtractedImage[]
): FmTaskType | "general" {
  if (!context) return "general";
  if (/\[ocr:/i.test(context) || images.some((image) => image.taskType === "ocr")) return "ocr";
  if (/\[barcode:/i.test(context) || images.some((image) => image.taskType === "barcode")) {
    return "barcode";
  }
  return "general";
}

export function buildArgs(request: MinionRequest, config: MinionConfig): string[] {
  const args = [
    "respond",
    "--no-stream",
    "--model",
    fmModelName(request.model),
    "--instructions",
    MINION_PROMPT_BASE,
    // Structured output: fm prints {"result": "..."} instead of prose, which
    // is what makes parseLine able to emit a result event at all.
    "--schema",
    getSchemaPath(),
  ];

  // Image markers may sit in the task or the context — fm receives both
  // concatenated as one prompt (resolveTaskText), so scan exactly what fm
  // reads. Scanning only the context silently dropped markers placed in the
  // task: no --image/--tool were emitted and fm answered off prompt text alone.
  const prompt = resolveTaskText(request);
  const images = extractImages(prompt);
  const taskType = detectTaskType(prompt, images);
  if (taskType !== "general") {
    // --label is only valid alongside --tool (fm rejects it otherwise), so
    // the tool flag is what enables labels below.
    args.push("--tool", taskType);
  }

  for (const image of images) {
    args.push("--image", image.path);
    if (image.label && taskType !== "general") args.push("--label", image.label);
  }

  args.push(...(config.adapterArgs?.fm?.args ?? []));
  // "--" keeps a task that starts with "-" from being parsed as a flag.
  args.push("--", resolveTaskText(request));
  return args;
}

export function environment(): NodeJS.ProcessEnv {
  const names = ["HOME", "PATH", "USER", "LANG", "TERM"];
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))
  );
}

// fm's structured output is a single JSON object on stdout. An empty
// `result` deliberately emits no result event: job-runner then treats the run
// as errored, which is correct — the model produced nothing.
export function parseLine(line: string): NormalizedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown };
    if (typeof parsed.result === "string" && parsed.result.length > 0) {
      return [
        { kind: "text", text: parsed.result },
        { kind: "result", result: parsed.result }
      ];
    }
    if (typeof parsed.result === "string") {
      return [{ kind: "text", text: "[Empty response from fm]" }];
    }
  } catch {
    // Not JSON: fall through to the plain-text path below.
  }

  // Unexpected non-JSON output (an older/newer fm, or a diagnostics line):
  // surface it as text only, never as a result.
  return [{ kind: "text", text: `${line}\n` }];
}

// Bounded so a hung fm subprocess can't stall help_pi_minion's await.
const FM_PROBE_TIMEOUT_MS = 5000;

// Validates that the `fm` on PATH is really the Apple Foundation Models CLI,
// not a same-named binary from another toolchain. A probe that could not even
// run (ENOENT: the binary vanished after registry detection) leaves the
// static catalog in place, whereas a probe that ran without listing the
// on-device `system` model is a definitive mismatch — a collision, or an fm
// that refused to list models — and must fail loudly instead of silently
// routing jobs to an unknown binary.
export async function refreshCatalog(): Promise<void> {
  const execFileAsync = promisify(execFile);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("fm", ["models"], { timeout: FM_PROBE_TIMEOUT_MS }));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown } | null;
    if (failure?.code === "ENOENT") return;
    // execFile rejects on a non-zero exit but still hands back whatever the
    // probe printed, so a collision binary that fails loudly is still judged.
    stdout = typeof failure?.stdout === "string" ? failure.stdout : "";
  }
  if (!stdout.includes("system")) {
    throw new Error(
      "the `fm` command on PATH is not the Apple Foundation Models CLI, or it declined to run (`fm models` listed no `system` model)"
    );
  }
}

const capabilities: AdapterCapabilities = {
  supportsAllowedTools: false,
  supportsEffort: false,
  supportsMaxBudgetUsd: false
};

export function describeUnsupported(request: MinionRequest, _config: MinionConfig): string[] {
  const warnings = [
    "fm has no agent tools — it answers in one shot with no file, shell, or web access, so the task must be self-contained.",
    "No cost ceiling or reporting — fm runs on-device (or on Private Cloud Compute), maxBudgetUsd is unenforced and cost_usd will read n/a.",
    "No effort levels — the requested effort is ignored."
  ];
  if (request.model === "fm:pcc") {
    warnings.push(
      "fm:pcc requires a Terminal.app context and is unavailable to other parents; use fm:system unless fm reports pcc as available."
    );
  }
  return warnings;
}

export function createFmAdapter(config: MinionConfig): AgentCliAdapter {
  // Provider gate against the bound config: providersOf "[]" = keep
  // (unidentifiable), otherwise every provider must pass isProviderAllowed.
  const providerGate = (model: string) => {
    const providers = providersOf(model);
    return providers.length === 0 || providers.every((p) => isProviderAllowed(config, p));
  };
  return {
    name: "fm",
    command: "fm",
    description: "Apple Foundation Models CLI adapter for simple task delegation",
    installHint: "Install macOS 27.x or later (fm ships with the OS at /usr/bin/fm)",
    rawOutputHint: "fm respond outputs plain text or JSON with --schema",
    permissionDeniedWarning:
      "fm requires access to Apple Foundation Models. Ensure you're running on macOS 27.x+ with fm available at /usr/bin/fm.",
    capabilities,
    ownsModel(model) {
      return rawOwnsModel(model) && providerGate(model) && isModelAllowed(config, model);
    },
    rawOwnsModel,
    availableModels() {
      // help_pi_minion's universe: with a non-empty allowlist, expand its
      // patterns against the three strings this adapter accepts; otherwise
      // list them all. Provider/model gates run in selectAvailableModels.
      const base = config.models?.allowed?.length
        ? selectAllowedModels(config.models.allowed, FM_MODELS, rawOwnsModel)
        : FM_MODELS;
      return selectAvailableModels(base, config, providersOf);
    },
    providersOf,
    buildArgs,
    environment,
    parseLine,
    describeUnsupported,
    usageNotes() {
      return FM_USAGE_NOTES;
    },
    refreshCatalog
  };
}
