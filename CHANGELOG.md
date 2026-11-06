# Changelog

## [0.1.0]

- Aligned dev dependencies with pi 1.5.0.
- A workflow step that fails, or reports its packet unworkable by ending its reply with a one-line reason then `[[STEP_BLOCKED]]`, now aborts the entire run: running steps are cancelled, pending steps are skipped. The single summary starts a turn carrying that reason in a `**Needs attention:**` line, so the packet can be revised and the workflow re-run; the interim mid-run failure alert (`formatWorkflowAlert`) is removed. The abort note trims a trailing period from the step's reason so it reads as one sentence.
