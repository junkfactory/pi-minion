# Troubleshooting

For known failure modes (exit143 causes, the workspace-mismatch fix, jobs not appearing, output caps,
extension load errors, and cross-extension tool confusion with
`get_subagent_result`/`Agent`/`steer_subagent`).

**"Pi minion failed (exit 143)." with no other detail.**
143 = 128 + SIGTERM: a killed `claude` process usually self-reports as a
plain exit code, not a Node-level signal, so this alone doesn't say *why*
it was killed. Two known causes, both already fixed to report their actual
reason instead of a bare exit code:

- Genuine `timeoutMs` expiry — now reported as "timed out before
  finishing," pointing at the job's `stdout.json` for partial output.
- The extension's own `session_shutdown` handler used to kill every running
  job on *any* shutdown reason — but `/reload`, `/new`, resuming, or
  forking a session all fire `session_shutdown` too, not just quitting Pi.
  Now only `reason === "quit"` stops jobs; the others leave the minion's
  independent child process running.

If you see a bare "exit 143" again, it's a new cause — check `stderr.log`
in the job's directory (`~/.pi/agent/pi-minion/<id>/`) first.

**`get_subagent_result` / `Agent` / `steer_subagent` say a pi-minion job is
"not found", even though it's still running (or already finished
successfully).**
Those three tools are not part of pi-minion — they belong to a completely
separate, unrelated extension (`pi-subagents`, published as
`@tintinweb/pi-subagents`) that implements its own generic subagent
orchestration with its own disjoint job registry. It has never heard of a
job id returned by `run_pi_minion`, so any lookup against it for that id
throws `Agent not found: <id>. It may have been cleaned up.` — a correct
answer for *its own* registry, but not a statement about the pi-minion job.
This is tool-name confusion (both extensions describe "a subagent job" in
similar language), not a bug in either extension's own state tracking.

pi-minion has no *result-fetch* tool of its own by design: a
`run_pi_minion` job's completion (full result, cost/token breakdown,
`output_path`) posts automatically to the transcript via
`pi.sendMessage(...)`/`pi.appendEntry(...)` the moment the minion process
exits — nothing needs to be polled. To check on a job before it finishes,
use the `/pi-minions` command (default shortcut `alt+j`) to open the live
picker/detail modal instead of calling another extension's tool with the
job's id. `list_pi_minions` does surface recently finished jobs (id,
title, model, effort, status, `reportPath`) so a follow-up call can find
and read a prior job's actual result file — but it still only hands back
that metadata, not the result content itself.

**"workspace must be the current Pi workspace" — intermittent.**
`run_pi_minion` no longer accepts a `workspace` parameter from the caller;
`execute()` fills it in from `ctx.cwd` directly, so this specific message
should no longer occur. If it does, something is constructing a
`MinionRequest` outside `execute()` — check for a new call site instead of
assuming the model is at fault.

**A job never shows up in `/pi-minions` or the widget.**
Confirm `startJob()` actually reached `jobUI.setJob(...)` — check
`validateRequest()` didn't reject the request first (thrown errors there
surface as a tool-call error, not a running job). Also check
`~/.pi/agent/pi-minion/<id>/stderr.log` for a spawn-level failure (e.g.
`command` not on `PATH`), and `~/.pi/agent/pi-minion/pi-minion.log` for a `started`
line with that job's id.

**The widget shows nothing even though a job is genuinely running (job
otherwise works fine — `/pi-minions` still lists it, its result still
posts).** Previously a real bug: `jobUI` is a process-lifetime singleton
that used to close over the *first* `ctx` it was ever given. Once that
session went through `/reload`, `/new`, a fork, or `switchSession`, that
`ctx` went permanently stale, `ctx.ui.setWidget(...)` started throwing, and
the failure was silently swallowed — so the widget could never render
again for the rest of the pi process, even for brand-new jobs. Fixed:
`jobUI.setCtx(ctx)` is now called with a fresh `ctx` on every tool/command
call and on Pi's `session_start` event (fired right after every such
replacement), and a failed registration attempt resets its own guard so
the next call retries instead of giving up forever. If this recurs, check
`~/.pi/agent/pi-minion/pi-minion.log` for a `started` line with no matching widget
row, and suspect the same class of bug first — something making `ctx.ui.*`
throw and go unnoticed.

**pi crashes with "This extension ctx is stale after session replacement
or reload" from `postResult`.** Previously a real bug, the `pi` sibling of
the stale-ctx one above: a job posted its result through the `pi` captured
when it started, and Pi makes that handle throw once its session is
replaced (`/reload`, `/new`, fork, resume). A job or schedule tick spanning
one crashed the whole process when it finished. Fixed: each session start
binds its fresh `pi` by session id, `postResult` looks up the job's owner at
post time, and a replacement's `session_start` rehomes the replaced
session's jobs, schedules and workflows onto it. A result whose owner has
quit is not posted (it's still in `result.md` and the child session).

**A result or workflow summary went missing after `/new`, fork, or resume.**
Previously a real gap: between the old session's `session_shutdown` (which
releases its handle) and the replacement's `session_start` (which rehomes
and binds), a job or workflow that finished posted to a session with no
handle and was silently dropped — a one-off workflow then never started its
turn. A job that was still starting in that window could also record the old
session id after `rehomeJobs` ran. Fixed: a non-quit shutdown holds that
session's posts until its replacement binds, and a replaced id resolves to
its replacement (`resolveSessionId`), both for posts and for a job recorded
mid-replacement. A session that really quit still drops them.

