import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { AdapterArgs, MinionConfig } from "./adapters/types.js";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "pi-minion.json");
export const USER_CONFIG_PATH = join(getAgentDir(), "extensions", "pi-minion.json");
export const DEFAULT_PRUNE_AFTER_DAYS = 7;
// Bounds raw stream-json (thinking, tool inputs/outputs, text deltas — not
// just the final report), so a review reading several files can legitimately
// produce a few MB before finishing. This is a disk/runaway-process backstop
// (a stuck tool-call loop can grow stdout.json for the full `timeoutMs`
// window regardless of `maxBudgetUsd`), not a cost control — configurable
// per pi-minion.json since what counts as "runaway" depends on expected
// workloads.
export const DEFAULT_MAX_OUTPUT_BYTES = 15_000_000;
// A clean-exit result is inlined into the primary session's context via
// pi.sendMessage, unlike the exceededOutputLimit/timedOut cases (which
// already point at stdoutPath instead of inlining). A large result would
// otherwise burn the primary agent's context for free; past this cap it's
// truncated with a pointer to the full text on disk instead.
export const DEFAULT_MAX_RESULT_PREVIEW_BYTES = 50_000;
// alt+j: unbound in Pi's default keybindings.json (docs/keybindings.md) —
// unlike most letters, neither its ctrl+ nor alt+ form collides with an
// editor, session, model, or tree-navigation action.
const DEFAULT_SHORTCUT = "alt+j";

// Merges a user-supplied override object over `base`. Falls back to `base`
// unchanged (with a console warning) on unparsable or non-object JSON,
// rather than throwing — a broken override shouldn't break the extension.
export function applyConfigOverride<T extends object>(
  base: T,
  overrideRawText: string | undefined,
  overridePath: string = USER_CONFIG_PATH
): T {
  if (overrideRawText === undefined) return base;
  let overrides: unknown;
  try {
    overrides = JSON.parse(overrideRawText);
  } catch (error) {
    console.error(`Warning: could not parse ${overridePath}: ${error}`);
    return base;
  }
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    console.error(`Warning: ignoring ${overridePath} — expected a JSON object`);
    return base;
  }
  return { ...base, ...overrides };
}

export async function loadConfig(overridePath: string = USER_CONFIG_PATH): Promise<MinionConfig> {
  const base = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as MinionConfig;
  const overrideText = existsSync(overridePath)
    ? await readFile(overridePath, "utf8")
    : undefined;
  const config = applyConfigOverride(base, overrideText, overridePath);
  const adapterArgs =
    config.adapterArgs === undefined ? undefined : normalizeAdapterArgs(config.adapterArgs);
  if (
    !Array.isArray(config.allowedTools) ||
    (config.models !== undefined && !isAllowDenyShape(config.models)) ||
    (config.providers !== undefined && !isAllowDenyShape(config.providers)) ||
    (config.adapterArgs !== undefined && adapterArgs === undefined)
  ) {
    throw new Error(
      overrideText !== undefined
        ? `Invalid pi-minion configuration (after merging ${overridePath} over ${CONFIG_PATH})`
        : `Invalid pi-minion configuration: ${CONFIG_PATH}`
    );
  }
  if (adapterArgs !== undefined) config.adapterArgs = adapterArgs;
  return config;
}

// Empty models.allowed means "no static allowlist": every model a present
// adapter can own is allowed (with the pi adapter routing against the live
// catalog, that's every credential-available model on this machine; unknown
// ids still fail at startJob with "Unknown model"). A non-empty list is a
// strict whitelist — entries may carry the same trailing-'*' wildcard as
// models.blocked.
// Trailing '*' = prefix match ("gemini*" → startsWith("gemini"));
// no '*' = exact match. A leading '*' would also be a prefix match of
// the remainder, so guard: only a TRAILING '*' is a wildcard.
// Matching is on the raw request string: a provider-qualified
// "opencode-go/gpt-6-luna" must be listed (or covered by a pattern like
// "opencode-go/*") to pass a non-empty allowlist — help and validateRequest
// apply the same rule.
function modelMatchesPattern(model: string, pattern: string): boolean {
  return pattern.endsWith("*")
    ? model.startsWith(pattern.slice(0, -1))
    : model === pattern;
}

