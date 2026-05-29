# Add commit agent progress feedback

## Context

The `/commit` command now delegates the actual git work to an isolated side-channel pi process. That keeps repository discovery, diff inspection, rationale writing, staging, and committing out of the main conversation branch. However, because the side agent can take a while to inspect context and run git commands, the parent UI previously looked idle after the initial notification.

## Change

This update replaces the opaque `pi.exec` call with a spawned child process so stdout and stderr can be observed while the side agent is still running. The command now keeps a `commit` footer status updated with a compact snippet from the latest child-process output, starting with `commit: starting side agent` and updating roughly every 750ms as output arrives.

The clarification loop also reports `commit: restarting with clarification` before re-running the side agent with accumulated answers.

## Rationale

A side-channel commit flow should remain isolated, but not silent. Streaming a compact progress signal back to the parent UI gives the user confidence that the side agent is active without exposing the full git inspection or rationale-writing noise into the main conversation. Keeping the status as a transient footer also preserves the clean final shape of the interaction: the main thread receives only the result, failure, or clarification prompt.

## Safety

The progress text is limited to the latest non-empty line and truncated to 120 characters. The full side-agent output is still captured internally for JSON parsing and error reporting, while the status is cleared once the command finishes, is cancelled, or throws.