**The widget's preview line (or the open modal) shows nothing new for a
long stretch, even though `stdout.json` is visibly growing.**
A different bug from the stale-ctx one above — this one was in what
`consumeLine` reacts to, not in the widget plumbing. Before the fix,
`consumeLine` only updated the preview/modal on a `text_delta` (real
assistant text) or, once, on the very first `thinking_delta` (a one-shot
placeholder). A minion job commonly spends minutes calling tools (`Bash`,
`Read`, etc.) with no `text_delta` and no further `thinking_delta` updates
in between — during that stretch the preview/modal had nothing to update
from and stayed frozen on the one-shot placeholder, no matter how much real
work streamed into `stdout.json`. Fixed by also reacting to
`content_block_start`/`tool_use` events (`toolUseStarted()`), showing
`Using <ToolName>…` for the widget and a `⚙ <ToolName>` marker in the
modal. If this recurs, check whether the frozen stretch corresponds to a
tool-call-heavy phase (`grep -c '"tool_use"' stdout.json`) — if so, suspect
this class of bug again. The `text_delta` path itself was verified correct
by replaying the real parsing functions against a live job's `stdout.json`
end-to-end, so a freeze *after* real text has already started streaming
points at something new, not this.

**A minion is burning tokens in what looks like a stuck loop (or collecting
permission denials), and you only find out when it finishes.**
Nothing alerts mid-run by design — pi-minion is fire-and-forget (no
status/result-check tool, no mid-run surface), so the only signals today are
passive: open `/pi-minions` (default `alt+j`) and look at the live modal for
the same tool call repeating with identical args or erroring over and over,
or `grep '"tool_use"' stdout.json` in the job directory
(`~/.pi/agent/pi-minion/<id>/`) to count repeated calls from outside the
session. Permission denials notably stay invisible in the widget/modal and
surface only in the final result's denial warning (see
`sawPermissionDenial` in `src/job-runner.ts`). If you spot a loop, cancel
with `cancel_pi_minion` and re-run with the same `context` plus the
correction — any edits already made are on disk in the workspace, so the
re-spawn loses little. A proactive mid-run push (notify on a repeated
same-args error loop or a permission denial, instead of waiting for the
final report) is the identified cheap-observability improvement here —
tabled for now, not implemented; if you find yourself opening `alt+j` to
snoop for loops regularly, that is the signal to pick it up.

**Job output is missing past a certain point.**
Check whether `maxOutputBytes` was hit (`exceededOutputLimit` in the
result message) — raise it in `pi-minion.json` if legitimate runs need
more headroom, or read `stdout.json` directly for what was captured before
the cutoff.

**The `/pi-minions` shortcut (default `alt+j`) doesn't fire.**
Pi snapshots every extension's registered shortcuts exactly once, right
after the extension factory function returns — before any later
microtask or I/O continuation runs. Registering the shortcut from inside
an awaited `loadConfig().then(...)` callback loses that race: the
snapshot is taken before the callback resolves, so the shortcut is
silently never picked up (no error anywhere). Fixed by resolving the
shortcut with a synchronous file read (`readShortcutConfigSync()`) and
calling `pi.registerShortcut()` directly in the factory body, before any
`await`. If the shortcut stops firing again, suspect the same class of
bug first: something upstream of the registration call went async.
Also check for an actual key collision — `pi.getShortcutDiagnostics()`-style
conflicts are only logged to the console outside a TUI session, so a
colliding `~/.pi/agent/keybindings.json` entry can silently win instead.

**Extension fails to load after an edit.**
`pi -e ./src/pi-minion.ts -p "..."` surfaces load errors (e.g. `ParseError`) with
file/line — use it to isolate a syntax or type error before assuming the
failure is in extension logic.

**A change to `~/.pi/agent/extensions/pi-minion.json` doesn't seem to
apply.**
That's the optional user-override file, merged over the built-in
`pi-minion.json` — present keys win, absent ones fall through. If it's
malformed JSON or not a JSON object, it's silently ignored (falling back to
the built-in config) with a `console.error` warning; like the shortcut
collision case above, that warning is only visible outside an interactive
TUI session (headless run or captured stderr), so check there first.

**`run_pi_minion` throws `Invalid pi-minion configuration (after merging
... over ...)`.**
`loadConfig()` throws this once the merged config is missing (or has the
wrong type for) `models` or `allowedTools`. Two ways to hit it:

- The override file at `~/.pi/agent/extensions/pi-minion.json` is valid
  JSON but sets one of those two fields to something falsy or
  wrong-shaped (e.g. `models.allowed` as a string instead of an array) —
  fix the override.
- You edited `pi-minion.json`'s required fields (added/removed/renamed
  one) in `src/config.ts` and/or the bundled `pi-minion.json` in a pi session
  that was already running — extensions load once per process (see the
  `jobUI`/`jobMeta` state in `src/job-store.ts`), so the running
  process can still hold the old validation code (or old config shape)
  while reading the new file on disk. `/reload` or restart pi after any
  change to the config schema.

**A clean-exit result shows `[Showing lines 1-N of M ...]` instead of the
full text.**
Expected once a result exceeds `maxResultPreviewBytes` (default 50KB) — the
full result is written to `<jobDir>/result.md` and only a line-capped
preview is inlined into the primary session's context, to avoid burning
tokens on a large payload the caller may not need in full. Read
`result.md` directly (from the `offset` the notice names) for the rest, or
raise `maxResultPreviewBytes` in `pi-minion.json` if truncation is
undesired for your workload.
