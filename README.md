# pi-minion

A Pi extension that delegates tasks to a background `claude -p` minion process,
so the primary session isn't blocked while the minion works.

- **Tool:** `run_pi_minion(task, model, effort?, context, maxBudgetUsd?)` — spawns
  `claude -p --permission-mode auto ...` as a detached child process and
  returns immediately with a job ID. The result is delivered later via
  `pi.sendMessage(...)` plus a collapsible `pi-minion-display` transcript
  entry — there is no `run_pi_minion`-side status/result-check tool by
  design; see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) if a *different*
  extension's subagent tools (`get_subagent_result`, `Agent`,
  `steer_subagent`) are used against a pi-minion job id by mistake. Each job
  is stateless, so `context` is required on every call; it must either
  restate the real prior findings/decisions this task depends on verbatim, or
  be exactly `"No prior context."` — combining that escape hatch with other
  details is rejected.
- **Tool:** `list_pi_minions()` — lists this session's pi-minion jobs in the
  current workspace, both running and recently finished, with each job's
  `id`/`title`/`model`/`effort`/`status`/`reportPath`. Use it to recover a job
  id after context compaction, or to find a finished job's `reportPath`
  before writing `context` for a follow-up task.
- **Tool:** `schedule_pi_minion(task, model, effort?, context, maxBudgetUsd?, cron)`
  — runs the same request on a cron schedule (local time, 5 or 6 fields, via
  [croner](https://github.com/hexagon/croner)). Each tick starts an ordinary
  `run_pi_minion` job whose result posts to the transcript and context
  without starting a main-agent turn (it's picked up on your next prompt); a
  spawn failure still starts one. A tick is skipped (and logged
  `status=skipped`) while the previous run is still going. Schedules live in
  memory only and stop when their session quits. Each run is told it can end
  the schedule by finishing its reply with `[[STOP_SCHEDULE]]` alone on the
  last line once the goal is fully complete; that run's result posts with a
  "Schedule stopped" note and does start a turn (logged
  `status=unscheduled`, `self_stop`).
- **Tools:** `list_pi_minion_schedules()` / `cancel_pi_minion_schedule(id)`
  — list or stop this session's schedules. Stopping a schedule doesn't kill
  a run already in progress; use `cancel_pi_minion` with its `lastJobId`
  (or `cancel_pi_minion_workflow` with `lastWorkflowId` for a workflow
  schedule).
- **Tool:** `run_pi_minion_workflow(title, context, maxBudgetUsd?, steps)` —
  runs a small dependency graph of minion jobs (`steps: [{ id, task, model,
  effort?, dependsOn?, maxBudgetUsd? }]`, at most 10). A step starts as soon
  as its own `dependsOn` steps are done (up to 4 run at once) and receives
  their results: each is placed where the task says `{{steps.<id>.result}}`
  (the id must be in its `dependsOn`), and any dependency without a
  placeholder is appended as `Result of step <id>:` at the end. A large result
  becomes a preview plus a pointer to its file; one step's inlined results
  together stay within `maxResultPreviewBytes`, split across its dependencies
  (a `dependsOn` listing the same id twice is rejected).
  Before anything spawns, a confirm dialog lists the steps grouped into
  stages with their models, efforts, waits, and the total budget (it starts on
  "No"); declining runs nothing, and a session without a UI refuses. The
  budget cap sums only steps whose agent enforces `maxBudgetUsd`; steps on pi
  or agy are marked "no cost ceiling" and counted separately. Each step posts
  only a short stub (frontmatter and report link) quietly, and one summary at
  the end (per-step status, model, `reportPath`) starts the single main-agent
  turn. A failed, skipped, or cancelled step skips its
  dependents while independent branches keep going. Either the agent proposes
  a workflow in chat first, or you ask for one ("use a workflow ..."). Workflows
  live in memory only and stop when their session quits.
- **Tools:** `list_pi_minion_workflows()` / `cancel_pi_minion_workflow(id)`
  — list this session's workflows (status plus each step's `jobId` and
  `reportPath`), or cancel one: pending steps are cancelled, running steps are
  stopped, and the summary posts quietly.
- **Tool:** `schedule_pi_minion_workflow(title, context, maxBudgetUsd?, steps, cron)`
  — `run_pi_minion_workflow` on a cron schedule. The graph, every step, and
  the cron are checked once up front, and the confirm dialog (which adds the
  cron, next run, and per-run budget) is the only approval: later ticks never
  ask again. Each tick starts a fresh workflow, skipped (logged
  `status=skipped`) while the previous one is still going; its summary posts
  without starting a turn unless no step of the run succeeded, in which case
  it starts one and says so. Each step's budget cap is fixed when the schedule
  is approved, not re-read from `pi-minion.json` on later runs. The workflow
  must have exactly one final step
  (one no other step depends on); only it is told it can end the schedule with
  `[[STOP_SCHEDULE]]`, and if it does, that summary posts with a
  "Schedule stopped" note and starts a turn (logged `status=unscheduled`,
  `self_stop`). `list_pi_minion_schedules` shows `kind` and `lastWorkflowId`,
  the picker marks these rows `⏱⛓`, and `cancel_pi_minion_schedule` stops
  future ticks. A session without a UI refuses.
- **Command / shortcut:** `/pi-minions` (default key `alt+j`, see
  `shortcut` in `pi-minion.json`) opens a picker over currently running
  jobs (including runs started by a schedule), then a scrollable detail
  modal with the job's full streamed output. This session's schedules are
  listed after them as
  `⏱ <title> · <model> / <effort> · <cron> · next <time>`; picking one
  asks to stop it. Running workflows are listed first as
  `⛓ <title> · <done>/<total> steps · <running step ids>`; picking one asks
  to cancel it.
- **Live status widget:** an `aboveEditor` tree view lists running jobs with
  a spinner, elapsed time, and the latest streamed line, while any are in
  flight. The tree hangs from a `π minions · N jobs · N workflows` root
  row. A running workflow shows as a `⛓` row (stage, steps done, elapsed)
  with its steps nested under it: `○` pending, `✓` done, `✗` failed, `–`
  skipped/cancelled, and the running step's live row. Self-heals across `/reload`, `/new`, fork, and `switchSession` —
  a job that outlives one of those keeps rendering instead of going
  permanently blank (see TROUBLESHOOTING.md if it ever doesn't).
- **Lifecycle log:** `~/.pi/agent/pi-minion.log` gets one terse line per
  job started/exited/errored/cancelled, schedule scheduled/skipped/unscheduled,
  and workflow_started/finished/cancelled/declined
  (never stdout/stderr or UI events),
  rolled over to `pi-minion.log.1` once it would exceed 15MB.
- **Sub-sessions:** each finished job is written as a pi session (task as
  the user message, result plus per-model usage as assistant messages)
  named `<model>: <title>`, threaded under the calling session in
  `/resume`. If the calling session has no file (in-memory), it goes to
  `~/.pi/agent/sessions/pi-minion/<YYYY-MM>/` instead, which `/resume`
  doesn't list. Either way,
  [pi-usage-extension](https://github.com/tmustier/pi-extensions/tree/main/usage-extension)'s
  `/usage` shows its tokens/cost under provider `claude`/`agy`/`pi` with the real
  model id. A workflow gets its own `⛓ <title>` session under the calling
  session, written when it starts (its plan, then the summary when it
  finishes, at zero usage so `/usage` counts each step once), and its
  steps' sessions, named `<model>: <step id>`, thread under it. Never
  pruned: job pruning only removes `~/.pi/agent/pi-minion/<job id>/`.

## Installation

- Clone the [POC](https://gitlab.com/wisetackrepo/poc)
- Create a symlink to `~/.pi/agent/extensions/pi-minion` then restart/reload pi

  ```bash
  ln -s <path-to-poc>/pi/pi-minion ~/.pi/agent/extensions/pi-minion
  ```

## Using pi-minion

You can then prompt pi like

- Run a pi minion to explore this code base and summarize it
- Run a sonnet pi minion to debug this ticket
- Run an opus pi minion to review current changes at medium effort; budget $5
- Use a workflow: two sonnet agents review the current changes for bugs and performance, then a luna agent verifies their findings

## Configuration

`pi-minion.json`, at the package root:

| Field                   | Required     | Meaning                                                                                                                                               |
|-------------------------|--------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `defaultModel`          | yes          | Fallback model when a caller doesn't specify one.                                                                                                     |
| `allowedModels`         | yes          | Models `run_pi_minion` may request; anything else is rejected.                                                                                       |
| `allowedTools`          | yes          | Passed to the minion as `--allowedTools`; empty omits the flag.                                                                                         |
| `maxBudgetUsd`          | yes          | Default `--max-budget-usd`; the minion's cost ceiling. Overridable per call via the tool's `maxBudgetUsd` param.                                        |
| `timeoutMs`             | yes          | Kill the minion (`SIGTERM`, then `SIGKILL` after 5s) if it runs this long.                                                                              |
| `pruneAfterDays`        | no (7)       | Job directories under `~/.pi/agent/pi-minion/` older than this are deleted at startup.                                                               |
| `maxOutputBytes`        | no (15MB)    | Disk/runaway backstop — kills the minion if its combined stdout+stderr exceeds this. Not a cost control; `maxBudgetUsd` covers that.                    |
| `maxResultPreviewBytes` | no (50KB)    | Caps how much of a clean-exit result is inlined into the primary session's context; past this it's truncated with a pointer to the full text on disk. |
| `shortcut`              | no (`alt+j`) | Key bound to the `/pi-minions` picker.                                                                                                               |

An optional user override at `~/.pi/agent/extensions/pi-minion.json` is
shallow-merged over the built-in file above — present keys win (array
fields like `allowedModels` are replaced wholesale, not concatenated),
absent keys fall through to the built-in value. A malformed or non-object
override is ignored (with a `console.error` warning) rather than failing
the extension.

## Development

```bash
npm run check   # tsc --noEmit
npm run test    # node --import jiti/register --test "test/**/*.test.ts"
```

There is no build step — Pi loads `src/pi-minion.ts` directly via its own TS loader
(`package.json`'s `pi.extensions` field points at the source file, not a
compiled artifact).

**Adding a fix or feature:**

1. Edit the `src/` module that owns the concern — `job-runner.ts` (job lifecycle), `workflow-store.ts` / `workflow-runner.ts`
   (workflow graph, dialog text, step scheduling),
   `output-capture.ts` (stdout/stderr capture), `job-store.ts` (in-memory job
   state), `tools.ts` (tool registration), `config.ts`, `format.ts`, `log.ts`,
   `child-session.ts`, `modal.ts` (detail-view event replay), `pi-minion.ts`
   (extension wiring only) — or `agent.ui.ts` (widget, picker, modal — no
   domain logic).
2. Extract new decision/formatting logic into a small exported pure
   function and unit test it directly, rather than testing through the
   spawned-process path — see `describeJobResult`, `resolveShortcut`,
   `deriveJobTitle` for the established pattern (a `fake*()` helper builds
   the input, no mocking of `child_process` needed).
3. Run `npm run check && npm run test`.
4. Smoke-test against a real Pi session before considering interactive/TUI
   changes (colors, keyboard handling, overlay sizing) verified — the unit
   tests mock `ctx`/`tui` and can't observe real terminal rendering:

   ```bash
   pi -e ./src/pi-minion.ts -p "some prompt that exercises the change"
   ```

**Manual verification checklist for UI changes** (widget, picker, modal):

- Widget appears on job start, ticks live, clears when the job finishes.
- Multiple concurrent jobs keep a stable order and get a "+N more" row once
  they exceed the widget's line cap.
- `/pi-minions` (and the shortcut) list running jobs and open the modal.
- Modal scrolls with arrow keys (shift+↑/↓ to page), closes on Escape, and its border color
  matches the job's own resolved thinking level (not the main session's).
- A modal left open when its job finishes shows a `finished` marker and
  stays open/scrollable — it does not auto-close.

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for known failure modes (exit
143 causes, the workspace-mismatch fix, jobs not appearing, output caps,
extension load errors, and cross-extension tool confusion with
`get_subagent_result`/`Agent`/`steer_subagent`).

## Design history

Design rationale, rejected alternatives, and a running log of post-ship
fixes live in `jj`/git history on this file's predecessor — search commit
messages for the relevant symptom (e.g. "session_shutdown", "workspace",
"thinking level") rather than a separate living design doc.
