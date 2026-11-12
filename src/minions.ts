import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { isValidMaxTurns } from "./config.js";
import { logJobEvent, type JobLogEvent } from "./log.js";

// One markdown file per minion, named `<minion-name>.md`. Scanned on every call
// (no cache): the directory is tiny, and an edit mid-session must take effect
// on the next delegation. The legacy `agents/` directory is not read.
export const MINION_DIR = join(homedir(), ".pi", "agent", "pi-minion", "minions");

// Mirrors job-runner.ts's module-local MAX_TIMEOUT_MS (not exported there —
// importing it would couple the loader to the runner): the same 32-bit
// setTimeout ceiling bounds a minion file's default timeout.
const MAX_MINION_TIMEOUT_MS = 2_147_483_647;

// Filename stem = minion name; kebab-case keeps names unambiguous wherever the
// name is echoed (tool params, job titles, logs).
const KEBAB_CASE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface MinionSummary {
  name: string;
  description: string;
  model: string | null;
  effort: string | null;
}

// Parsed frontmatter plus the body, which is the minion's system prompt.
// model/effort stay optional here (the summary surfaces their absence as null).
export interface MinionDefinition extends Omit<MinionSummary, "model" | "effort"> {
  model?: string;
  effort?: string;
  tools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  body: string;
}

// Same shape as logJobEvent, injected so tests needn't write the real log
// (same rationale as workflow-runner's `log` dependency).
export type MinionLog = (
  event: JobLogEvent,
  info: { id: string; model: string; detail?: string }
) => void;

export const defaultLog: MinionLog = (event, info) => void logJobEvent(event, info);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Optional string keys: absent/null is fine, anything else must be a
// non-blank string (a blank model or description is a typo, not a default).
function optionalString(
  frontmatter: Record<string, unknown>,
  key: string
): string | undefined {
  const value = frontmatter[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

// Accepts `[Bash, Glob]` and `Bash, Glob` alike; unknown/free-form entries are
// the adapter's business, so entries are only trimmed, never validated.
function parseTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  let parts: unknown[];
  if (typeof value === "string") parts = value.split(",");
  else if (Array.isArray(value)) parts = value;
  else throw new Error("tools must be a string array or a comma-separated string");
  if (!parts.every((part): part is string => typeof part === "string"))
    throw new Error("tools must be a string array or a comma-separated string");
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function optionalNumber(
  frontmatter: Record<string, unknown>,
  key: string,
  isValid: (value: number) => boolean,
  requirement: string
): number | undefined {
  const value = frontmatter[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !isValid(value))
    throw new Error(`${key} must be a ${requirement}`);
  return value;
}

// Validates one file and returns its definition (name excluded). Throws on
// anything wrong; the caller logs and skips, so one bad file never hides the
// rest of the directory.
function parseMinionFile(raw: string): Omit<MinionDefinition, "name"> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(raw);
  if (!match) throw new Error("missing YAML frontmatter");
  const [, frontmatterText, bodyText] = match;
  const body = (bodyText ?? "").trim();
  if (!body) throw new Error("empty body (the body is the minion's system prompt)");

  let data: unknown;
  try {
    data = parse(frontmatterText);
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${(error as Error).message}`);
  }
  // An all-comments/empty block parses to null — report the missing
  // description rather than a mapping error nobody expects here.
  const frontmatter = data === null || data === undefined ? {} : data;
  if (!isPlainObject(frontmatter))
    throw new Error("frontmatter must be a YAML mapping of keys to values");

  const description = optionalString(frontmatter, "description");
  if (!description) throw new Error("missing required description");
  // Optional keys beyond the schema are ignored: a minion file may carry
  // notes for humans without failing validation.
  return {
    description,
    model: optionalString(frontmatter, "model"),
    effort: optionalString(frontmatter, "effort"),
    tools: parseTools(frontmatter.tools),
    maxTurns: optionalNumber(
      frontmatter,
      "maxTurns",
      (value) => isValidMaxTurns(value),
      "whole number from 1 to 100000"
    ),
    maxBudgetUsd: optionalNumber(
      frontmatter,
      "maxBudgetUsd",
      (value) => value > 0,
      "positive number"
    ),
    timeoutMs: optionalNumber(
      frontmatter,
      "timeoutMs",
      (value) => value > 0 && value <= MAX_MINION_TIMEOUT_MS,
      `positive number no greater than ${MAX_MINION_TIMEOUT_MS}`
    ),
    body
  };
}

function warn(log: MinionLog, file: string, reason: string): void {
  // Not a job, so id is the file name and there is no model to report.
  log("minion_invalid", { id: file, model: "n/a", detail: `reason="${reason}"` });
}

async function scanMinions(dir: string, log: MinionLog): Promise<MinionDefinition[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // No minion directory yet is the normal "no minions" state.
  }
  const minions: MinionDefinition[] = [];
  for (const entry of entries) {
    // Symlinks are read as files so a dotfile-repo setup still works;
    // directories are never minion files. Anything else must be .md.
    if (!(entry.isFile() || entry.isSymbolicLink())) continue;
    // Dotfiles (.DS_Store, editor swap backups, .gitkeep) are ordinary noise,
    // not minion-file mistakes — skip them silently.
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(".md")) {
      warn(log, entry.name, "not a minion file (.md)");
      continue;
    }
    const name = entry.name.slice(0, -".md".length);
    if (!KEBAB_CASE_NAME.test(name)) {
      warn(log, entry.name, "file name must be kebab-case (e.g. code-review.md)");
      continue;
    }
    try {
      minions.push({ name, ...parseMinionFile(await readFile(join(dir, entry.name), "utf8")) });
    } catch (error) {
      warn(log, entry.name, (error as Error).message);
    }
  }
  // Sorted so help output and "available minions" lists are stable —
  // readdir order is filesystem-dependent.
  return minions.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMinions(
  dir: string = MINION_DIR,
  log: MinionLog = defaultLog
): Promise<MinionSummary[]> {
  return (await scanMinions(dir, log)).map(
    ({ name, description, model, effort }) => ({
      name,
      description,
      model: model ?? null,
      effort: effort ?? null
    })
  );
}

export async function resolveMinion(
  name: string,
  dir: string = MINION_DIR,
  log: MinionLog = defaultLog
): Promise<MinionDefinition> {
  const minions = await scanMinions(dir, log);
  const found = minions.find((minion) => minion.name === name);
  if (found) return found;
  const available = minions.map((minion) => minion.name);
  const listing = available.length
    ? `Available minions: ${available.join(", ")}.`
    : `No minion files are defined in ${dir}.`;
  throw new Error(
    `Unknown minion "${name}". ${listing} Call help_pi_minion for the minions usable here.`
  );
}
