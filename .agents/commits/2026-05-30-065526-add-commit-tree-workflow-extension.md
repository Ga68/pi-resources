# Add commit-tree workflow extension

## Context

The existing `/commit` command uses an isolated child Pi process so commit-related tool calls and reasoning do not appear in the main conversation. The user wanted an alternate workflow that intentionally keeps the commit work as an abandoned branch in the conversation tree: save the current node, run the commit flow as normal in-session turns, roll back to the saved node, and leave only a compact durable confirmation on the main path.

This commit adds that `/commit-tree` variant to the personal global Pi package in `~/.pi/user-resources/mosius`.

## What changed

- Added `extensions/commit-tree.ts`, registering `/commit-tree` and commit-specific tools:
  - `ask_commit_tree_user`
  - `authorize_commit_tree_push`
  - `finish_commit_tree`
- Registered the new extension in `package.json` so global reloads load it.
- Documented the new command in the package README.
- Added a wait-for-`agent_end` mechanism because `pi.sendUserMessage()` is fire-and-forget; without this, the command could verify before the commit-agent turn had actually finished.
- Kept push behavior conservative: pushes are blocked unless explicitly requested or explicitly authorized in the workflow.

## Design notes

This is deliberately not as isolated as `/commit`. The point is to preserve the commit workflow as a navigable tree branch rather than hiding it in a child session. That branch can later be inspected in `/tree`, while the active conversation path gets restored to the original node with only the one-line commit confirmation appended.

The command labels successful abandoned leaves as `commit: <subject>` and failed ones as `failed commit-tree run` to make the tree easier to navigate.

## Known tradeoffs

The workflow depends on the commit-agent turn actually calling `finish_commit_tree`; the parent extension still verifies Git state afterward, but a missing report or repo inference failure will fail the workflow and roll back to the saved node. The prompt now explicitly tells the agent that the current Pi cwd may not be the target repository, which matters for global/user-resource commands run from unrelated projects.
