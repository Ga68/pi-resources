# Add main-thread commit confirmation

## Context

The `/commit` extension now runs the commit workflow in a background side agent with progress shown outside the main conversation. That keeps inspection and git noise out of the chat, but it also means the conversation can otherwise lack a durable marker that a commit actually happened.

## Changes

- Renamed the initial notification from side-channel terminology to `Running commit agent...`.
- Added a displayed custom message after successful commits so the main thread records a compact confirmation.
- Included commit metadata in the injected custom message details while keeping the visible content brief.

## Rationale

A background commit command should stay quiet about implementation details while still leaving the user with an explicit, visible success marker in the active thread. The custom message provides that marker without exposing repository diffs, rationale text, or side-agent internals.
