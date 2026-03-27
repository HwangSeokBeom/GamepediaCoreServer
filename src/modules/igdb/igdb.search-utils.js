const EDITION_PENALTY_PATTERN = /\b(dlc|demo|soundtrack|ost|beta|alpha|season pass|ultimate edition|collector'?s edition|collectors edition|update|bundle|pack|artbook)\b/i;
const MAX_CANDIDATE_COUNT = 5;

function normalizeQuery(query) {
  const original = typeof query === 'string' ? query : '';
  const trimmed = original.normalize('NFKC').trim();
  const lowerCased = trimmed.toLowerCase();
  const collapsedWhitespace = lowerCased.replace(/\s+/g, ' ');
  const punctuationRemoved = collapsedWhitespace
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = punctuationRemoved || collapsedWhitespace;
  const compact = normalized.replace(/\s+/g, '');

  return {
    original,
    trimmed,
    normalized,
    compact,
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

  addCandidate(candidates, queryInfo.normalized);

  if (queryInfo.compact && queryInfo.compact !== queryInfo.normalized) {
    addCandidate(candidates, queryInfo.compact);
  }

  if (firstToken.length >= 2) {
    addCandidate(candidates, `${firstToken}*`);
  }

  if (queryInfo.compact.length >= 2) {
    addCandidate(candidates, `${queryInfo.compact}*`);
  }

  if (queryInfo.tokens.length > 1 && queryInfo.normalized.length >= 2) {
    addCandidate(candidates, `${queryInfo.normalized}*`);
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
  return normalizeQuery(value).compact;
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

  if (gameNameInfo.compact === targetInfo.compact) {
    score += 520;
  } else if (gameNameInfo.compact.startsWith(targetInfo.compact)) {
    score += 280;
  } else if (gameNameInfo.compact.includes(targetInfo.compact)) {
    score += 120;
  }

  for (const candidateQuery of aliasBoost.candidateQueries ?? []) {
    const candidateInfo = normalizeQuery(candidateQuery.replace(/\*+$/g, ''));

    if (!candidateInfo.compact || candidateInfo.compact === targetInfo.compact) {
      continue;
    }

    if (gameNameInfo.compact === candidateInfo.compact) {
      score += 220;
    } else if (gameNameInfo.compact.startsWith(candidateInfo.compact)) {
      score += 160;
    } else if (gameNameInfo.compact.includes(candidateInfo.compact)) {
      score += 80;
    }
  }

  return Math.round(score * baseMultiplier);
}

function computeFuzzyScore(query, gameName, game = {}, options = {}) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const gameNameInfo = normalizeQuery(gameName);

  if (!queryInfo.compact || !gameNameInfo.compact) {
    return 0;
  }

  let score = 0;

  if (gameNameInfo.normalized === queryInfo.normalized) {
    score += 70;
  }

  if (gameNameInfo.compact === queryInfo.compact) {
    score += 90;
  } else if (gameNameInfo.compact.startsWith(queryInfo.compact)) {
    score += 200;
  } else if (gameNameInfo.normalized.startsWith(queryInfo.normalized)) {
    score += 160;
  } else if (gameNameInfo.compact.includes(queryInfo.compact)) {
    score += 120;
  } else if (gameNameInfo.normalized.includes(queryInfo.normalized)) {
    score += 100;
  }

  const firstToken = queryInfo.tokens[0] ?? '';

  if (firstToken && firstToken !== queryInfo.normalized) {
    if (gameNameInfo.normalized.startsWith(firstToken)) {
      score += 60;
    } else if (gameNameInfo.compact.includes(firstToken.replace(/\s+/g, ''))) {
      score += 30;
    }
  }

  score += Math.round(computeDiceCoefficient(queryInfo.compact, gameNameInfo.compact) * 110);
  score += Math.min(getNumericField(game, 'total_rating') * 0.6, 80);
  score += Math.min(getNumericField(game, 'aggregated_rating') * 0.4, 40);
  score += Math.min(Math.log10(getNumericField(game, 'total_rating_count') + 1) * 60, 180);
  score += Math.min(Math.log10(getNumericField(game, 'aggregated_rating_count') + 1) * 30, 90);

  if (gameNameInfo.compact.startsWith(queryInfo.compact)) {
    const suffix = gameNameInfo.compact.slice(queryInfo.compact.length);
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

  score -= Math.min(Math.max(gameNameInfo.compact.length - queryInfo.compact.length, 0) * 2, 120);

  if (EDITION_PENALTY_PATTERN.test(gameNameInfo.normalized)) {
    score -= 160;
  }

  score += computeAliasBoost(options.aliasBoost, gameNameInfo);

  return score;
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
  mergeGamesById,
  normalizeQuery,
  rankGames
};
