#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
const maxChars = process.argv[3] || '50000';

if (!target) {
  console.error('Usage: node scripts/fetch-page.mjs "https://example.com/page" [maxChars]');
  process.exit(2);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = dirname(scriptDir);
const venvPython = join(skillDir, '.venv', 'bin', 'python');
const crawlScript = join(scriptDir, 'crawl4ai-scrape.py');
const basicScript = join(scriptDir, 'basic-fetch-page.mjs');

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function tryCrawl4AI() {
  const candidates = [venvPython, process.env.PYTHON, 'python3'].filter(Boolean);
  for (const python of candidates) {
    const result = run(python, [crawlScript, target, maxChars]);
    const stdout = result.stdout?.trim();

    if (result.status === 0 && stdout) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.ok !== false && parsed.markdown) return stdout;
      } catch {
        // Try another candidate/fallback.
      }
    }
  }
  return null;
}

const crawl4aiOutput = tryCrawl4AI();
if (crawl4aiOutput) {
  console.log(crawl4aiOutput);
  process.exit(0);
}

// Fallback: no Crawl4AI available or scrape failed. Use the dependency-free basic fetcher.
const fallback = run(process.execPath, [basicScript, target]);
if (fallback.stdout) process.stdout.write(fallback.stdout);
if (fallback.stderr) process.stderr.write(fallback.stderr);
process.exit(fallback.status ?? 1);
