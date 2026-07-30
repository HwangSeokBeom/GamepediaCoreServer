const commonmark = require('commonmark');

// Editorial body validation over a real CommonMark AST.
//
// A regular-expression scan cannot do this job. It blocked raw HTML but happily
// accepted `![tracking pixel](https://tracker.example/pixel)`, a reference-style
// image, and a `data:image/svg+xml` destination — so a CommonMark image node walked
// straight past the ArticleAsset rights review, and a published article could load a
// third-party resource that pings a reader's IP and user agent on open.
//
// The parser is `commonmark`, the reference JavaScript implementation by the spec
// author (BSD-2-Clause). Only its `Parser` is used; the bundled HtmlRenderer is
// never touched, because this module makes a decision about the AST and never
// produces markup.
//
// Enforced at the *write* boundary and again at publish time, so a body stored
// before a rule tightened cannot be published later. A client-side renderer setting
// is not a security control.

const ALLOWED_NODE_TYPES = new Set([
  'document',
  'paragraph',
  'heading',
  'text',
  'softbreak',
  'linebreak',
  'emph',
  'strong',
  'list',
  'item',
  'block_quote',
  'code',
  'code_block',
  'thematic_break',
  'link'
]);

/// Node types that are rejected outright, with the reason code reported.
const REJECTED_NODE_REASONS = new Map([
  // Every image is refused: an approved image must come from ArticleAsset, which
  // carries a reviewed rightsStatus. An inline image bypasses that entirely.
  ['image', 'markdown_image_not_allowed'],
  ['html_inline', 'markdown_raw_html_not_allowed'],
  ['html_block', 'markdown_raw_html_not_allowed'],
  // Not expected from the default parser configuration, but refused rather than
  // silently allowed if a future parser version introduces them.
  ['custom_inline', 'markdown_unsupported_node'],
  ['custom_block', 'markdown_unsupported_node']
]);

const ALLOWED_LINK_SCHEMES = new Set(['https:']);

/// Schemes that must never appear, even if a future parser normalizes them oddly.
const BLOCKED_SCHEME_PATTERN = /^(?:javascript|data|file|vbscript|blob|about|jar):/i;

function classifyLinkDestination(rawDestination) {
  const destination = String(rawDestination ?? '').trim();

  if (destination.length === 0) {
    return { allowed: false, reasonCode: 'markdown_empty_link_destination' };
  }

  if (BLOCKED_SCHEME_PATTERN.test(destination)) {
    return { allowed: false, reasonCode: 'markdown_link_scheme_not_allowed' };
  }

  // `//host/path` inherits the page scheme, so it can resolve to http.
  if (destination.startsWith('//')) {
    return { allowed: false, reasonCode: 'markdown_protocol_relative_link_not_allowed' };
  }

  let parsed;

  try {
    parsed = new URL(destination);
  } catch (error) {
    // A relative or fragment link has no scheme to verify. The renderer would
    // resolve it against an origin this server does not control, so it cannot be
    // confirmed safe and is refused rather than assumed harmless.
    return { allowed: false, reasonCode: 'markdown_link_destination_not_absolute_https' };
  }

  if (!ALLOWED_LINK_SCHEMES.has(parsed.protocol)) {
    return { allowed: false, reasonCode: 'markdown_link_scheme_not_allowed' };
  }

  return { allowed: true, reasonCode: null };
}

/// Validates a body. Returns `{ valid, violations }` where each violation carries a
/// reason code and the node type only — never the destination or the body text, so
/// neither a rejection response nor a log line can echo a tracking URL back out.
function validateArticleMarkdown(bodyMarkdown) {
  if (bodyMarkdown === null || bodyMarkdown === undefined) {
    return { valid: true, violations: [] };
  }

  if (typeof bodyMarkdown !== 'string') {
    return { valid: false, violations: [{ reasonCode: 'markdown_not_a_string', nodeType: null }] };
  }

  let walker;

  try {
    walker = new commonmark.Parser().parse(bodyMarkdown).walker();
  } catch (error) {
    return { valid: false, violations: [{ reasonCode: 'markdown_unparsable', nodeType: null }] };
  }

  const violations = [];
  let event = walker.next();

  while (event) {
    const { node, entering } = event;

    if (entering) {
      const rejection = REJECTED_NODE_REASONS.get(node.type);

      if (rejection) {
        violations.push({ reasonCode: rejection, nodeType: node.type });
      } else if (!ALLOWED_NODE_TYPES.has(node.type)) {
        violations.push({ reasonCode: 'markdown_unsupported_node', nodeType: node.type });
      } else if (node.type === 'link') {
        const classification = classifyLinkDestination(node.destination);

        if (!classification.allowed) {
          violations.push({ reasonCode: classification.reasonCode, nodeType: 'link' });
        }
      }
    }

    event = walker.next();
  }

  // De-duplicate so one repeated mistake does not produce a hundred details.
  const seen = new Set();
  const unique = violations.filter((violation) => {
    const key = `${violation.reasonCode}:${violation.nodeType ?? ''}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  return { valid: unique.length === 0, violations: unique };
}

module.exports = {
  ALLOWED_LINK_SCHEMES,
  ALLOWED_NODE_TYPES,
  REJECTED_NODE_REASONS,
  classifyLinkDestination,
  validateArticleMarkdown
};
