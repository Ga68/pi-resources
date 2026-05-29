# Simplify commit progress messages

## Context

The side-channel `/commit` command now streams live progress from the spawned pi process, but the first visible version surfaced too many low-level implementation events. In practice the UI showed repetitive messages such as `finished bash` and raw command execution details, which made the progress widget noisy and less helpful while the commit agent worked.

## Changes

- Replaced raw tool progress strings with human-oriented phase names.
- Mapped common git commands to concise commit workflow phases such as inspecting the working tree, reviewing changes, staging selected changes, creating the commit, and pushing.
- Suppressed unrecognized tool events instead of showing generic or noisy fallback messages.
- Removed `tool_execution_end` progress updates so completed tool calls no longer overwrite useful phase messages with `finished ...` noise.

## Result

The visible commit progress widget now focuses on durable, user-readable workflow stages instead of transient tool mechanics. This keeps the UI responsive without distracting users with implementation details from the side agent.
