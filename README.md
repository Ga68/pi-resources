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

- `commit` - Create scoped, safe git commits with optional `.agents/commits/` rationale files.
- `web-search` - Search the web and fetch page text for current/external information.

## Included extensions

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
      "extensions": ["extensions/minimal-footer.ts"],
      "themes": []
    }
  ]
}
```

You can also run `pi config` to enable or disable package resources interactively.
