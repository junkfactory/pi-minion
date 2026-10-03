import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import type { MinionConfig } from "./adapters/types.js";

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
  if (
    !config.defaultModel ||
    !config.defaultEffort ||
    !Array.isArray(config.allowedModels) ||
    !Array.isArray(config.allowedTools)
  ) {
    throw new Error(
      overrideText !== undefined
        ? `Invalid pi-minion configuration (after merging ${overridePath} over ${CONFIG_PATH})`
        : `Invalid pi-minion configuration: ${CONFIG_PATH}`
    );
  }
  return config;
}

export function resolveShortcut(config: Pick<MinionConfig, "shortcut">): KeyId {
  return (config.shortcut ?? DEFAULT_SHORTCUT) as KeyId;
}

// Pi snapshots each extension's registered shortcuts exactly once, right
// after the extension factory returns (before any later microtask/IO
// continuation runs) — a pi.registerShortcut() call made from inside an
// awaited loadConfig().then(...) loses that race and is silently never
// picked up, with no error surfaced anywhere. Reading just the shortcut
// field synchronously lets the factory register it before that snapshot is
// taken; everything else config-dependent can still use the async loadConfig().
export function readShortcutConfigSync(
  overridePath: string = USER_CONFIG_PATH
): Pick<MinionConfig, "shortcut"> {
  let base: Pick<MinionConfig, "shortcut">;
  try {
    base = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Pick<MinionConfig, "shortcut">;
  } catch {
    base = {};
  }
  const overrideText = existsSync(overridePath) ? readFileSync(overridePath, "utf8") : undefined;
  return applyConfigOverride(base, overrideText, overridePath);
}
