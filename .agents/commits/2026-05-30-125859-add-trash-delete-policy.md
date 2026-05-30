# Add trash deletion policy to personal pi resources

## Summary

This commit updates the personal pi resources package so deletion behavior is controlled from versioned resources rather than ad hoc global files.

## Included changes

- Keeps a version-controlled `AGENTS.md` placeholder for future global instructions.
- Adds a `trash-delete-policy` extension that tells the agent to use `trash <path>` instead of permanent delete commands and enforces the policy for agent-initiated `bash` tool calls.
- Registers the extension in the package manifest so it loads through the personal resources package.
- Leaves user-entered `!` and `!!` bash commands alone; the guard is intended to protect the user from agent actions, not block the user's own shell usage.
- Documents the available resources in the README.


## Design notes

The policy text lives in the `trash-delete-policy` extension instead of `AGENTS.md`, keeping the instruction and enforcement together in one resource. `AGENTS.md` remains present and symlinked globally as an empty placeholder for future instructions. The extension appends a concise deletion policy to the system prompt and blocks agent tool calls that attempt permanent deletion commands such as `rm`, `rmdir`, `unlink`, or `find ... -delete`.
