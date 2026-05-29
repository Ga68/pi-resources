# Add `/exit` command alias

## Context
The user wanted `/exit` to behave the same way as pi's built-in `/quit` command, and asked that the change live in the existing configured resources package.

## Change
Added a user resources extension at `extensions/exit.ts` that registers an `exit` slash command. The handler calls `ctx.shutdown()`, using pi's extension shutdown API so `/exit` follows the same graceful shutdown path as other interactive quit triggers.

## Scope
The commit intentionally includes only the new `/exit` extension and this rationale. An unrelated local modification to `extensions/commit.ts` was left unstaged.
