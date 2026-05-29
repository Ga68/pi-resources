# Run commit workflow in a side agent

## Summary

Replaces the in-process `/commit` implementation with a thin orchestrator that launches an isolated pi side agent to perform repository discovery, git inspection, rationale writing, staging, committing, and optional pushing.

## Context

The commit workflow should not pollute the active conversation with git status, diffs, staging output, or rationale-drafting steps. The earlier extension-based implementation moved work out of normal assistant tool calls, but still relied on local heuristics and later risked context-window failures when the full branch was embedded directly in the side-agent prompt.

## Decisions

- Keep `/commit` as an extension command, but delegate the actual workflow to `pi --no-session --no-extensions --no-skills --no-prompt-templates`.
- Write the active branch JSON to a temporary file and pass only the file path to the side agent, so the agent can inspect full conversation context without overflowing the initial model request.
- Provide configured local pi package paths and the parent cwd as explicit hints for repository discovery.
- Require the side agent to return a small JSON result so the parent conversation receives only a concise commit result, failure, or clarification request.
- Add a clarification loop so the side agent can ask questions and then be restarted with the user's answers before committing.
- Remove the old commit skill documentation because `/commit` now owns this workflow as a side-channel extension.

## Safety

The side-agent prompt preserves the important commit safety constraints: infer scope from conversation and working trees, avoid guessing across unrelated repositories, inspect diffs before staging, never push unless explicitly requested, avoid committing secrets, stage only intended changes, and write rationale files for meaningful changes.

## Follow-up

The extension currently shells out to the `pi` CLI and parses a JSON object from stdout/stderr. If pi later exposes an extension API for ephemeral side sessions or structured subagent execution, this command could move to that API while keeping the same user-facing behavior.
