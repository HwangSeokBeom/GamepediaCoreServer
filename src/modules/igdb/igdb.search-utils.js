const EDITION_PENALTY_PATTERN = /\b(dlc|demo|soundtrack|ost|beta|alpha|season pass|ultimate edition|collector'?s edition|collectors edition|update|bundle|pack|artbook)\b/i;
const MAX_CANDIDATE_COUNT = 5;
const ROMAN_TO_ARABIC_MAP = new Map([
  ['x', '10'],
  ['ix', '9'],
  ['viii', '8'],
  ['vii', '7'],
  ['vi', '6'],
  ['v', '5'],
  ['iv', '4'],
  ['iii', '3'],
  ['ii', '2'],
  ['i', '1']
]);
const ARABIC_TO_ROMAN_MAP = new Map([
  ['1', 'i'],
  ['2', 'ii'],
  ['3', 'iii'],
  ['4', 'iv'],
  ['5', 'v'],
  ['6', 'vi'],
  ['7', 'vii'],
  ['8', 'viii'],
  ['9', 'ix'],
  ['10', 'x']
]);

function uniqueNonEmpty(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizePunctuation(value) {
  return value
    .replace(/[’‘`´]/g, '\'')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[：]/g, ':');
}

function replaceRomanNumeralTokens(value) {
  return value
    .split(' ')
    .map((token) => ROMAN_TO_ARABIC_MAP.get(token) ?? token)
    .join(' ');
}

function replaceArabicNumberTokensWithRoman(value) {
  return value
    .split(' ')
    .map((token) => ARABIC_TO_ROMAN_MAP.get(token) ?? token)
    .join(' ');
}

function normalizeQuery(query) {
  const original = typeof query === 'string' ? query : '';
  const trimmed = normalizePunctuation(original.normalize('NFKC')).trim();
  const lowerCased = trimmed.toLowerCase();
  const collapsedWhitespace = lowerCased.replace(/\s+/g, ' ');
  const punctuationRemoved = collapsedWhitespace
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = punctuationRemoved || collapsedWhitespace;
  const numericNormalized = replaceRomanNumeralTokens(normalized);
  const romanNormalized = replaceArabicNumberTokensWithRoman(normalized);
  const compact = normalized.replace(/\s+/g, '');
  const numericCompact = numericNormalized.replace(/\s+/g, '');
  const romanCompact = romanNormalized.replace(/\s+/g, '');
  const normalizedVariants = uniqueNonEmpty([
    normalized,
    numericNormalized !== normalized ? numericNormalized : null,
    romanNormalized !== normalized ? romanNormalized : null
  ]);
  const compactVariants = uniqueNonEmpty([
    compact,
    numericCompact !== compact ? numericCompact : null,
    romanCompact !== compact ? romanCompact : null
  ]);

  return {
    original,
    trimmed,
    normalized,
    compact,
    numericNormalized,
    numericCompact,
    romanNormalized,
    romanCompact,
    normalizedVariants,
    compactVariants,
    tokens: normalized ? normalized.split(' ').filter(Boolean) : []
  };
}

function addCandidate(candidates, candidate) {
  if (!candidate || candidates.includes(candidate)) {
    return;
  }

  candidates.push(candidate);
}

function buildSearchCandidateQueries(query, maxCandidates = MAX_CANDIDATE_COUNT) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const candidates = [];
  const firstToken = queryInfo.tokens[0] ?? '';

  for (const normalizedVariant of queryInfo.normalizedVariants ?? [queryInfo.normalized]) {
    addCandidate(candidates, normalizedVariant);
  }

  for (const compactVariant of queryInfo.compactVariants ?? [queryInfo.compact]) {
    if (compactVariant && compactVariant !== queryInfo.normalized) {
      addCandidate(candidates, compactVariant);
    }
  }

  if (firstToken.length >= 2) {
    addCandidate(candidates, `${firstToken}*`);
  }

  for (const compactVariant of queryInfo.compactVariants ?? [queryInfo.compact]) {
    if (compactVariant.length >= 2) {
      addCandidate(candidates, `${compactVariant}*`);
    }
  }

  for (const normalizedVariant of queryInfo.normalizedVariants ?? [queryInfo.normalized]) {
    if (queryInfo.tokens.length > 1 && normalizedVariant.length >= 2) {
      addCandidate(candidates, `${normalizedVariant}*`);
    }
  }

  return candidates.slice(0, maxCandidates);
}

function buildFallbackCandidateQueries(query, existingCandidates = []) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const fallbacks = [];
  const attemptedCandidates = new Set(existingCandidates);

  const compactCandidate = queryInfo.compact;
  const compactPrefixCandidate = queryInfo.compact.length >= 2 ? `${queryInfo.compact}*` : '';
  const normalizedPrefixCandidate = queryInfo.normalized.length >= 2 ? `${queryInfo.normalized}*` : '';

  [compactCandidate, compactPrefixCandidate, normalizedPrefixCandidate].forEach((candidate) => {
    if (!candidate || attemptedCandidates.has(candidate)) {
      return;
    }

    addCandidate(fallbacks, candidate);
  });

  return fallbacks.slice(0, 2);
}

function mergeGamesById(resultSets) {
  const mergedGames = [];
  const seenGameIds = new Set();

  for (const resultSet of resultSets) {
    if (!Array.isArray(resultSet)) {
      continue;
    }

    for (const game of resultSet) {
      if (typeof game?.id !== 'number' || seenGameIds.has(game.id)) {
        continue;
      }

      seenGameIds.add(game.id);
      mergedGames.push(game);
    }
  }

  return mergedGames;
}

function normalizeNameForScoring(value) {
  return normalizeQuery(value).numericCompact;
}

function getComparableNormalizedForms(query) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  return queryInfo.normalizedVariants ?? [queryInfo.normalized].filter(Boolean);
}

function getComparableCompactForms(query) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  return queryInfo.compactVariants ?? [queryInfo.compact].filter(Boolean);
}

function computeDiceCoefficient(left, right) {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (left.length < 2 || right.length < 2) {
    return left === right ? 1 : 0;
  }

  const leftBigrams = new Map();

  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    leftBigrams.set(bigram, (leftBigrams.get(bigram) ?? 0) + 1);
  }

  let matches = 0;

  for (let index = 0; index < right.length - 1; index += 1) {
    const bigram = right.slice(index, index + 2);
    const count = leftBigrams.get(bigram) ?? 0;

    if (count > 0) {
      leftBigrams.set(bigram, count - 1);
      matches += 1;
    }
  }

  return (2 * matches) / ((left.length - 1) + (right.length - 1));
}

function getNumericField(game, fieldName) {
  return typeof game?.[fieldName] === 'number' ? game[fieldName] : 0;
}

function computeAliasBoost(aliasBoost, gameNameInfo) {
  if (!aliasBoost?.target) {
    return 0;
  }

  const targetInfo = normalizeQuery(aliasBoost.target);

  if (!targetInfo.compact) {
    return 0;
  }

  const prefixConfidence = Math.min(
    Math.max(aliasBoost.confidence ?? 0.4, 0.4),
    1
  );
  const baseMultiplier = aliasBoost.matchType === 'exact' ? 1.2 : prefixConfidence;
  let score = 0;

  if ((gameNameInfo.compactVariants ?? [gameNameInfo.compact]).includes(targetInfo.numericCompact)) {
    score += 520;
  } else if ((gameNameInfo.compactVariants ?? [gameNameInfo.compact]).some((compactValue) => compactValue.startsWith(targetInfo.numericCompact))) {
    score += 280;
  } else if ((gameNameInfo.compactVariants ?? [gameNameInfo.compact]).some((compactValue) => compactValue.includes(targetInfo.numericCompact))) {
    score += 120;
  }

  for (const candidateQuery of aliasBoost.candidateQueries ?? []) {
    const candidateInfo = normalizeQuery(candidateQuery.replace(/\*+$/g, ''));

    if (!candidateInfo.compact || candidateInfo.compact === targetInfo.compact) {
      continue;
    }

    if ((gameNameInfo.compactVariants ?? [gameNameInfo.compact]).includes(candidateInfo.numericCompact)) {
      score += 220;
    } else if ((gameNameInfo.compactVariants ?? [gameNameInfo.compact]).some((compactValue) => compactValue.startsWith(candidateInfo.numericCompact))) {
      score += 160;
    } else if ((gameNameInfo.compactVariants ?? [gameNameInfo.compact]).some((compactValue) => compactValue.includes(candidateInfo.numericCompact))) {
      score += 80;
    }
  }

  return Math.round(score * baseMultiplier);
}

function computeFuzzyScore(query, gameName, game = {}, options = {}) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const gameNameInfo = normalizeQuery(gameName);
  const queryNormalizedForms = getComparableNormalizedForms(queryInfo);
  const queryCompactForms = getComparableCompactForms(queryInfo);
  const gameNormalizedForms = getComparableNormalizedForms(gameNameInfo);
  const gameCompactForms = getComparableCompactForms(gameNameInfo);

  if (queryCompactForms.length === 0 || gameCompactForms.length === 0) {
    return 0;
  }

  let score = 0;
  const exactNormalizedMatch = queryNormalizedForms.some((queryValue) => gameNormalizedForms.includes(queryValue));
  const exactCompactMatch = queryCompactForms.some((queryValue) => gameCompactForms.includes(queryValue));
  const prefixCompactMatch = queryCompactForms.some((queryValue) => gameCompactForms.some((gameValue) => gameValue.startsWith(queryValue)));
  const prefixNormalizedMatch = queryNormalizedForms.some((queryValue) => gameNormalizedForms.some((gameValue) => gameValue.startsWith(queryValue)));
  const substringCompactMatch = queryCompactForms.some((queryValue) => gameCompactForms.some((gameValue) => gameValue.includes(queryValue)));
  const substringNormalizedMatch = queryNormalizedForms.some((queryValue) => gameNormalizedForms.some((gameValue) => gameValue.includes(queryValue)));

  if (exactNormalizedMatch) {
    score += 70;
  }

  if (exactCompactMatch) {
    score += 90;
  } else if (prefixCompactMatch) {
    score += 200;
  } else if (prefixNormalizedMatch) {
    score += 160;
  } else if (substringCompactMatch) {
    score += 120;
  } else if (substringNormalizedMatch) {
    score += 100;
  }

  const firstToken = queryInfo.tokens[0] ?? '';

  if (firstToken && firstToken !== queryInfo.normalized) {
    if (gameNormalizedForms.some((value) => value.startsWith(firstToken))) {
      score += 60;
    } else if (gameCompactForms.some((value) => value.includes(firstToken.replace(/\s+/g, '')))) {
      score += 30;
    }
  }

  const bestDiceScore = queryCompactForms.reduce((highestScore, queryCompact) => {
    const candidateHighScore = gameCompactForms.reduce(
      (candidateScore, gameCompact) => Math.max(candidateScore, computeDiceCoefficient(queryCompact, gameCompact)),
      0
    );
    return Math.max(highestScore, candidateHighScore);
  }, 0);
  score += Math.round(bestDiceScore * 110);
  score += Math.min(getNumericField(game, 'total_rating') * 0.6, 80);
  score += Math.min(getNumericField(game, 'aggregated_rating') * 0.4, 40);
  score += Math.min(Math.log10(getNumericField(game, 'total_rating_count') + 1) * 60, 180);
  score += Math.min(Math.log10(getNumericField(game, 'aggregated_rating_count') + 1) * 30, 90);

  const matchingPrefixCompact = queryCompactForms.find((queryCompact) => gameCompactForms.some((gameCompact) => gameCompact.startsWith(queryCompact)));

  if (matchingPrefixCompact) {
    const matchedGameCompact = gameCompactForms.find((gameCompact) => gameCompact.startsWith(matchingPrefixCompact)) ?? '';
    const suffix = matchedGameCompact.slice(matchingPrefixCompact.length);
    const hasQualitySignal =
      getNumericField(game, 'total_rating_count') > 0 ||
      getNumericField(game, 'aggregated_rating_count') > 0 ||
      getNumericField(game, 'total_rating') > 0 ||
      getNumericField(game, 'aggregated_rating') > 0;

    if (hasQualitySignal && /^\d{4}$/.test(suffix)) {
      score += 90;
    } else if (hasQualitySignal && /^\d{4}[a-z0-9]+$/.test(suffix)) {
      score += 45;
    }
  }

  if (typeof game?.first_release_date === 'number') {
    const releaseYear = new Date(game.first_release_date * 1000).getUTCFullYear();
    score += Math.max(releaseYear - 2000, 0) * 0.8;
  }

  score -= Math.min(Math.max((gameNameInfo.numericCompact ?? gameNameInfo.compact).length - (queryInfo.numericCompact ?? queryInfo.compact).length, 0) * 2, 120);

  if (EDITION_PENALTY_PATTERN.test(gameNameInfo.normalized) && !EDITION_PENALTY_PATTERN.test(queryInfo.normalized)) {
    score -= 160;
  }

  const querySequelNumber = extractSequelNumber(queryNormalizedForms);
  const gameSequelNumber = extractSequelNumber(gameNormalizedForms);

  if (querySequelNumber && gameSequelNumber) {
    score += querySequelNumber === gameSequelNumber ? 110 : -90;
  }

  score += computeAliasBoost(options.aliasBoost, gameNameInfo);

  return score;
}

function extractSequelNumber(normalizedForms) {
  for (const normalizedValue of normalizedForms ?? []) {
    const matchedToken = normalizedValue.match(/\b([1-9]|10)\b/);

    if (matchedToken) {
      return matchedToken[1];
    }
  }

  return null;
}

function explainGameMatchReasons(query, game, options = {}) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const gameNameInfo = normalizeQuery(game?.name ?? '');
  const reasons = [];
  const queryNormalizedForms = getComparableNormalizedForms(queryInfo);
  const queryCompactForms = getComparableCompactForms(queryInfo);
  const gameNormalizedForms = getComparableNormalizedForms(gameNameInfo);
  const gameCompactForms = getComparableCompactForms(gameNameInfo);

  if (queryNormalizedForms.some((queryValue) => gameNormalizedForms.includes(queryValue))) {
    reasons.push('exact_title_match');
  } else if (queryCompactForms.some((queryValue) => gameCompactForms.includes(queryValue))) {
    reasons.push('compact_exact_match');
  } else if (queryCompactForms.some((queryValue) => gameCompactForms.some((gameValue) => gameValue.startsWith(queryValue)))) {
    reasons.push('prefix_match');
  } else if (queryCompactForms.some((queryValue) => gameCompactForms.some((gameValue) => gameValue.includes(queryValue)))) {
    reasons.push('substring_match');
  }

  if (computeAliasBoost(options.aliasBoost, gameNameInfo) > 0) {
    reasons.push('alias_boost');
  }

  const querySequelNumber = extractSequelNumber(queryNormalizedForms);
  const gameSequelNumber = extractSequelNumber(gameNormalizedForms);

  if (querySequelNumber && gameSequelNumber && querySequelNumber === gameSequelNumber) {
    reasons.push('sequel_match');
  }

  if (getNumericField(game, 'total_rating_count') > 0 || getNumericField(game, 'aggregated_rating_count') > 0) {
    reasons.push('popularity_boost');
  }

  if (EDITION_PENALTY_PATTERN.test(gameNameInfo.normalized) && !EDITION_PENALTY_PATTERN.test(queryInfo.normalized)) {
    reasons.push('edition_penalty');
  }

  return reasons.slice(0, 4);
}

function rankGames(query, games, options = {}) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;

  return [...games].sort((leftGame, rightGame) => {
    const scoreDifference =
      computeFuzzyScore(queryInfo, rightGame?.name, rightGame, options) -
      computeFuzzyScore(queryInfo, leftGame?.name, leftGame, options);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    const popularityDifference =
      getNumericField(rightGame, 'total_rating_count') - getNumericField(leftGame, 'total_rating_count');

    if (popularityDifference !== 0) {
      return popularityDifference;
    }

    return getNumericField(rightGame, 'first_release_date') - getNumericField(leftGame, 'first_release_date');
  });
}

module.exports = {
  buildFallbackCandidateQueries,
  buildSearchCandidateQueries,
  computeFuzzyScore,
  explainGameMatchReasons,
  mergeGamesById,
  normalizeQuery,
  normalizeNameForScoring,
  rankGames
};
