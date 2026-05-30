# Globalize isolated commit extension

The user wanted the newly implemented `/commit` extension to be available from their global Pi user resources rather than only from the scratch development directory. A reload had not made the command appear because the implementation still lived outside the installed user package manifest.

This commit replaces the older single-file `extensions/commit.ts` implementation with the newer directory-based implementation under `extensions/commit/`. The new implementation follows the `pi-subagents`-style architecture discussed earlier: the public `/commit` command forks the active session branch and starts a separate Pi RPC child process loaded only with a commit-specific runtime extension. That keeps the commit agent's tool calls and reasoning out of the parent conversation while preserving the active branch context needed to infer commit scope.

The package manifest now explicitly loads the commit entrypoint alongside the existing exit and minimal-footer extensions. The README package-filtering example was updated to point at `extensions/commit/index.ts`, matching the new layout.

Key behavioral choices preserved in the globalized extension:

- Push is never inferred. `/commit push` is parsed as explicit push intent, ambiguous push language can trigger an authorization tool, and unauthorized `git push` commands are blocked in the child runtime.
- The parent session verifies the reported commit and computes line counts before writing the durable confirmation.
- While a commit run is active, Enter steers the commit child and Alt+Enter queues normal parent follow-up work.
- The child runtime is launched with discovered extensions, skills, and prompt templates disabled so the commit workflow has a narrow tool and prompt surface.

This commit intentionally does not include the scratch `commit_extention_dev` package files. The durable global source of the extension is the user resources package at `/Users/mosius/.pi/user-resources/mosius`.
