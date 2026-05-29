# Stream side-channel commit progress

## Summary

This change updates the `/commit` extension so the side-channel commit agent runs pi in JSON event-stream mode and reports live, semantic progress back to the parent UI while it works.

## Motivation

The previous implementation spawned the side agent with print-style output handling. In practice, that meant the parent conversation only showed an initial “Starting side-channel commit agent...” notification until the child process finished, which made longer commit runs look hung. The user asked for visible progress stages such as inspecting repositories, writing rationale, staging changes, and committing.

## What changed

- Run the child pi process with `--mode json` so the extension can observe live session events instead of waiting for final output.
- Parse JSON-line events from stdout while still retaining stderr/raw output for failures.
- Surface tool execution progress in the footer, including bash/read/write/edit activity.
- Parse side-agent `PROGRESS:` markers from streaming assistant deltas and display those semantic phases directly.
- Preserve final result parsing by extracting the final assistant text from the side agent’s `message_end` event.
- Update the side-agent prompt to require progress markers before major phases while still returning one final JSON result.

## Safety and behavior

The side agent remains isolated from the main conversation: git inspection, rationale writing, staging, committing, and any optional push still happen in the child pi process. The parent command now receives enough event data to reassure the user that work is happening without injecting the side agent’s detailed tool results into the main conversation.
