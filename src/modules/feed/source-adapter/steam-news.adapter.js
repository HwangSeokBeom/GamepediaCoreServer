// Steam news adapter.
//
// Parses the shape of the official Steam news payload
// (`appnews.newsitems[]`) from an already-fetched document. Only the headline,
// the canonical URL, the publication time and a short excerpt are kept; the
// `contents` field is truncated rather than stored, so the original item is never
// reproduced in full. No Steam endpoint is ever contacted from this repository.

const sourceType = 'STEAM_NEWS';

const EXCERPT_SOURCE_LIMIT = 800;

function stripBbCodeAndHtml(value) {
  return String(value)
    .replace(/\[\/?[a-z0-9=*"'\s._:-]+\]/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parse(body) {
  let payload;

  try {
    payload = typeof body === 'string' ? JSON.parse(body) : body;
  } catch (error) {
    return [];
  }

  const items = payload?.appnews?.newsitems;

  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => {
    const url = typeof item?.url === 'string' ? item.url : null;
    const publishedSeconds = Number(item?.date);

    return {
      headline: typeof item?.title === 'string' ? item.title : null,
      sourceUrl: url && /^https:\/\//i.test(url) ? url : null,
      publishedAt: Number.isFinite(publishedSeconds) && publishedSeconds > 0
        ? new Date(publishedSeconds * 1000)
        : null,
      excerpt: typeof item?.contents === 'string'
        ? stripBbCodeAndHtml(item.contents.slice(0, EXCERPT_SOURCE_LIMIT))
        : null
    };
  }).filter((item) => item.headline && item.sourceUrl);
}

module.exports = {
  EXCERPT_SOURCE_LIMIT,
  parse,
  sourceType,
  stripBbCodeAndHtml
};
