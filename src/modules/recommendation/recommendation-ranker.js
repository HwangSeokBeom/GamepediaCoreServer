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

function buildMatchTags({ candidate, query, platforms = [], preferredGenres = [] }) {
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

  if (tags.length < 3 && Array.isArray(candidate.genres)) {
    tags.push(...candidate.genres.slice(0, 2));
  }

  return [...new Set(tags.filter(Boolean))].slice(0, 4);
}

function buildReason({ candidate, intent }) {
  if (intent.sessionLength === 'short' && intent.mood.includes('relaxing')) {
    return '짧은 플레이 세션에서도 부담 없이 진행할 수 있고, 편안한 분위기의 콘텐츠를 즐기기 좋아요.';
  }

  if (intent.playMode === 'multiplayer') {
    return '요청한 조건과 가까운 장르와 플랫폼을 갖춘 후보라 함께 즐기기 좋은 선택지예요.';
  }

  if (candidate.rating != null && Number(candidate.rating) >= 85) {
    return '평가가 높고 요청한 취향 조건과 잘 맞아 우선 추천할 만해요.';
  }

  return '요청한 플랫폼과 장르 조건에 맞는 후보 중에서 균형 있게 즐기기 좋은 게임이에요.';
}

function scoreCandidate(candidate, { query, platforms = [], preferredGenres = [] }) {
  const normalizedQuery = normalizeText(query);
  let score = 0;

  if (candidate.rating != null && Number.isFinite(Number(candidate.rating))) {
    score += clamp(Number(candidate.rating), 0, 100) / 100;
  }

  if (hasLooseListMatch(candidate.platforms, platforms) && platforms.length > 0) {
    score += 1.2;
  }

  if (hasLooseListMatch(candidate.genres, preferredGenres) && preferredGenres.length > 0) {
    score += 1.2;
  }

  const searchableText = normalizeText([
    candidate.title,
    candidate.summary,
    ...(candidate.genres ?? []),
    ...(candidate.platforms ?? [])
  ].join(' '));

  for (const keyword of [...RELAXING_KEYWORDS, ...SHORT_SESSION_KEYWORDS]) {
    if (normalizedQuery.includes(keyword.toLowerCase()) && searchableText.includes(keyword.toLowerCase())) {
      score += 0.35;
    }
  }

  return score;
}

function rankCandidates({
  candidates,
  query,
  platforms = [],
  preferredGenres = [],
  limit
}) {
  const intent = inferIntent({ query, platforms });

  return [...(candidates ?? [])]
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, { query, platforms, preferredGenres })
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ candidate, score }) => ({
      gameId: String(candidate.gameId),
      reason: buildReason({ candidate, intent }),
      matchTags: buildMatchTags({ candidate, query, platforms, preferredGenres }),
      confidence: clamp(0.58 + score / 5, 0.55, 0.94)
    }));
}

module.exports = {
  inferIntent,
  normalizeRecommendationQuery,
  rankCandidates
};
