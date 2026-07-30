const crypto = require('node:crypto');

// Unicode-safe title normalization.
//
// The previous revision retained only ASCII, Hangul syllables, Hiragana,
// Katakana and CJK ideographs. Every other script normalized to an empty string,
// which made Thai, Arabic, Cyrillic, Hebrew, Greek, Devanagari and Vietnamese
// titles impossible to store or search, and it split "ゲーム" on the prolonged
// sound mark and "Pokémon" on its accent.
//
// The rule now is:
//
//   strip trademark/copyright symbols -> NFKC -> lowercase -> replace every run
//   of characters that is neither a Unicode letter, nor a Unicode number, nor a
//   retained combining mark with a single space -> trim -> clamp to 300
//   characters.
//
// NFKC folds compatibility forms first, so fullwidth "Ｐｏｒｔａｌ ２" and
// "Ⅷ" and "½" reduce to their ASCII equivalents before anything is stripped.
//
// DATABASE PARITY. The same rule is expressed in SQL as
//
//   btrim(regexp_replace(lower(normalize(translate(title, '<legal symbols>', ''),
//         NFKC)), '[^[:alnum:]<retained marks>]+', ' ', 'g'))
//
// inside prisma/migrations/20260730130000_product_2_2_review_fixes/migration.sql.
// PostgreSQL classifies combining marks as [:punct:], so the marks have to be
// whitelisted explicitly on both sides; RETAINED_MARK_RANGES below is the single
// source of that whitelist and `buildRetainedMarkClass()` renders the exact
// character class both engines use. A test asserts the migration contains that
// rendered class verbatim, and the PostgreSQL gate proves byte-level parity over
// a multi-script corpus.
//
// Never edit an applied migration to change this; add a successor migration that
// recomputes the stored normalized titles.

/// Combining-mark ranges retained by normalization, as inclusive
/// [startCodepoint, endCodepoint] pairs. Marks are semantically load-bearing in
/// these scripts — dropping U+0E34 would collapse Thai "กิน" to "กน" — so they
/// are kept rather than treated as separators.
const RETAINED_MARK_RANGES = Object.freeze([
  [0x0300, 0x036f], // Combining Diacritical Marks (Latin, Vietnamese)
  [0x0483, 0x0489], // Cyrillic combining marks
  [0x0591, 0x05c7], // Hebrew points and marks
  [0x0610, 0x061a], // Arabic marks above/below
  [0x064b, 0x065f], // Arabic harakat
  [0x0670, 0x0670], // Arabic letter superscript alef
  [0x06d6, 0x06dc], // Arabic small high marks
  [0x06df, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0900, 0x0903], // Devanagari signs
  [0x093a, 0x094f], // Devanagari vowel signs and virama
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x0e31, 0x0e31], // Thai mai han akat
  [0x0e34, 0x0e3a], // Thai vowel signs
  [0x0e47, 0x0e4e], // Thai tone marks and thanthakhat
  [0x0eb1, 0x0eb1], // Lao
  [0x0eb4, 0x0ebc],
  [0x0ec8, 0x0ecd],
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x3099, 0x309a], // Japanese voiced/semi-voiced sound marks
  [0xfe20, 0xfe2f]  // Combining Half Marks
]);

/// Legal/status symbols stripped *before* NFKC.
///
/// NFKC folds some of these into letters — U+2122 TM becomes "TM", U+2120 becomes
/// "SM" — which would turn "Hollow Knight™" into "hollow knighttm" and make the
/// title unsearchable by its actual name. They are trademark and copyright
/// notices, not part of a title, so they are removed first. The rest of this set
/// would be dropped anyway as symbols; listing them keeps the intent explicit and
/// keeps the SQL counterpart's translate() argument identical.
const STRIPPED_LEGAL_SYMBOLS = '™℠®©℗';
const STRIPPED_LEGAL_SYMBOLS_PATTERN = new RegExp(`[${STRIPPED_LEGAL_SYMBOLS}]`, 'gu');

/// Renders RETAINED_MARK_RANGES as the character-class body shared by the JS
/// regex and the SQL bracket expression.
function buildRetainedMarkClass() {
  return RETAINED_MARK_RANGES
    .map(([from, to]) => (from === to
      ? String.fromCodePoint(from)
      : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`))
    .join('');
}

const RETAINED_MARK_CLASS = buildRetainedMarkClass();
const SEPARATOR_RUN = new RegExp(`[^\\p{L}\\p{N}${RETAINED_MARK_CLASS}]+`, 'gu');
const MAX_TITLE_LENGTH = 300;
const MAX_SLUG_LENGTH = 320;

function normalizeTitle(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(STRIPPED_LEGAL_SYMBOLS_PATTERN, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(SEPARATOR_RUN, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/// Compact form used for "same title, different spacing" comparisons.
function compactTitle(value) {
  return normalizeTitle(value).replace(/\s+/g, '');
}

/// Deterministic slug. Unicode letters survive normalization, so a slug can be
/// non-ASCII; that is fine for the unique index and for a percent-encoded path
/// segment, and it keeps a Thai or Cyrillic title addressable at all.
function buildSlug(title, discriminator) {
  const base = normalizeTitle(title).replace(/\s+/g, '-');
  const normalizedDiscriminator = typeof discriminator === 'string' && discriminator.length > 0
    ? normalizeTitle(discriminator).replace(/\s+/g, '').slice(0, 12)
    : '';
  const suffix = normalizedDiscriminator.length > 0 ? `-${normalizedDiscriminator}` : '';

  if (base.length === 0) {
    return suffix.length > 0 ? suffix.slice(1) : null;
  }

  return `${base.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
}

/// SHA-256 fingerprint of a normalized natural-language input. Stored instead of
/// the input itself so a submission can be de-duplicated and correlated without
/// ever persisting what the user typed.
function fingerprintInput(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value.trim().toLowerCase() : '')
    .digest('hex');
}

/// Character-level Dice coefficient over normalized bigrams. Deterministic,
/// dependency-free, and symmetric — used only to *rank* candidates that a human
/// then confirms, never to merge automatically. Operates on code points so a
/// surrogate pair is never split mid-character.
function titleSimilarity(left, right) {
  const a = [...compactTitle(left)];
  const b = [...compactTitle(right)];

  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  if (a.join('') === b.join('')) {
    return 1;
  }

  if (a.length === 1 || b.length === 1) {
    return 0;
  }

  const bigrams = new Map();

  for (let index = 0; index < a.length - 1; index += 1) {
    const bigram = `${a[index]}${a[index + 1]}`;
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;

  for (let index = 0; index < b.length - 1; index += 1) {
    const bigram = `${b[index]}${b[index + 1]}`;
    const remaining = bigrams.get(bigram) ?? 0;

    if (remaining > 0) {
      bigrams.set(bigram, remaining - 1);
      intersection += 1;
    }
  }

  return (2 * intersection) / ((a.length - 1) + (b.length - 1));
}

module.exports = {
  MAX_SLUG_LENGTH,
  MAX_TITLE_LENGTH,
  RETAINED_MARK_CLASS,
  RETAINED_MARK_RANGES,
  STRIPPED_LEGAL_SYMBOLS,
  buildRetainedMarkClass,
  buildSlug,
  compactTitle,
  fingerprintInput,
  normalizeTitle,
  titleSimilarity
};
