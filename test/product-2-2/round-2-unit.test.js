const test = require('node:test');
const assert = require('node:assert/strict');
const { captureLogs } = require('./helpers/test-env');

// Round-2 findings E and F, at the unit level.
//
// The real-database proofs live in round-2-attacks.postgres.test.js; these are the
// pure-function properties that need no database: which Markdown nodes are refused,
// and where code-point boundaries fall.

const {
  ALLOWED_LINK_SCHEMES,
  classifyLinkDestination,
  validateArticleMarkdown
} = require('../../src/modules/feed/article-markdown.validator');
const {
  countCodePoints,
  hasUnpairedSurrogate,
  truncateCodePoints
} = require('../../src/utils/unicode-text');
const {
  MAX_SLUG_DISCRIMINATOR_LENGTH,
  MAX_SLUG_LENGTH,
  MAX_TITLE_LENGTH,
  buildSlug,
  clampTitle,
  normalizeTitle
} = require('../../src/modules/catalog/catalog-title.util');
const { createArticleSchema, buildFeedValidationError } = require('../../src/modules/feed/feed.validator');

const TRACKER = 'https://tracker.example.invalid/pixel.gif';

// ===========================================================================
// E. CommonMark AST validation
// ===========================================================================

test('every Markdown image form is refused, whichever syntax it arrives in', () => {
  // A regular expression caught the first of these and missed the rest, which is
  // why the validator now walks the AST the renderer will walk.
  const imageBodies = [
    ['inline image', `Intro\n\n![tracking pixel](${TRACKER})\n`],
    ['inline image with a title', `Intro\n\n![pixel](${TRACKER} "caption")\n`],
    ['reference-style image', `Intro\n\n![pixel][ref]\n\n[ref]: ${TRACKER}\n`],
    ['collapsed reference image', `Intro\n\n![ref][]\n\n[ref]: ${TRACKER}\n`],
    ['shortcut reference image', `Intro\n\n![ref]\n\n[ref]: ${TRACKER}\n`],
    ['data URL image', 'Intro\n\n![inline](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)\n'],
    ['angle-bracket destination', `Intro\n\n![pixel](<${TRACKER}>)\n`],
    ['image inside a link', `Intro\n\n[![pixel](${TRACKER})](https://example.invalid/a)\n`],
    ['image inside a list item', `- item\n- ![pixel](${TRACKER})\n`],
    ['image inside a block quote', `> quoted\n>\n> ![pixel](${TRACKER})\n`],
    ['image inside emphasis', `Intro *![pixel](${TRACKER})* tail\n`],
    ['image inside a heading', `# Heading ![pixel](${TRACKER})\n`]
  ];

  for (const [label, body] of imageBodies) {
    const { valid, violations } = validateArticleMarkdown(body);

    assert.equal(valid, false, `${label} must be refused`);
    assert.ok(
      violations.some((violation) => violation.reasonCode === 'markdown_image_not_allowed'),
      `${label} must be reported as an image, not as something vaguer`
    );

    // The destination must never travel with the rejection.
    assert.equal(JSON.stringify(violations).includes('tracker.example.invalid'), false,
      `${label}: the rejection must not echo the destination`);
  }
});

test('raw HTML in any position is refused', () => {
  const htmlBodies = [
    ['inline img tag', `Intro <img src="${TRACKER}"> tail\n`],
    ['block html', `<div>\n<img src="${TRACKER}">\n</div>\n`],
    ['script tag', '<script>fetch("https://exfil.example.invalid")</script>\n'],
    ['iframe', '<iframe src="https://embed.example.invalid"></iframe>\n'],
    ['svg with an onload handler', '<svg onload="alert(1)"></svg>\n'],
    ['html comment', '<!-- <img src="x"> -->\n'],
    ['closing tag only', 'Intro </div> tail\n']
  ];

  for (const [label, body] of htmlBodies) {
    const { valid, violations } = validateArticleMarkdown(body);

    assert.equal(valid, false, `${label} must be refused`);
    assert.ok(
      violations.some((violation) => violation.reasonCode === 'markdown_raw_html_not_allowed'),
      `${label} must be reported as raw HTML`
    );
  }
});

test('a link destination must be an absolute https URL', () => {
  assert.deepEqual([...ALLOWED_LINK_SCHEMES], ['https:']);

  const refused = [
    ['javascript', 'javascript:alert(1)', 'markdown_link_scheme_not_allowed'],
    ['data', 'data:text/html,<script>alert(1)</script>', 'markdown_link_scheme_not_allowed'],
    ['file', 'file:///etc/passwd', 'markdown_link_scheme_not_allowed'],
    ['vbscript', 'vbscript:msgbox(1)', 'markdown_link_scheme_not_allowed'],
    ['blob', 'blob:https://example.invalid/abc', 'markdown_link_scheme_not_allowed'],
    ['plain http', 'http://insecure.example.invalid/a', 'markdown_link_scheme_not_allowed'],
    ['mixed-case javascript', 'JaVaScRiPt:alert(1)', 'markdown_link_scheme_not_allowed'],
    ['protocol relative', '//evil.example.invalid/a', 'markdown_protocol_relative_link_not_allowed'],
    ['site relative', '/internal/admin', 'markdown_link_destination_not_absolute_https'],
    ['bare fragment', '#section', 'markdown_link_destination_not_absolute_https'],
    ['empty', '', 'markdown_empty_link_destination']
  ];

  for (const [label, destination, reasonCode] of refused) {
    const classification = classifyLinkDestination(destination);

    assert.equal(classification.allowed, false, `${label} must be refused`);
    assert.equal(classification.reasonCode, reasonCode, `${label} must report ${reasonCode}`);
  }

  assert.equal(classifyLinkDestination('https://store.steampowered.com/app/367520').allowed, true);
});

