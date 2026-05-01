const {
  inferIntent: inferRecommendationIntent,
  normalizeRecommendationQuery
} = require('./recommendation-ranker');

const SHORT_SESSION_KEYWORDS = ['30분', '짧', '잠깐', '퇴근', '가볍', 'short', 'quick', 'casual'];
const RELAXING_KEYWORDS = ['힐링', '편안', '느긋', '잔잔', '코지', 'cozy', 'relax', 'relaxing', 'chill'];
const MULTIPLAYER_KEYWORDS = ['친구', '같이', '함께', '멀티', '협동', 'multi', 'coop', 'co-op'];
const LOW_DIFFICULTY_KEYWORDS = ['쉽', '어렵지', '입문', '초보', 'easy', 'beginner'];
const ROGUELIKE_KEYWORDS = ['로그라이크', '로그라이트', 'roguelike', 'roguelite'];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : '';
}

function normalizeList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
}

function normalizeToken(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, '');
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

function extractKeywords({ query, genres = [] }) {
  const normalizedQuery = normalizeText(query);
  const keywords = [];

  if (includesAny(normalizedQuery, RELAXING_KEYWORDS)) {
    keywords.push('힐링');
  }

  if (includesAny(normalizedQuery, SHORT_SESSION_KEYWORDS)) {
    keywords.push('짧은 세션');
  }

  if (includesAny(normalizedQuery, MULTIPLAYER_KEYWORDS)) {
    keywords.push('친구와 함께');
  }

  if (includesAny(normalizedQuery, LOW_DIFFICULTY_KEYWORDS)) {
    keywords.push('쉬운 난이도');
  }

  if (includesAny(normalizedQuery, ROGUELIKE_KEYWORDS)) {
    keywords.push('로그라이크');
  }

  keywords.push(...normalizeList(genres).slice(0, 3));

  return [...new Set(keywords)].slice(0, 8);
}

function inferSearchIntent({ query, platforms = [], genres = [] }) {
  const normalizedQuery = normalizeText(query);
  const baseIntent = inferRecommendationIntent({ query, platforms });
  const keywords = extractKeywords({ query, genres });

  return {
    mood: baseIntent.mood,
    sessionLength: baseIntent.sessionLength,
    playMode: includesAny(normalizedQuery, MULTIPLAYER_KEYWORDS) ? 'multiplayer' : baseIntent.playMode,
    difficulty: includesAny(normalizedQuery, LOW_DIFFICULTY_KEYWORDS) ? 'low' : baseIntent.difficulty,
    platforms: normalizeList(platforms),
    genres: normalizeList(genres),
    keywords
  };
}

function normalizeSearchQuery(query, intent) {
  const trimmedQuery = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';

  if (intent.sessionLength === 'short' && intent.mood.includes('relaxing')) {
    return '짧게 즐길 수 있는 힐링 게임';
  }

  if (intent.playMode === 'multiplayer' && intent.platforms.some((platform) => normalizeToken(platform).includes('nintendoswitch'))) {
    return '친구와 함께 즐길 수 있는 스위치 게임';
  }

  if (intent.keywords.includes('로그라이크') && intent.difficulty === 'low') {
    return '어렵지 않은 로그라이크 게임';
  }

  return normalizeRecommendationQuery(trimmedQuery, intent);
}

function buildSuggestedQueries({ query, intent }) {
  const suggestions = [
    normalizeSearchQuery(query, intent)
  ];

  if (intent.sessionLength === 'short') {
    suggestions.push('짧게 즐기는 게임');
  }

  if (intent.mood.includes('relaxing')) {
    suggestions.push('퇴근 후 가볍게 할 수 있는 게임');
  }

  if (intent.playMode === 'multiplayer') {
    suggestions.push('친구랑 같이 할 수 있는 게임');
  }

  if (intent.platforms.some((platform) => normalizeToken(platform).includes('nintendoswitch'))) {
    suggestions.push('스위치 감성 어드벤처 게임');
  }

  if (intent.keywords.includes('로그라이크')) {
    suggestions.push('입문하기 좋은 로그라이크');
  }

  return [...new Set(suggestions)]
    .map((suggestion) => suggestion.trim())
    .filter((suggestion) => suggestion.length >= 2 && suggestion.length <= 60)
    .slice(0, 5);
}

