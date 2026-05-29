# Add side-channel commit command

## Summary

Adds a pi extension command, `/commit`, that performs the commit workflow outside the main conversation context. The command accepts optional free-text instructions, inspects git state internally, performs safety checks, stages changes, writes a rationale file by default, commits, and optionally pushes when requested.

## Context

The previous commit skill encoded the workflow directly in the model context. That made routine commits noisy because git status, diffs, staged diffs, and scan output all appeared in the main thread. The desired behavior is to keep those operational details on the side and return only a concise completion signal unless clarification is required.

## Included changes

- Adds `extensions/commit.ts` with a globally loaded `/commit` command.
- Preserves the existing commit-skill principles in extension code: inspect first, avoid pushing unless requested, scan for suspicious secrets, write rationale files, and use imperative commit subjects.
- Keeps the command parameter optional so `/commit` is sufficient for the common case.

## Decisions

- Use a slash command rather than a model-routed skill for the main workflow to keep usage explicit and predictable.
- Let free-text command arguments steer behavior such as `push`, `don't push`, `message only`, or `no rationale`.
- Ask for confirmation only when a risky condition is detected, such as suspicious secret-like content.
- Generate a rationale file by default to preserve context without filling the chat transcript.

## Risks and follow-up

The first version uses lightweight heuristics for commit subject inference and scope selection. It currently stages detected working-tree changes as a unit. Future iterations could add an interactive scope picker, hunk staging, better commit subject generation, and an explicit dry-run/message-preview mode.
