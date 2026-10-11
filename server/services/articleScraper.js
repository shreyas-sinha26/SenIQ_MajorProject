const { safeFetch } = require('./safeFetch');

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

// Why a fetched reply cannot be read as an article, or null when it can: its declared type
// is not a page of text, or (with no type declared) its bytes are not text. Pure.
const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;
function notAnArticle(contentType, body) {
  const type = String(contentType || '').split(';')[0].trim();
  if (type && !TEXT_TYPES.test(type)) return `that link is a ${type} file, not an article`;
  const sample = String(body || '').slice(0, 2000);
  // Bytes that are not text decode to the replacement character and to control characters.
  const junk = (sample.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) || []).length;
  if (sample.length && junk / sample.length > 0.05) return 'that link is not a page of text';
  return null;
}

// The URL comes from a user, so it goes through safeFetch: public addresses only, checked
// again on every redirect, and a capped body.
async function scrapeArticle(url) {
  const res = await safeFetch(url.trim(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SenIQ/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    timeoutMs: 10000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // A link to a picture, a PDF or a download is not an article: its bytes used to be read
  // as text, summarised and matched to tickers.
  const problem = notAnArticle(res.headers && res.headers.get ? res.headers.get('content-type') : '', res.text);
  if (problem) throw new Error(problem);

  const html = res.text;

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

module.exports = { isUrl, scrapeArticle, notAnArticle };
