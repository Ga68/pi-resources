# Refactor commit extension to isolated SDK agent

## Summary

Rewrites the `/commit` extension around a simpler isolated-agent model. Instead of spawning a separate `pi` CLI process, parsing child-process JSON, or duplicating commit-planning logic in the extension, the command now creates an in-memory SDK `AgentSession`, loads the active conversation branch into it, and asks that side agent to perform the commit workflow as if it were taking the next turn.

## Context

The previous implementation had drifted through several experimental designs: direct git orchestration, spawned CLI side agents, streamed JSON parsing, background execution, and SDK planning. That made the extension hard to reason about and brittle. The desired behavior is simpler: `/commit` should run an isolated full-power agent with the existing conversation context, let that agent inspect git and commit as needed, and keep all of that operational chatter out of the main thread.

## Included changes

- Removes the spawned `pi --mode json` child-process implementation.
- Removes temp branch-file handoff and child-process event parsing.
- Adds an SDK-based isolated commit agent using `createAgentSession()` and `SessionManager.inMemory()`.
- Copies the current active branch messages into the side session so the side agent has the conversation context.
- Keeps a minimal resource loader so the side agent does not load user extensions, skills, prompts, themes, or context files recursively.
- Preserves progress reporting through concise `PROGRESS:` markers and mapped tool phases.
- Preserves clarification loops, compact completion notifications, and a durable main-thread commit marker.

## Decisions

- Keep `/commit` explicit and awaited so messages typed during commit should queue more naturally.
- Let the side agent own the actual commit workflow: infer scope, inspect repositories, write rationale, stage, commit, and optionally push.
- Keep the parent extension focused on orchestration, progress display, clarification UI, and final result handling.
- Push only when the `/commit` instructions explicitly request it.

## Risks and follow-up

The isolated SDK agent now has normal commit-tool authority, so its system prompt is intentionally strict about scope, secrets, staging, rationale files, and pushing. This should be tested through `/reload` and `/commit`, especially around clarification, queued user input, and multi-repository conversations.
