#!/usr/bin/env python3
"""Scrape a URL with Crawl4AI and return LLM-ready Markdown as JSON."""

import asyncio
import contextlib
import io
import json
import sys
import traceback

url = sys.argv[1] if len(sys.argv) > 1 else None
if not url:
    print('Usage: python scripts/crawl4ai-scrape.py "https://example.com/page"', file=sys.stderr)
    sys.exit(2)

max_chars = int(sys.argv[2]) if len(sys.argv) > 2 else 50000


def value(obj, name, default=None):
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


async def main():
    try:
        from crawl4ai import AsyncWebCrawler
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "provider": "crawl4ai",
            "error": "crawl4ai is not installed or cannot be imported",
            "detail": str(exc),
            "setup": "Run scripts/setup-crawl4ai.sh, then retry.",
        }, indent=2))
        return 3

    browser_config = None
    run_config = None

    try:
        from crawl4ai import BrowserConfig, CrawlerRunConfig, CacheMode
        browser_config = BrowserConfig(headless=True, verbose=False)
        run_config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS)
    except Exception:
        # Older Crawl4AI versions work without explicit config objects.
        pass

    try:
        if browser_config is not None:
            crawler_cm = AsyncWebCrawler(config=browser_config)
        else:
            crawler_cm = AsyncWebCrawler()

        # Crawl4AI can print progress logs to stdout. Capture them so this
        # script's stdout remains machine-readable JSON for the pi skill.
        captured_stdout = io.StringIO()
        with contextlib.redirect_stdout(captured_stdout):
            async with crawler_cm as crawler:
                if run_config is not None:
                    result = await crawler.arun(url=url, config=run_config)
                else:
                    result = await crawler.arun(url=url)
        logs = captured_stdout.getvalue().strip()
        if logs:
            print(logs, file=sys.stderr)

        success = bool(value(result, "success", True))
        markdown = value(result, "markdown", None) or value(result, "fit_markdown", None) or ""
        cleaned_html = value(result, "cleaned_html", None)
        extracted_content = value(result, "extracted_content", None)
        metadata = value(result, "metadata", {}) or {}
        links = value(result, "links", {}) or {}
        media = value(result, "media", {}) or {}
        error_message = value(result, "error_message", None)
        final_url = value(result, "url", url) or url
        status_code = value(result, "status_code", None)

        text = markdown or extracted_content or ""
        truncated = len(text) > max_chars

        print(json.dumps({
            "ok": success,
            "provider": "crawl4ai",
            "url": final_url,
            "status": status_code,
            "format": "markdown" if markdown else "text",
            "metadata": metadata,
            "markdown": text[:max_chars],
            "truncated": truncated,
            "error": error_message,
            "links": links,
            "media": media,
            "hasCleanedHtml": bool(cleaned_html),
        }, ensure_ascii=False, indent=2))
        return 0 if success else 1
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "provider": "crawl4ai",
            "url": url,
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "setup": "If this is a browser/runtime issue, run scripts/setup-crawl4ai.sh or crawl4ai-setup.",
        }, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
