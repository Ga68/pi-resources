# mosius-pi-tools

Personal [pi](https://pi.dev) package for globally shared skills, prompts, extensions, and themes.

## Install globally

```bash
pi install /Users/mosius/projects/my_first_pi
```

Then reload pi:

```text
/reload
```

## Included skills

- `commit` - Create scoped, safe git commits with optional `.agents/commits/` rationale files.
- `web-search` - Search the web and fetch page text for current/external information.

## Picking specific resources

This repo can hold many skills/tools. By default, installing the package loads all resources exposed by `package.json`.

To pick specific resources, use package filtering in `~/.pi/agent/settings.json`, for example:

```json
{
  "packages": [
    {
      "source": "/Users/mosius/projects/my_first_pi",
      "skills": ["skills/commit/SKILL.md"],
      "prompts": [],
      "extensions": [],
      "themes": []
    }
  ]
}
```

You can also run `pi config` to enable or disable package resources interactively.
