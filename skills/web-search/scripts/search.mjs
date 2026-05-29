#!/usr/bin/env node

const query = process.argv[2];
const count = Math.min(Number(process.argv[3] || 8), 20);

if (!query) {
  console.error('Usage: node scripts/search.mjs "query" [count]');
  process.exit(2);
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

async function braveSearch() {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': key,
    },
  });

  if (!res.ok) throw new Error(`Brave Search failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return (json.web?.results || []).slice(0, count).map((r, i) => ({
    rank: i + 1,
    title: r.title || '',
    url: r.url || '',
    snippet: r.description || '',
  }));
}

async function duckDuckGoHtmlSearch() {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 pi-web-search-skill',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  const blocks = html.match(/<div class="result[\s\S]*?<\/div>\s*<\/div>/g) || [];

  const results = [];
  for (const block of blocks) {
    const titleMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    let resultUrl = decodeEntities(titleMatch[1]);
    try {
      const parsed = new URL(resultUrl, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) resultUrl = decodeURIComponent(uddg);
    } catch {}

    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);
    results.push({
      rank: results.length + 1,
      title: stripTags(titleMatch[2]),
      url: resultUrl,
      snippet: snippetMatch ? stripTags(snippetMatch[1] || snippetMatch[2] || '') : '',
    });
    if (results.length >= count) break;
  }
  return results;
}

try {
  const provider = process.env.BRAVE_API_KEY ? 'brave' : 'duckduckgo-html';
  const results = (await braveSearch()) || await duckDuckGoHtmlSearch();
  console.log(JSON.stringify({ query, provider, results }, null, 2));
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
