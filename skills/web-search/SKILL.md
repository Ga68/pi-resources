---
name: web-search
description: Search the web and fetch page text for current facts, documentation, APIs, error messages, package information, and other information not present in the repository. Use when up-to-date external information is needed.
---

# Web Search Skill

Use this skill when the task needs current or external information that is not available in the local repository.

## Capabilities

- Search the web for relevant pages.
- Prefer official documentation, source repositories, standards, changelogs, and primary sources.
- Fetch LLM-ready Markdown from a result URL with Crawl4AI when installed.
- Fall back to a dependency-free plain-text fetcher when Crawl4AI is unavailable.
- Summarize findings with source URLs.

## Search

From the skill directory, run:

```bash
node scripts/search.mjs "query"
```

Optional result count:

```bash
node scripts/search.mjs "query" 10
```

The script uses Brave Search if `BRAVE_API_KEY` is set. Without a Brave key it falls back to DuckDuckGo's HTML endpoint, which is less reliable but often sufficient.

## Fetch Page Content

```bash
node scripts/fetch-page.mjs "https://example.com/page"
```

This prefers Crawl4AI and returns cleaned Markdown. If Crawl4AI is not installed or fails for the page, it falls back to a basic dependency-free HTML-to-text fetcher.

Optional maximum output characters:

```bash
node scripts/fetch-page.mjs "https://example.com/page" 50000
```

## Crawl4AI Setup

Crawl4AI is optional but recommended for better extraction, JavaScript-rendered pages, and Markdown output.

Install it into this skill's local virtual environment with `uv`:

```bash
scripts/setup-crawl4ai.sh
```

Requirements:

- `uv`
- Python 3.10+

Recommended setup on macOS:

```bash
brew install uv python@3.12
PYTHON=/opt/homebrew/bin/python3.12 scripts/setup-crawl4ai.sh
```

The setup script is intentionally `uv`-only. It creates/updates `.venv` in the skill directory and installs Crawl4AI there.

No Brave API key is required for Crawl4AI. Brave is only used by `scripts/search.mjs` when `BRAVE_API_KEY` is set.

## Workflow

1. Search with a targeted query.
2. Prefer authoritative sources:
   - official docs
   - official GitHub repositories
   - standards/specifications
   - release notes/changelogs
   - package registry pages
3. Fetch and read promising result pages.
4. Cross-check important claims with more than one source when practical.
5. Report concise findings and include URLs.

## Query Tips

- Include exact error messages in quotes.
- Include version numbers when debugging package behavior.
- Include `site:docs.example.com` for official docs when known.
- Include language/framework names to reduce ambiguity.

## Safety and Quality Rules

- Do not trust snippets blindly; fetch the page when details matter.
- Distinguish current facts from assumptions.
- Mention when search results are weak or inconclusive.
- Do not paste large raw page dumps into the final answer unless requested.
