const URL_REGEX = /^https?:\/\/.+/i;

function isUrl(text) {
  return URL_REGEX.test(text.trim());
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function scrapeArticle(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SenIQ/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

  const descMatch = html.match(/<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:name="description"|property="og:description")[^>]*>/i);
  const metaDesc = descMatch ? descMatch[1].trim() : '';

  // Prefer <article> or <main>, fall back to <body>
  let bodyHtml = html;
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch) bodyHtml = articleMatch[1];
  else if (mainMatch) bodyHtml = mainMatch[1];

  const text = stripHtml(bodyHtml);
  const truncated = text.length > 4000 ? text.substring(0, 4000) + '...' : text;

  return { title, text: truncated, metaDesc };
}

module.exports = { isUrl, scrapeArticle };