test('an ordinary editorial body with normal formatting is accepted', () => {
  // The validator has to leave real writing alone, or editors work around it.
  const body = [
    '# Hollow Knight retrospective',
    '',
    'The **first** hour is *deliberately* quiet, and it works.',
    '',
    '## What changed',
    '',
    '- Charm notches arrive earlier',
    '- Boss telegraphs are 4 frames longer',
    '  - which matters most on Radiance',
    '',
    '> "We wanted the map to feel earned."',
    '',
    'Source: [the developer blog](https://blog.example.invalid/post) and inline `code`.',
    '',
    '```js',
    'const damage = 5;',
    '```',
    '',
    '---',
    '',
    'Final line with a hard break at the end.  ',
    'Continued here.'
  ].join('\n');

  const { valid, violations } = validateArticleMarkdown(body);

  assert.equal(valid, true, `an ordinary body must be accepted, got ${JSON.stringify(violations)}`);
});

test('a null body is allowed and a non-string is refused without throwing', () => {
  // A DRAFT may legitimately have no body yet.
  assert.equal(validateArticleMarkdown(null).valid, true);
  assert.equal(validateArticleMarkdown(undefined).valid, true);

  const notAString = validateArticleMarkdown({ toString: () => `![x](${TRACKER})` });

  assert.equal(notAString.valid, false);
  assert.equal(notAString.violations[0].reasonCode, 'markdown_not_a_string');
});

test('repeated violations are de-duplicated so one mistake is not a hundred details', () => {
  const body = Array.from({ length: 20 }, (_, index) => `![pixel ${index}](${TRACKER})`).join('\n\n');
  const { valid, violations } = validateArticleMarkdown(body);

  assert.equal(valid, false);
  assert.equal(violations.length, 1, 'twenty identical images must report one reason code');
});

test('a refused body never reaches the logs, and neither does its destination', () => {
  const logs = captureLogs();

  try {
    const parsed = createArticleSchema.safeParse({
      slug: 'leak-probe',
      locale: 'ko',
      headline: 'H',
      excerpt: 'E',
      bodyMarkdown: `Secret draft text that must not be logged.\n\n![pixel](${TRACKER})\n`
    });

    assert.equal(parsed.success, false);

    const mapped = buildFeedValidationError(parsed.error);

    assert.equal(mapped.statusCode, 400);
    assert.equal(mapped.code, 'ARTICLE_MARKDOWN_RESOURCE_NOT_ALLOWED');

    const serialized = JSON.stringify({
      message: mapped.message,
      details: mapped.details,
      logs: logs.serialize()
    });

    assert.equal(serialized.includes('tracker.example.invalid'), false,
      'the tracking destination must not appear in the error or the logs');
    assert.equal(serialized.includes('Secret draft text'), false,
      'the draft body must not appear in the error or the logs');
    assert.match(serialized, /markdown_image_not_allowed/,
      'the reason code must still reach the client');
  } finally {
    logs.restore();
  }
});

// ===========================================================================
// F. Code points, not UTF-16 code units
// ===========================================================================

const ASTRAL = '\u{20BB7}';
const EMOJI = '\u{1F600}';

test('the original defect: an astral tail is measured in code points on both sides', () => {
  const value = `a${ASTRAL.repeat(200)}`;

  // 201 code points, 401 UTF-16 units. This gap is the whole finding.
  assert.equal(countCodePoints(value), 201);
  assert.equal(value.length, 401);

  // The pre-fix code did value.slice(0, 300), which kept 151 code points and ended
  // in an unpaired high surrogate, while PostgreSQL left(value, 300) kept all 201.
  const naive = value.slice(0, 300);

  assert.equal(countCodePoints(naive), 150 + 1 - 1 + 1, 'the naive slice keeps ~150 code points');
  assert.equal(hasUnpairedSurrogate(naive), true, 'the naive slice ends mid-pair');

  // The fix keeps every code point, because 201 <= 300, and breaks no pair.
  const clamped = clampTitle(value);

  assert.equal(countCodePoints(clamped), 201);
  assert.equal(hasUnpairedSurrogate(clamped), false);
  assert.equal(clamped, value);
});

