# Add minimal footer extension

## Summary

Adds a personal pi extension that replaces the default footer with a compact, single-line layout. The footer keeps the current working directory, git branch/session context, context-window usage, and current model/thinking information while removing token, cache, cost, and auto-compaction details that are not useful for the subscription-based workflow.

## Context

The default footer exposed useful information, but input/output token totals, cache statistics, cost, and auto-compaction status created noise. Context usage remained important, especially with its warning/error color behavior. The right-side model and thinking display was also useful and should remain close to the built-in behavior.

## Decisions

- Store the extension under `extensions/` in this personal resources package so it is git-tracked and loaded globally through the package configuration.
- Expose `./extensions` from `package.json` alongside existing skills.
- Use a one-line layout:
  - left-aligned working directory, git branch, and session name
  - centered context usage with warning/error coloring
  - right-aligned provider/model/thinking display
- Omit the extension status line from the custom footer to keep the footer minimal.

## Risks and follow-up

The extension mirrors some built-in footer formatting logic. If pi changes its footer APIs or model/thinking metadata shape in the future, this extension may need to be adjusted.
