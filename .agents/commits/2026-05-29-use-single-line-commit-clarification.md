# Use single-line commit clarification prompts

## Context

The side-channel `/commit` workflow can pause when the commit agent needs clarification. After the command handler was made non-blocking, the previous multi-line extension editor could be unreliable when opened from the background task: answering and pressing Enter did not visibly resume the workflow.

## Change

The clarification step now uses `ctx.ui.input()` instead of `ctx.ui.editor()`.

While waiting for an answer, the command updates the commit status and below-editor progress widget with the clarification reason and questions. The input prompt asks for a single-line answer, with an empty response still cancelling the commit. The restart notification was also simplified to remove the side-channel wording.

## Why

A single-line input is better suited to background clarification because it avoids replacing the full editor with a multi-line editor while normal chat input may also be active. This keeps the non-blocking commit workflow responsive while preserving the ability for the side agent to ask follow-up questions before staging or committing.