// Validates the { allowed?: string[]; blocked?: string[] } filter blocks
// (models, providers) without normalizing: the isModel*/isProvider* helpers
// default each missing side to [].
function isAllowDenyShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { allowed, blocked } = value as { allowed?: unknown; blocked?: unknown };
  const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((i) => typeof i === "string"));
  return strings(allowed) && strings(blocked);
}

// Returns the normalized map, or undefined if any entry is invalid
// (neither a string[] nor an object with optional string[] args/preExec).
function normalizeAdapterArgs(value: unknown): Record<string, AdapterArgs> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, AdapterArgs> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    const isStrings = (v: unknown) => Array.isArray(v) && v.every((i) => typeof i === "string");
    if (isStrings(entry)) {
      out[name] = { args: [...entry as string[]], preExec: [] };
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const { args, preExec } = entry as { args?: unknown; preExec?: unknown };
      if ((args !== undefined && !isStrings(args)) || (preExec !== undefined && !isStrings(preExec))) return undefined;
      out[name] = { args: [...(args as string[] | undefined ?? [])], preExec: [...(preExec as string[] | undefined ?? [])] };
    } else {
      return undefined;
    }
  }
  return out;
}

export function isModelBlocked(config: Pick<MinionConfig, "models">, model: string): boolean {
  return (config.models?.blocked ?? []).some((p) => modelMatchesPattern(model, p));
}

export function isModelAllowed(config: Pick<MinionConfig, "models">, model: string): boolean {
  if (isModelBlocked(config, model)) return false;
  const allowed = config.models?.allowed ?? [];
  return allowed.length === 0 || allowed.some((p) => modelMatchesPattern(model, p));
}

export function isProviderBlocked(
  config: Pick<MinionConfig, "providers">,
  provider: string
): boolean {
  const lower = provider.toLowerCase();
  return (config.providers?.blocked ?? []).some((p) => modelMatchesPattern(lower, p.toLowerCase()));
}

// Same contract as isModelAllowed: blocked wins, empty allowed = no
// allowlist; pattern matching reuses modelMatchesPattern (trailing '*'),
// case-insensitive on both sides.
export function isProviderAllowed(
  config: Pick<MinionConfig, "providers">,
  provider: string
): boolean {
  if (isProviderBlocked(config, provider)) return false;
  const allowed = config.providers?.allowed ?? [];
  return allowed.length === 0 || allowed.some((p) => modelMatchesPattern(provider.toLowerCase(), p.toLowerCase()));
}

export function resolveShortcut(config: Pick<MinionConfig, "shortcut">): KeyId {
  return (config.shortcut ?? DEFAULT_SHORTCUT) as KeyId;
}

// Pi snapshots each extension's registered shortcuts exactly once, right
// after the extension factory returns (before any later microtask/IO
// continuation runs) — a pi.registerShortcut() call made from inside an
// awaited loadConfig().then(...) loses that race and is silently never
// picked up, with no error surfaced anywhere. Reading just the shortcut and
// showGlyphs fields synchronously lets the factory register the shortcut and
// set the glyph flag before that snapshot is taken; everything else
// config-dependent can still use the async loadConfig().
export function readShortcutConfigSync(
  overridePath: string = USER_CONFIG_PATH
): Pick<MinionConfig, "shortcut" | "showGlyphs"> {
  let base: Pick<MinionConfig, "shortcut" | "showGlyphs">;
  try {
    base = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Pick<MinionConfig, "shortcut">;
  } catch {
    base = {};
  }
  const overrideText = existsSync(overridePath) ? readFileSync(overridePath, "utf8") : undefined;
  return applyConfigOverride(base, overrideText, overridePath);
}
