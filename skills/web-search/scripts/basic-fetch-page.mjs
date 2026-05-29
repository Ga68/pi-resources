#!/usr/bin/env node

const target = process.argv[2];

if (!target) {
  console.error('Usage: node scripts/basic-fetch-page.mjs "https://example.com/page"');
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

function readableText(html) {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ');

  return decodeEntities(withoutNoise
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

try {
  const res = await fetch(target, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 pi-web-search-skill',
      Accept: 'text/html,text/plain,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
    },
  });

  const contentType = res.headers.get('content-type') || '';
  const body = await res.text();
  const text = contentType.includes('text/html') || body.includes('<html')
    ? readableText(body)
    : body.trim();

  console.log(JSON.stringify({
    url: res.url,
    status: res.status,
    contentType,
    format: 'text',
    provider: 'basic-fetch',
    text: text.slice(0, 30000),
    truncated: text.length > 30000,
  }, null, 2));
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
