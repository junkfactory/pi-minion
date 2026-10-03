import { dirname, join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelBreakdown, UsageTotals } from "./adapters/types.js";

// Fallback home for job sessions whose parent session has no file (see
// writeChildSession). pi-usage-extension recursively scans sessions/**.
const USAGE_ROOT = join(getAgentDir(), "sessions", "pi-minion");

// Where a session goes: next to its parent's file (so /resume threads it
// under the parent), or under USAGE_ROOT, two levels deep, where /resume
// never looks and job pruning doesn't erase it.
function sessionDirFor(parentSessionFile: string | undefined, at: number, usageRoot = USAGE_ROOT): string {
  return parentSessionFile ? dirname(parentSessionFile) : join(usageRoot, new Date(at).toISOString().slice(0, 7));
}

function assistantMessage(provider: string, entry: ModelBreakdown, text: string | undefined, timestamp: number) {
  return {
    role: "assistant" as const,
    api: provider,
    provider,
    model: entry.model,
    content: text === undefined ? [] : [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    timestamp,
    usage: {
      input: entry.inputTokens,
      output: entry.outputTokens,
      cacheRead: entry.cacheReadTokens,
      cacheWrite: entry.cacheWriteTokens,
      totalTokens: entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: entry.costUsd }
    }
  };
}

// Writes the job as a pi session: the task as the user message, then one
// assistant message per model carrying its usage (what pi-usage-extension
// counts, deduped on timestamp + token sum, hence the distinct timestamps),
// with the result text on the last. With a parent session file it lands next
// to it with a parentSession header so /resume threads it under the parent;
// otherwise it goes under USAGE_ROOT (see sessionDirFor).
export function writeChildSession(params: {
  parentSessionFile?: string;
  cwd: string;
  name: string;
  prompt: string;
  resultText: string;
  provider: string;
  model: string;
  effort?: string;
  startedAt: number;
  finishedAt: number;
  usage?: UsageTotals;
  usageRoot?: string;
}): string | undefined {
  const { usage } = params;
  const sessionDir = sessionDirFor(params.parentSessionFile, params.finishedAt, params.usageRoot);
  const session = SessionManager.create(params.cwd, sessionDir, { parentSession: params.parentSessionFile });
  if (params.effort) session.appendThinkingLevelChange(params.effort);
  session.appendMessage({ role: "user", content: [{ type: "text", text: params.prompt }], timestamp: params.startedAt });
  const entries: ModelBreakdown[] = usage?.perModel.length
    ? usage.perModel
    : [
        {
          model: params.model,
          costUsd: usage?.totalCostUsd ?? 0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
          cacheReadTokens: usage?.cacheReadTokens ?? 0
        }
      ];
  entries.forEach((entry, i) => {
    session.appendMessage(
      assistantMessage(params.provider, entry, i === entries.length - 1 ? params.resultText : undefined, params.finishedAt + i)
    );
  });
  session.appendSessionInfo(params.name);
  return session.getSessionFile();
}

// A workflow's own session, so /resume groups its steps under it: each step's
// child session uses `file` as its parent. Written at start (pi only puts a
// session on disk once it has an assistant message, hence "Running…") so the
// steps' parent exists as they finish; `finish` appends the summary. Zero
// usage throughout — the steps' own sessions carry the real tokens and cost.
const WORKFLOW_PROVIDER = "pi-minion";

export type WorkflowSession = { file?: string; finish: (summary: string, at?: number) => void };

export function startWorkflowSession(params: {
  parentSessionFile?: string;
  cwd: string;
  name: string;
  plan: string;
  startedAt: number;
  usageRoot?: string;
}): WorkflowSession {
  const session = SessionManager.create(params.cwd, sessionDirFor(params.parentSessionFile, params.startedAt, params.usageRoot), {
    parentSession: params.parentSessionFile
  });
  const zero = (model: string): ModelBreakdown => ({
    model,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0
  });
  session.appendMessage({ role: "user", content: [{ type: "text", text: params.plan }], timestamp: params.startedAt });
  session.appendMessage(assistantMessage(WORKFLOW_PROVIDER, zero("workflow"), "Running…", params.startedAt + 1));
  session.appendSessionInfo(params.name);
  return {
    file: session.getSessionFile(),
    finish: (summary, at = Date.now()) =>
      void session.appendMessage(assistantMessage(WORKFLOW_PROVIDER, zero("workflow"), summary, at))
  };
}

