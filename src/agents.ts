import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { isValidMaxTurns } from "./config.js";
import { logJobEvent, type JobLogEvent } from "./log.js";

// One markdown file per agent, named `<agent-name>.md`. Scanned on every call
// (no cache): the directory is tiny, and an edit mid-session must take effect
// on the next delegation.
export const AGENT_DIR = join(homedir(), ".pi", "agent", "pi-minion", "agents");

// Mirrors job-runner.ts's module-local MAX_TIMEOUT_MS (not exported there —
// importing it would couple the loader to the runner): the same 32-bit
// setTimeout ceiling bounds an agent file's default timeout.
const MAX_AGENT_TIMEOUT_MS = 2_147_483_647;

// Filename stem = agent name; kebab-case keeps names unambiguous wherever the
// name is echoed (tool params, job titles, logs).
const KEBAB_CASE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface AgentSummary {
  name: string;
  description: string;
}

// Parsed frontmatter plus the body, which is the agent's system prompt.
export interface AgentDefinition extends AgentSummary {
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
export type AgentLog = (
  event: JobLogEvent,
  info: { id: string; model: string; detail?: string }
) => void;

export const defaultLog: AgentLog = (event, info) => void logJobEvent(event, info);

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
function parseAgentFile(raw: string): Omit<AgentDefinition, "name"> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(raw);
  if (!match) throw new Error("missing YAML frontmatter");
  const [, frontmatterText, bodyText] = match;
  const body = (bodyText ?? "").trim();
  if (!body) throw new Error("empty body (the body is the agent's system prompt)");

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
  // Optional keys beyond the schema are ignored: an agent file may carry
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
      (value) => value > 0 && value <= MAX_AGENT_TIMEOUT_MS,
      `positive number no greater than ${MAX_AGENT_TIMEOUT_MS}`
    ),
    body
  };
}

function warn(log: AgentLog, file: string, reason: string): void {
  // Not a job, so id is the file name and there is no model to report.
  log("agent_invalid", { id: file, model: "n/a", detail: `reason="${reason}"` });
}

async function scanAgents(dir: string, log: AgentLog): Promise<AgentDefinition[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // No agent directory yet is the normal "no agents" state.
  }
  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    // Symlinks are read as files so a dotfile-repo setup still works;
    // directories are never agent files. Anything else must be .md.
    if (!(entry.isFile() || entry.isSymbolicLink())) continue;
    // Dotfiles (.DS_Store, editor swap backups, .gitkeep) are ordinary noise,
    // not agent-file mistakes — skip them silently.
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(".md")) {
      warn(log, entry.name, "not an agent file (.md)");
      continue;
    }
    const name = entry.name.slice(0, -".md".length);
    if (!KEBAB_CASE_NAME.test(name)) {
      warn(log, entry.name, "file name must be kebab-case (e.g. code-review.md)");
      continue;
    }
    try {
      agents.push({ name, ...parseAgentFile(await readFile(join(dir, entry.name), "utf8")) });
    } catch (error) {
      warn(log, entry.name, (error as Error).message);
    }
  }
  // Sorted so help output and "available agents" lists are stable —
  // readdir order is filesystem-dependent.
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAgents(
  dir: string = AGENT_DIR,
  log: AgentLog = defaultLog
): Promise<AgentSummary[]> {
  return (await scanAgents(dir, log)).map(({ name, description }) => ({ name, description }));
}

export async function resolveAgent(
  name: string,
  dir: string = AGENT_DIR,
  log: AgentLog = defaultLog
): Promise<AgentDefinition> {
  const agents = await scanAgents(dir, log);
  const found = agents.find((agent) => agent.name === name);
  if (found) return found;
  const available = agents.map((agent) => agent.name);
  const listing = available.length
    ? `Available agents: ${available.join(", ")}.`
    : `No agent files are defined in ${dir}.`;
  throw new Error(
    `Unknown agent "${name}". ${listing} Call help_pi_minion for the agents usable here.`
  );
}
