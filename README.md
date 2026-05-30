# mosius-pi-tools

Personal [pi](https://pi.dev) package for globally shared skills, prompts, extensions, and themes.

## Install globally

```bash
pi install /Users/mosius/.pi/user-resources/mosius
```

Then reload pi:

```text
/reload
```

## Included skills

- `web-search` - Search the web and fetch page text for current/external information.

## Included extensions

- `commit` - Provides `/commit` for isolated child-session git commits with optional free-text instructions.
- `commit-tree` - Provides `/commit-tree`, which runs the commit workflow on an abandoned conversation-tree branch, rolls back to the starting node, then appends a one-sentence confirmation.
- `minimal-footer` - Replaces the default footer with a compact single-line layout.

## Picking specific resources

This repo can hold many skills/tools. By default, installing the package loads all resources exposed by `package.json`.

To pick specific resources, use package filtering in `~/.pi/agent/settings.json`, for example:

```json
{
  "packages": [
    {
      "source": "/Users/mosius/.pi/user-resources/mosius",
      "skills": ["skills/web-search/SKILL.md"],
      "prompts": [],
      "extensions": ["extensions/commit/index.ts", "extensions/commit-tree.ts"],
      "themes": []
    }
  ]
}
```

You can also run `pi config` to enable or disable package resources interactively.