test('truncation lands exactly on the limit and never inside a surrogate pair', () => {
  assert.equal(countCodePoints(truncateCodePoints(ASTRAL.repeat(300), MAX_TITLE_LENGTH)), 300);
  assert.equal(countCodePoints(truncateCodePoints(ASTRAL.repeat(301), MAX_TITLE_LENGTH)), 300);
  assert.equal(hasUnpairedSurrogate(truncateCodePoints(ASTRAL.repeat(301), MAX_TITLE_LENGTH)), false);

  // A pair that straddles the boundary is dropped whole, not halved.
  const straddling = `${'x'.repeat(299)}${ASTRAL}${'y'.repeat(10)}`;
  const truncated = truncateCodePoints(straddling, 300);

  assert.equal(countCodePoints(truncated), 300);
  assert.equal(truncated.endsWith(ASTRAL), true, 'the 300th code point is the astral character');
  assert.equal(hasUnpairedSurrogate(truncated), false);

  // One short of the boundary, the pair does not fit and is excluded entirely.
  const excluded = truncateCodePoints(`${'x'.repeat(300)}${ASTRAL}`, 300);

  assert.equal(excluded, 'x'.repeat(300));
  assert.equal(hasUnpairedSurrogate(excluded), false);
});

test('the supported corpus is bounded by code points, mixed scripts included', () => {
  const corpus = [
    ['ASCII over the limit', 'a'.repeat(400)],
    ['astral over the limit', ASTRAL.repeat(400)],
    ['emoji over the limit', EMOJI.repeat(400)],
    ['BMP and astral mixed', `${'가'.repeat(150)}${EMOJI.repeat(160)}`],
    ['Hangul over the limit', '가'.repeat(400)],
    ['combining mark past the boundary', `${'e'.repeat(299)}é${'x'.repeat(20)}`],
    ['Thai over the limit', 'ก'.repeat(400)],
    ['Arabic over the limit', 'ب'.repeat(400)],
    ['Cyrillic over the limit', 'б'.repeat(400)]
  ];

  for (const [label, value] of corpus) {
    for (const [fnLabel, result] of [['clampTitle', clampTitle(value)], ['normalizeTitle', normalizeTitle(value)]]) {
      assert.ok(countCodePoints(result) <= MAX_TITLE_LENGTH,
        `${label}: ${fnLabel} must not exceed ${MAX_TITLE_LENGTH} code points`);
      assert.equal(hasUnpairedSurrogate(result), false,
        `${label}: ${fnLabel} must not produce an unpaired surrogate`);
    }
  }
});

test('a slug stays within varchar(320) even when the title is astral', () => {
  // The slug column is varchar(320), wider than the 300-code-point title, so the
  // budget is base + discriminator, both counted in code points.
  assert.equal(MAX_SLUG_LENGTH, 320);
  assert.equal(MAX_SLUG_DISCRIMINATOR_LENGTH, 12);

  for (const value of [
    ASTRAL.repeat(400),
    `${'가'.repeat(200)}${EMOJI.repeat(200)}`,
    'a'.repeat(400),
    'ก'.repeat(400)
  ]) {
    const slug = buildSlug(value, 'abcdef123456');

    assert.ok(countCodePoints(slug) <= MAX_SLUG_LENGTH,
      `a slug must fit varchar(320), got ${countCodePoints(slug)} code points`);
    assert.equal(hasUnpairedSurrogate(slug), false);
    // The discriminator is what makes a slug unique, so it must survive truncation.
    assert.match(slug, /abcdef123456$/);
  }

  // A discriminator longer than its own limit is truncated, not allowed to eat the
  // whole budget.
  const longDiscriminator = buildSlug('Portal 2', 'x'.repeat(50));

  assert.equal(countCodePoints(longDiscriminator) <= MAX_SLUG_LENGTH, true);
  assert.equal(longDiscriminator, `portal-2-${'x'.repeat(MAX_SLUG_DISCRIMINATOR_LENGTH)}`);

  // No discriminator, and a title that normalizes to nothing.
  assert.equal(buildSlug('!!!', ''), null);
  assert.equal(buildSlug('!!!', 'abcdef123456'), 'abcdef123456');
});

test('countCodePoints and hasUnpairedSurrogate handle the degenerate inputs', () => {
  for (const value of [null, undefined, 12, {}, []]) {
    assert.equal(countCodePoints(value), 0);
    assert.equal(hasUnpairedSurrogate(value), false);
  }

  assert.equal(countCodePoints(''), 0);
  // A lone high surrogate, and a lone low surrogate, are both detected.
  assert.equal(hasUnpairedSurrogate('\ud842'), true);
  assert.equal(hasUnpairedSurrogate('\udfb7'), true);
  assert.equal(hasUnpairedSurrogate('𠮷'), false);
  assert.equal(hasUnpairedSurrogate(`${ASTRAL}a${ASTRAL}`), false);

  // Degenerate limits produce an empty string rather than a partial one.
  for (const limit of [0, -1, 1.5, Number.NaN, null]) {
    assert.equal(truncateCodePoints('abc', limit), '');
  }
});
