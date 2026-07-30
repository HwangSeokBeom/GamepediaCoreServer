// Unicode operations used by persisted catalog normalization must not inherit
// the Unicode tables bundled with whichever Node.js/ICU patch happens to run
// the service. These datasets and mappings are all generated from Unicode 8.0.

const unicode8Letter = require('@unicode/unicode-8.0.0/General_Category/Letter/regex.js');
const unicode8Number = require('@unicode/unicode-8.0.0/General_Category/Number/regex.js');
const unicode8Cased = require('@unicode/unicode-8.0.0/Binary_Property/Cased/regex.js');
const unicode8CaseIgnorable = require('@unicode/unicode-8.0.0/Binary_Property/Case_Ignorable/regex.js');
const simpleLowercase = require('@unicode/unicode-8.0.0/Simple_Case_Mapping/Lowercase/code-points.js');
const specialLowercase = require('@unicode/unicode-8.0.0/Special_Casing/Lowercase/code-points.js');

const GREEK_CAPITAL_SIGMA = 0x03a3;
const GREEK_SMALL_FINAL_SIGMA = 0x03c2;

function isUnicode8LetterOrNumber(symbol) {
  return unicode8Letter.test(symbol) || unicode8Number.test(symbol);
}

function hasCasedBefore(symbols, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (unicode8CaseIgnorable.test(symbols[cursor])) {
      continue;
    }

    return unicode8Cased.test(symbols[cursor]);
  }

  return false;
}

function hasCasedAfter(symbols, index) {
  for (let cursor = index + 1; cursor < symbols.length; cursor += 1) {
    if (unicode8CaseIgnorable.test(symbols[cursor])) {
      continue;
    }

    return unicode8Cased.test(symbols[cursor]);
  }

  return false;
}

function mappedCodePoints(codePoint, symbols, index) {
  // Unicode SpecialCasing.txt has one locale-independent conditional lowercase
  // rule: capital sigma becomes final sigma when preceded by a cased character
  // and not followed by one, ignoring case-ignorable characters.
  if (
    codePoint === GREEK_CAPITAL_SIGMA
    && hasCasedBefore(symbols, index)
    && !hasCasedAfter(symbols, index)
  ) {
    return [GREEK_SMALL_FINAL_SIGMA];
  }

  const special = specialLowercase.get(codePoint);

  if (special) {
    return special;
  }

  const simple = simpleLowercase.get(codePoint);
  return simple === undefined ? [codePoint] : [simple];
}

function toUnicode8Lowercase(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const symbols = [...value];

  return symbols
    .flatMap((symbol, index) => mappedCodePoints(symbol.codePointAt(0), symbols, index))
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join('');
}

module.exports = {
  isUnicode8LetterOrNumber,
  toUnicode8Lowercase
};
