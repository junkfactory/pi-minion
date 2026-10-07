# Testing SOP

Verification for pi-minion changes, in two layers: the unit suite (fast,
mocks the spawned-process path) and a live battery run against a real Pi
session (exercises the real tools end to end). Behavioral changes need both;
UI changes additionally need the interactive checks at the bottom.

## Unit suite

```bash
npm run check   # tsc --noEmit
npm run test    # node --import jiti/register --test "test/**/*.test.ts"
```

There is no build step — Pi loads `src/pi-minion.ts` directly via its own TS
loader, so the suite runs against source.

## Live smoke battery

Standard end-to-end battery for behavioral changes: job lifecycle, model
routing/filtering, workflow scheduling, status and error reporting. Budget:
≈ $0.01, ≈ 3 minutes.

### Preconditions

- Source changes: `/reload` the session first (extension modules load at
  session start). Config changes need **no** reload — `help_pi_minion` and
  the run path call `loadConfig()` per invocation.
- Models: pick cheap ones from `help_pi_minion` (e.g. `deepseek-v4-flash`,
  `opencode-go/luna`), `effort: "low"`, `maxBudgetUsd` ≤ 1 per cell.
- Results post automatically; track jobs with `list_pi_minions` /
  `list_pi_minion_workflows` — never poll.

### 1. Baseline: models list

Call `help_pi_minion` and record the count. Aliases come first, then
concrete ids; adapters whose CLI is absent from `PATH` contribute nothing
(no claude aliases and no agy entries on a machine without those binaries).
Reference-machine baseline: **44 models**.

### 2. Four-cell matrix

| Cell                | Call                                                                                                                                                                                | Expected                                                                                                                                        |
|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| standalone positive | `run_pi_minion` — `model: "deepseek-v4-flash"`, `effort: "low"`, `maxBudgetUsd: 0.5`, task: run `pwd` and `node --version`, reply exactly `DIR=<pwd> NODE=<version>`                | Posted result contains that single `DIR=… NODE=…` line, frontmatter with model, token usage, `cost_usd`, and a `result.md` link                 |
| standalone negative | `run_pi_minion` — `model: "bogus-model"`, trivial task                                                                                                                              | Immediate `Unknown model "bogus-model". Call help_pi_minion for the models usable here.` — no job id, nothing posted later                      |
| workflow positive   | Two-step workflow: `uname` runs `uname -s` (`deepseek-v4-flash`); `ack` (`opencode-go/luna`, `dependsOn: ["uname"]`) embeds `{{steps.uname.result}}` and replies `RECEIVED:<value>` | Summary "2 done"; reading the two `reportPath`s shows `Darwin` (or host value) then `RECEIVED:<that value>`; summary lists two different models |
| workflow negative   | Workflow: step `bad` with `model: "bogus-model"`; step `after` with `dependsOn: ["bad"]`                                                                                            | Summary "1 failed, 1 skipped"; `bad` carries the inline `Unknown model…` reason; `after` is `skipped`                                           |

### 3. Provider filter (run when the `providers` config changed)

1. Create `~/.pi/agent/extensions/pi-minion.json` with
   `{"providers": {"blocked": ["opencode-go"]}}`.
2. Call `help_pi_minion`: models backed by that provider must be gone
   (shared aliases too — the every-backing-provider rule hides a string if
   *any* entry matches). On the reference machine the whole catalog is
   `opencode-go` (30/30 ids), so the list becomes `[]` — correct, not a
   breakage; machines with mixed providers should lose only that
   provider's rows.
3. Run-time gate: `run_pi_minion` with a blocked model must fail with
   `Model <model> is excluded by the providers config (providers: …).
   Call help_pi_minion for the models usable here.`
4. Delete the override and call `help_pi_minion` again: the baseline list
   must return byte-for-byte (proves the diff came from config, not from
   broken enumeration).

## Interactive TUI smoke

Run against a real Pi session before considering interactive/TUI changes
(colors, keyboard handling, overlay sizing) verified — the unit tests mock
`ctx`/`tui` and can't observe real terminal rendering:

```bash
pi -e ./src/pi-minion.ts -p "some prompt that exercises the change"
```

## Manual checklist for UI changes (widget, picker, modal)

- Widget appears on job start, ticks live, clears when the job finishes.
- Multiple concurrent jobs keep a stable order and get a "+N more" row once
  they exceed the widget's line cap.
- `/pi-minions` (and the shortcut) list running jobs and open the modal.
- Modal scrolls with arrow keys (shift+↑/↓ to page), closes on Escape, and its border color
  matches the job's own resolved thinking level (not the main session's).
- A modal left open when its job finishes shows a `finished` marker and
  stays open/scrollable — it does not auto-close.

## Pass criteria

- Unit suite green on the same tree (468 tests at the last run).
- All four matrix cells match their expected outcomes; step contents read
  from `reportPath`, not just the summary statuses.
- Baseline list restored after the config undo.
- TUI/UI changes: the interactive smoke and checklist pass on a real
  terminal.

## Execution log

- 2026-10-07 — providers filter feature: matrix 4/4 green; provider block
  emptied the list as designed; undo restored 44/44; run-time gate proven
  by unit tests (mutation-checked `.every` regression test).
- 2026-10-07 — refresh-retry + agy stale-keeps (`f47e`): matrix 4/4 green
  on the reload; `Unknown model` path exercised through the new awaited
  catalog refresh.
