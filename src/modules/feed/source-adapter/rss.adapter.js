// Official RSS/Atom adapter.
//
// A deliberately small, dependency-free reader: it extracts only the fields the
// content policy allows (title, link, publication date, short description) and
// ignores everything else in the document. The feed body is untrusted data and is
// never evaluated, never used to build a request, and never handed to a model.

const sourceType = 'OFFICIAL_RSS';

const ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&#39;', "'"],
  ['&nbsp;', ' ']
]);

function decodeEntities(value) {
  return value
    .replace(/&#(\d{1,6});/g, (match, code) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (match) => ENTITIES.get(match) ?? match);
}

function stripCdata(value) {
  return value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, ' ');
}

function readTag(block, tagName) {
  const match = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i').exec(block);

  return match ? decodeEntities(stripTags(stripCdata(match[1]))).replace(/\s+/g, ' ').trim() : null;
}

/// Atom links carry the URL in an attribute rather than in the element body.
function readAtomLink(block) {
  const alternate = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(block)
    ?? /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block);

  return alternate ? decodeEntities(alternate[1]).trim() : null;
}

function parseDate(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = new Date(value.trim());

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractBlocks(body, tagName) {
  const blocks = [];
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;

  while ((match = pattern.exec(body)) !== null) {
    blocks.push(match[1]);
  }

  return blocks;
}

function parse(body) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return [];
  }

  const rssItems = extractBlocks(body, 'item');
  const atomEntries = rssItems.length > 0 ? [] : extractBlocks(body, 'entry');

  return [...rssItems, ...atomEntries].map((block) => {
    const link = readTag(block, 'link') || readAtomLink(block);

    return {
      headline: readTag(block, 'title'),
      sourceUrl: typeof link === 'string' && /^https:\/\//i.test(link) ? link : null,
      publishedAt: parseDate(readTag(block, 'pubDate'))
        ?? parseDate(readTag(block, 'published'))
        ?? parseDate(readTag(block, 'updated'))
        ?? parseDate(readTag(block, 'dc:date')),
      // Only the summary/description is read; a full <content:encoded> body is
      // intentionally ignored so the original article is never reproduced.
      excerpt: readTag(block, 'description') || readTag(block, 'summary')
    };
  }).filter((item) => item.headline && item.sourceUrl);
}

module.exports = {
  decodeEntities,
  parse,
  sourceType
};
