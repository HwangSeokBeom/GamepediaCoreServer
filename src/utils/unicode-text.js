// Code-point-safe text measurement and truncation.
//
// JavaScript `String.prototype.length` and `slice` operate on UTF-16 code units,
// while PostgreSQL `varchar(n)`, `left(text, n)` and `char_length` operate on
// characters (code points in a UTF-8 database). Mixing the two produced a real
// defect: `('a' + '\u{20BB7}'.repeat(200)).slice(0, 300)` kept 151 code points and
// ended in an unpaired high surrogate, while PostgreSQL's `left(..., 300)` kept all
// 201 code points. The stored value and the value the API validated therefore
// disagreed, and a lone surrogate could be persisted.
//
// Every title, slug and discriminator boundary in the catalog goes through these
// helpers so one length rule applies on both sides.

/// Number of Unicode code points, not UTF-16 code units.
function countCodePoints(value) {
  if (typeof value !== 'string') {
    return 0;
  }

  let count = 0;

  // Iterating a string yields whole code points, so a surrogate pair counts once.
  for (const _codePoint of value) {
    count += 1;
  }

  return count;
}

/// Truncates to at most `maxLength` code points. Never splits a surrogate pair, so
/// the result can never contain an unpaired surrogate that was paired in the input.
function truncateCodePoints(value, maxLength) {
  if (typeof value !== 'string' || !Number.isSafeInteger(maxLength) || maxLength <= 0) {
    return '';
  }

  let count = 0;
  let end = 0;

  // `for..of` advances by code point, so `end` only ever lands on a boundary.
  for (const codePoint of value) {
    if (count === maxLength) {
      return value.slice(0, end);
    }

    count += 1;
    end += codePoint.length;
  }

  return value;
}

/// True when the string contains a surrogate that is not part of a valid pair.
/// Used by tests and by the write boundary to reject text that cannot round-trip
/// through PostgreSQL's UTF-8 encoding.
function hasUnpairedSurrogate(value) {
  if (typeof value !== 'string') {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }

      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // A low surrogate reached without its high partner.
      return true;
    }
  }

  return false;
}

/// Zod refinement factory: bounds a string by code points rather than by UTF-16
/// units, so API validation and the `varchar(n)` column agree.
function codePointMax(maxLength, label = 'value') {
  return {
    check: (value) => countCodePoints(value) <= maxLength,
    message: `${label} must be at most ${maxLength} Unicode code points`
  };
}

module.exports = {
  codePointMax,
  countCodePoints,
  hasUnpairedSurrogate,
  truncateCodePoints
};
