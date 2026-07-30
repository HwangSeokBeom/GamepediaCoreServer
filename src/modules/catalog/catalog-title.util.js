const crypto = require('node:crypto');

// Title normalization is duplicated in SQL inside
// prisma/migrations/20260730120000_create_catalog_game_identity/migration.sql so
// that rows created by the backfill and rows created by the API normalize
// identically. Any change here must change that migration's successor, never the
// already-applied file.
//
//   lowercase -> replace every run of characters outside the retained set with a
//   single space -> trim -> clamp to 300 characters.
//
// Retained set: ASCII letters/digits, Hangul syllables, Hiragana, Katakana and
// CJK ideographs. Everything else (punctuation, ™/®, accents, whitespace) is a
// separator, so "Pokémon: Let's Go!" and "pokemon let s go" do not collide by
// accident while "Portal 2" and "PORTAL  2" do.
const RETAINED_TITLE_CHARACTERS = /[^a-z0-9가-힣ぁ-んァ-ヶ一-龯]+/g;
const MAX_TITLE_LENGTH = 300;
const MAX_SLUG_LENGTH = 320;

function normalizeTitle(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .toLowerCase()
    .replace(RETAINED_TITLE_CHARACTERS, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/// Compact form used for "same title, different spacing" comparisons.
function compactTitle(value) {
  return normalizeTitle(value).replace(/\s+/g, '');
}

function buildSlug(title, discriminator) {
  const base = normalizeTitle(title).replace(/\s+/g, '-');
  const suffix = typeof discriminator === 'string' && discriminator.length > 0
    ? `-${discriminator.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12)}`
    : '';

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
/// then confirms, never to merge automatically.
function titleSimilarity(left, right) {
  const a = compactTitle(left);
  const b = compactTitle(right);

  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  if (a.length === 1 || b.length === 1) {
    return 0;
  }

  const bigrams = new Map();

  for (let index = 0; index < a.length - 1; index += 1) {
    const bigram = a.slice(index, index + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;

  for (let index = 0; index < b.length - 1; index += 1) {
    const bigram = b.slice(index, index + 2);
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
  buildSlug,
  compactTitle,
  fingerprintInput,
  normalizeTitle,
  titleSimilarity
};
