# Run commit agent in the background

## Summary

This change makes the `/commit` command start the side-channel commit workflow without blocking the main pi command handler. The commit agent still reports visible progress and handles clarification, but normal chat input can continue while the side process inspects, stages, and commits work.

## Motivation

While testing the side-channel commit flow, sending a normal message during an active commit appeared to submit and then disappear. The root cause was that the slash-command handler awaited the entire side-agent process, tying up the command/input path until the commit completed. Since the commit workflow can include repository discovery, diff inspection, rationale writing, and clarification loops, it should behave like a background task from the user's perspective.

## Implementation

- Moved the commit workflow into a `runCommitFlow` helper scoped inside the extension.
- The registered command now sets a `running` guard, launches `runCommitFlow(...)` with `void`, and returns immediately.
- Progress updates continue through both `ctx.ui.setStatus` and the visible `commit-progress` widget.
- Cleanup clears both the footer status and widget on completion, cancellation, or error.
- The running guard prevents overlapping commit agents and resets in a `finally` block once the background flow ends.

## Result

The side-channel commit agent can continue working and reporting progress without blocking normal chat input. If it needs clarification, the editor prompt can still appear later as part of the background workflow.