function buildMatchTags({ candidate, query, platforms = [], genres = [], intent }) {
  const tags = [];

  tags.push(...(intent.keywords ?? []).slice(0, 3));

  if (platforms.length > 0 && hasLooseListMatch(candidate.platforms, platforms)) {
    tags.push('플랫폼 매칭');
  }

  if (genres.length > 0 && hasLooseListMatch(candidate.genres, genres)) {
    tags.push('장르 매칭');
  }

  if (tags.length < 3) {
    tags.push(...normalizeList(candidate.genres).slice(0, 2));
  }

  if (tags.length < 3) {
    tags.push(...normalizeList(candidate.platforms).slice(0, 1));
  }

  return [...new Set(tags.filter(Boolean))].slice(0, 4);
}

function buildMatchReason({ candidate, intent }) {
  if (intent.sessionLength === 'short' && intent.mood.includes('relaxing')) {
    return '짧은 세션으로도 부담 없이 즐기기 좋고 편안한 분위기의 후보 게임입니다.';
  }

  if (intent.playMode === 'multiplayer') {
    return '요청한 플랫폼과 장르 조건에 가까워 친구와 함께 즐길 후보로 적합합니다.';
  }

  if (intent.keywords.includes('로그라이크') && intent.difficulty === 'low') {
    return '반복 플레이 구조를 갖춘 후보 중 비교적 가볍게 접근하기 좋은 선택지입니다.';
  }

  if (candidate.rating != null && Number(candidate.rating) >= 85) {
    return '평가가 높고 입력한 검색 의도와 조건에 잘 맞는 후보 게임입니다.';
  }

  return '입력한 자연어 검색 의도와 플랫폼/장르 조건을 기준으로 잘 맞는 후보 게임입니다.';
}

function scoreCandidate(candidate, { query, platforms = [], genres = [], intent }) {
  const searchableText = normalizeText([
    candidate.title,
    candidate.summary,
    ...(candidate.platforms ?? []),
    ...(candidate.genres ?? [])
  ].join(' '));
  let score = 0;

  if (candidate.rating != null && Number.isFinite(Number(candidate.rating))) {
    score += clamp(Number(candidate.rating), 0, 100) / 100;
  }

  if (platforms.length > 0 && hasLooseListMatch(candidate.platforms, platforms)) {
    score += 1.25;
  }

  if (genres.length > 0 && hasLooseListMatch(candidate.genres, genres)) {
    score += 1.25;
  }

  for (const keyword of [...RELAXING_KEYWORDS, ...SHORT_SESSION_KEYWORDS, ...MULTIPLAYER_KEYWORDS, ...ROGUELIKE_KEYWORDS]) {
    if (normalizeText(query).includes(keyword.toLowerCase()) && searchableText.includes(keyword.toLowerCase())) {
      score += 0.35;
    }
  }

  for (const keyword of intent.keywords ?? []) {
    if (searchableText.includes(normalizeText(keyword))) {
      score += 0.25;
    }
  }

  return score;
}

function rankSearchCandidates({
  candidates,
  query,
  platforms = [],
  genres = [],
  limit
}) {
  const intent = inferSearchIntent({ query, platforms, genres });

  return [...(candidates ?? [])]
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, { query, platforms, genres, intent })
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ candidate, score }) => ({
      gameId: String(candidate.gameId),
      matchReason: buildMatchReason({ candidate, intent }),
      matchTags: buildMatchTags({ candidate, query, platforms, genres, intent }),
      confidence: clamp(0.56 + score / 5, 0.52, 0.94)
    }));
}

module.exports = {
  buildMatchReason,
  buildMatchTags,
  buildSuggestedQueries,
  inferSearchIntent,
  normalizeSearchQuery,
  rankSearchCandidates
};
