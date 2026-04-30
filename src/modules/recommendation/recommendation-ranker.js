const SHORT_SESSION_KEYWORDS = [
  '30분',
  '짧',
  '잠깐',
  '퇴근',
  '가볍',
  'short',
  'quick',
  'casual'
];
const RELAXING_KEYWORDS = [
  '힐링',
  '편안',
  '느긋',
  '잔잔',
  '코지',
  'cozy',
  'relax',
  'relaxing',
  'chill'
];
const MULTIPLAYER_KEYWORDS = ['친구', '멀티', '협동', 'multi', 'coop', 'co-op'];
const HARD_KEYWORDS = ['어려', '하드', '도전', '소울', 'hard', 'difficult', 'challenge'];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : '';
}

function normalizeToken(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function normalizeSignalValues(signals) {
  if (!Array.isArray(signals)) {
    return [];
  }

  return signals
    .map((signal) => (typeof signal === 'string' ? signal : signal?.value))
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function hasLooseListMatch(actualValues, requestedValues) {
  const actualTokens = normalizeList(actualValues).map(normalizeToken).filter(Boolean);
  const requestedTokens = normalizeList(requestedValues).map(normalizeToken).filter(Boolean);

  if (requestedTokens.length === 0) {
    return true;
  }

  return requestedTokens.some((requestedToken) => actualTokens.some((actualToken) => (
    actualToken.includes(requestedToken) || requestedToken.includes(actualToken)
  )));
}

function findLooseMatches(actualValues, requestedValues) {
  const normalizedActual = normalizeList(actualValues)
    .map((value) => ({ value, token: normalizeToken(value) }))
    .filter((item) => item.token);
  const normalizedRequested = normalizeList(requestedValues)
    .map((value) => ({ value, token: normalizeToken(value) }))
    .filter((item) => item.token);
  const matches = [];

  for (const requested of normalizedRequested) {
    const matchedActual = normalizedActual.find((actual) => (
      actual.token.includes(requested.token) || requested.token.includes(actual.token)
    ));

    if (matchedActual) {
      matches.push(matchedActual.value);
    }
  }

  return [...new Set(matches)];
}

function inferIntent({ query, platforms = [] }) {
  const normalizedQuery = normalizeText(query);
  const mood = [];

  if (includesAny(normalizedQuery, RELAXING_KEYWORDS)) {
    mood.push('relaxing', 'cozy');
  }

  if (includesAny(normalizedQuery, ['공포', '무서', 'horror', 'scary'])) {
    mood.push('tense');
  }

  if (includesAny(normalizedQuery, ['몰입', '스토리', 'story', 'narrative'])) {
    mood.push('story-rich');
  }

  return {
    mood: mood.length > 0 ? [...new Set(mood)] : ['balanced'],
    sessionLength: includesAny(normalizedQuery, SHORT_SESSION_KEYWORDS) ? 'short' : 'flexible',
    playMode: includesAny(normalizedQuery, MULTIPLAYER_KEYWORDS) ? 'multiplayer' : 'singleplayer',
    difficulty: includesAny(normalizedQuery, HARD_KEYWORDS) ? 'high' : 'low',
    platforms: normalizeList(platforms)
  };
}

function normalizeRecommendationQuery(query, intent) {
  const trimmedQuery = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';

  if (intent.sessionLength === 'short' && intent.mood.includes('relaxing')) {
    return '퇴근 후 짧게 즐길 수 있는 힐링 게임';
  }

  return trimmedQuery;
}

function buildMatchTags({
  candidate,
  query,
  platforms = [],
  preferredGenres = [],
  personalizationSignals = []
}) {
  const tags = [];
  const normalizedQuery = normalizeText(query);

  if (includesAny(normalizedQuery, RELAXING_KEYWORDS)) {
    tags.push('힐링');
  }

  if (includesAny(normalizedQuery, SHORT_SESSION_KEYWORDS)) {
    tags.push('짧은 세션');
  }

  if (hasLooseListMatch(candidate.platforms, platforms) && platforms.length > 0) {
    tags.push('플랫폼 매칭');
  }

  if (hasLooseListMatch(candidate.genres, preferredGenres) && preferredGenres.length > 0) {
    tags.push('장르 매칭');
  }

  if (personalizationSignals.includes('highRatedGenreMatch')) {
    tags.push('고평점 취향');
  } else if (personalizationSignals.includes('favoriteGenreMatch')) {
    tags.push('찜 기반');
  } else if (personalizationSignals.includes('playedGenreMatch')) {
    tags.push('플레이 이력');
  }

  if (tags.length < 3 && Array.isArray(candidate.genres)) {
    tags.push(...candidate.genres.slice(0, 2));
  }

  return [...new Set(tags.filter(Boolean))].slice(0, 4);
}

function buildReason({ candidate, intent, personalizationSignals = [], personalizationAvailable = false }) {
  if (personalizationSignals.includes('highRatedGenreMatch')) {
    return '최근 높게 평가한 게임과 비슷한 장르와 분위기를 가진 추천이에요.';
  }

  if (personalizationSignals.includes('favoriteGenreMatch')) {
    return '찜한 게임의 장르와 잘 맞는 추천이에요.';
  }

  if (personalizationSignals.includes('playedGenreMatch')) {
    return '플레이 이력이 있는 게임과 취향 신호가 겹치는 추천이에요.';
  }

  if (intent.sessionLength === 'short' && intent.mood.includes('relaxing')) {
    return '짧은 플레이 세션에서도 부담 없이 진행할 수 있고, 편안한 분위기의 콘텐츠를 즐기기 좋아요.';
  }

  if (intent.playMode === 'multiplayer') {
    return '요청한 조건과 가까운 장르와 플랫폼을 갖춘 후보라 함께 즐기기 좋은 선택지예요.';
  }

  if (candidate.rating != null && Number(candidate.rating) >= 85) {
    return '평가가 높고 요청한 취향 조건과 잘 맞아 우선 추천할 만해요.';
  }

  if (!personalizationAvailable) {
    return '개인화 데이터가 부족해 인기와 장르 기준으로 추천했어요.';
  }

  return '요청한 플랫폼과 장르 조건에 맞는 후보 중에서 균형 있게 즐기기 좋은 게임이에요.';
}

function scoreCandidate(candidate, { query, platforms = [], preferredGenres = [] }) {
  const normalizedQuery = normalizeText(query);
  let score = 0;
  const breakdown = {
    rating: 0,
    platform: 0,
    genre: 0,
    queryIntent: 0
  };

  if (candidate.rating != null && Number.isFinite(Number(candidate.rating))) {
    breakdown.rating = clamp(Number(candidate.rating), 0, 100) / 100;
    score += breakdown.rating;
  }

  if (hasLooseListMatch(candidate.platforms, platforms) && platforms.length > 0) {
    breakdown.platform = 1.2;
    score += breakdown.platform;
  }

  if (hasLooseListMatch(candidate.genres, preferredGenres) && preferredGenres.length > 0) {
    breakdown.genre = 1.2;
    score += breakdown.genre;
  }

  const searchableText = normalizeText([
    candidate.title,
    candidate.summary,
    ...(candidate.genres ?? []),
    ...(candidate.themes ?? []),
    ...(candidate.keywords ?? []),
    ...(candidate.platforms ?? [])
  ].join(' '));

  for (const keyword of [...RELAXING_KEYWORDS, ...SHORT_SESSION_KEYWORDS]) {
    if (normalizedQuery.includes(keyword.toLowerCase()) && searchableText.includes(keyword.toLowerCase())) {
      breakdown.queryIntent += 0.35;
      score += 0.35;
    }
  }

  return {
    score,
    breakdown
  };
}

function scorePersonalization(candidate, personalizationProfile = null) {
  if (!personalizationProfile?.personalizationAvailable) {
    return {
      score: 0,
      signals: [],
      matchedUserSignals: [],
      breakdown: {
        personalization: 0,
        negativePersonalization: 0
      }
    };
  }

  const signals = [];
  const matchedUserSignals = [];
  let score = 0;
  let negativeScore = 0;
  const favoriteGenreMatches = findLooseMatches(candidate.genres, normalizeSignalValues(personalizationProfile.signalSets?.likedGenres));
  const highRatedGenreMatches = findLooseMatches(candidate.genres, normalizeSignalValues(personalizationProfile.signalSets?.highRatedGenres));
  const playedGenreMatches = findLooseMatches(candidate.genres, normalizeSignalValues(personalizationProfile.signalSets?.playedGenres));
  const topGenreMatches = findLooseMatches(candidate.genres, normalizeSignalValues(personalizationProfile.topGenres));
  const topThemeMatches = findLooseMatches(candidate.themes, normalizeSignalValues(personalizationProfile.topThemes));
  const topKeywordMatches = findLooseMatches(candidate.keywords, normalizeSignalValues(personalizationProfile.topKeywords));
  const platformMatches = findLooseMatches(candidate.platforms, normalizeSignalValues(personalizationProfile.preferredPlatforms));
  const avoidGenreMatches = findLooseMatches(candidate.genres, normalizeSignalValues(personalizationProfile.avoidGenres));

  if (highRatedGenreMatches.length > 0) {
    const value = Math.min(1.4, highRatedGenreMatches.length * 0.7);
    score += value;
    signals.push('highRatedGenreMatch');
    matchedUserSignals.push(...highRatedGenreMatches.map((match) => `highRatedGenre:${match}`));
  }

  if (favoriteGenreMatches.length > 0) {
    const value = Math.min(1.1, favoriteGenreMatches.length * 0.55);
    score += value;
    signals.push('favoriteGenreMatch');
    matchedUserSignals.push(...favoriteGenreMatches.map((match) => `favoriteGenre:${match}`));
  }

  if (playedGenreMatches.length > 0) {
    const value = Math.min(0.8, playedGenreMatches.length * 0.4);
    score += value;
    signals.push('playedGenreMatch');
    matchedUserSignals.push(...playedGenreMatches.map((match) => `playedGenre:${match}`));
  }

  if (topGenreMatches.length > 0) {
    score += Math.min(0.7, topGenreMatches.length * 0.25);
    signals.push('topGenreMatch');
  }

  if (topThemeMatches.length > 0) {
    score += Math.min(0.5, topThemeMatches.length * 0.25);
    signals.push('topThemeMatch');
  }

  if (topKeywordMatches.length > 0) {
    score += Math.min(0.45, topKeywordMatches.length * 0.15);
    signals.push('topKeywordMatch');
  }

  if (platformMatches.length > 0) {
    score += Math.min(0.4, platformMatches.length * 0.2);
    signals.push('preferredPlatformMatch');
  }

  if (avoidGenreMatches.length > 0) {
    negativeScore = Math.min(1.2, avoidGenreMatches.length * 0.6);
    score -= negativeScore;
    signals.push('lowRatedGenrePenalty');
    matchedUserSignals.push(...avoidGenreMatches.map((match) => `lowRatedGenre:${match}`));
  }

  return {
    score,
    signals: [...new Set(signals)],
    matchedUserSignals: [...new Set(matchedUserSignals)].slice(0, 8),
    breakdown: {
      personalization: Math.max(score + negativeScore, 0),
      negativePersonalization: negativeScore
    }
  };
}

function rankCandidateDetails({
  candidates,
  query,
  platforms = [],
  preferredGenres = [],
  personalizationProfile = null,
  knownGameIdsForPenalty = []
}) {
  const knownGameIdSet = new Set((knownGameIdsForPenalty ?? []).map((gameId) => String(gameId)));

  return [...(candidates ?? [])]
    .map((candidate) => {
      const baseScore = scoreCandidate(candidate, { query, platforms, preferredGenres });
      const personalizationScore = scorePersonalization(candidate, personalizationProfile);
      const duplicatePenalty = knownGameIdSet.has(String(candidate.gameId)) ? 0.8 : 0;
      const score = baseScore.score + personalizationScore.score - duplicatePenalty;

      return {
        candidate,
        score,
        scoreBreakdown: {
          ...baseScore.breakdown,
          ...personalizationScore.breakdown,
          duplicatePenalty
        },
        personalizationSignals: personalizationScore.signals,
        matchedUserSignals: personalizationScore.matchedUserSignals,
        candidateSource: candidate.candidateSource ?? 'candidate_provider'
      };
    })
    .sort((left, right) => right.score - left.score || String(left.candidate.gameId).localeCompare(String(right.candidate.gameId)));
}

function rankCandidates({
  candidates,
  query,
  platforms = [],
  preferredGenres = [],
  limit,
  personalizationProfile = null,
  knownGameIdsForPenalty = []
}) {
  const intent = inferIntent({ query, platforms });

  return rankCandidateDetails({
    candidates,
    query,
    platforms,
    preferredGenres,
    personalizationProfile,
    knownGameIdsForPenalty
  })
    .slice(0, limit)
    .map(({ candidate, score, scoreBreakdown, personalizationSignals, matchedUserSignals, candidateSource }) => ({
      gameId: String(candidate.gameId),
      reason: buildReason({
        candidate,
        intent,
        personalizationSignals,
        personalizationAvailable: Boolean(personalizationProfile?.personalizationAvailable)
      }),
      matchTags: buildMatchTags({
        candidate,
        query,
        platforms,
        preferredGenres,
        personalizationSignals
      }),
      confidence: clamp(0.58 + score / 5, 0.55, 0.94),
      score,
      scoreBreakdown,
      personalizationSignals,
      matchedUserSignals,
      candidateSource
    }));
}

module.exports = {
  inferIntent,
  normalizeRecommendationQuery,
  rankCandidateDetails,
  rankCandidates
};
