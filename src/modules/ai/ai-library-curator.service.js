const crypto = require('crypto');
const { prisma } = require('../../config/prisma');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../utils/error-response');
const aiClient = require('./ai.client');
const {
  buildLibraryCuratorSystemPrompt,
  buildLibraryCuratorUserPrompt
} = require('./ai-library-curator.prompt');
const {
  normalizeTasteProfile,
  normalizeText,
  normalizeTextList,
  validateLlmLibraryCuratorResponse
} = require('./ai-library-curator.validator');
const igdbService = require('../igdb/igdb.service');
const {
  buildGameImageResolverUrl,
  extractUsableIgdbCoverUrl
} = require('../library/library-image.service');

const MAX_SOURCE_ROWS = 80;
const MAX_LLM_CANDIDATES = 30;
const DEFAULT_LIMIT = 5;
const responseCache = new Map();

const MODE_SECTION_IDS = {
  overview: 'overview',
  today: 'today',
  rediscover: 'rediscover',
  short_session: 'short_session',
  review_insight: 'review_insight'
};

const SHORT_SESSION_TAGS = [
  'indie',
  'casual',
  'puzzle',
  'roguelike',
  'roguelite',
  'arcade',
  'platform',
  'platformer',
  'adventure',
  'visual novel',
  'simulation',
  'simulator'
];

const LOCALE_TEXT = {
  ko: {
    fallbackTitle: '라이브러리 전체 분석',
    fallbackBody: '보유 게임, 플레이 시간, 리뷰 데이터를 기준으로 어울리는 게임을 골랐어요.',
    sectionTitle: '추천 결과',
    sectionDescription: '서버의 라이브러리 신호를 기준으로 고른 게임입니다.',
    defaultReason: '플레이 기록과 취향 신호가 잘 맞아요.',
    noCandidatesTitle: '추천할 후보가 부족해요',
    noCandidatesBody: '보유 게임, 찜, 리뷰 데이터가 쌓이면 더 정확한 큐레이션을 만들 수 있어요.',
    noCandidatesBullet: 'Steam 라이브러리 동기화, 찜, 리뷰를 추가해 보세요.',
    todayTitle: '오늘 이어가기 좋은 게임',
    rediscoverTitle: '다시 꺼내기 좋은 게임',
    shortTitle: '짧게 즐기기 좋은 게임',
    reviewTitle: '리뷰 성향 분석',
    overviewTitle: '라이브러리 전체 분석',
    modeSummaries: {
      overview: {
        title: '라이브러리 전체 분석',
        body: '보유 게임, 플레이 시간, 리뷰 데이터를 기준으로 라이브러리를 분석했어요.'
      },
      today: {
        title: '오늘 이어가기 좋은 게임',
        body: '지금 바로 이어가기 좋은 게임을 골랐어요.'
      },
      rediscover: {
        title: '다시 꺼내기 좋은 게임',
        body: '한동안 쉬었거나 다시 플레이하기 좋은 게임을 골랐어요.'
      },
      short_session: {
        title: '짧게 즐기기 좋은 게임',
        body: '짧은 시간에 부담 없이 즐기기 좋은 게임을 골랐어요.'
      },
      review_insight: {
        title: '리뷰 성향 분석',
        body: '작성한 리뷰와 평점을 기준으로 취향을 정리했어요.'
      }
    },
    reasonByMode: {
      overview: '플레이 기록과 취향 신호가 잘 맞아요.',
      today: '지금 바로 이어가기 좋은 후보예요.',
      rediscover: '한동안 쉬었거나 다시 플레이하기 좋은 게임이에요.',
      short_session: '짧게 즐기기 좋은 후보예요.',
      review_insight: '리뷰 평점이 높아 다시 추천할 만해요.'
    }
  },
  en: {
    fallbackTitle: 'Library Curator',
    fallbackBody: 'Here are picks based on your owned games, favorites, reviews, and playtime.',
    sectionTitle: 'Recommended picks',
    sectionDescription: 'Selected from your library signals.',
    defaultReason: 'This candidate fits your library signals.',
    noCandidatesTitle: 'Not enough library candidates',
    noCandidatesBody: 'Sync Steam, add favorites, or write reviews to improve curation.',
    noCandidatesBullet: 'Add owned, favorited, or reviewed games first.',
    todayTitle: 'Good picks for today',
    rediscoverTitle: 'Worth rediscovering',
    shortTitle: 'Good for a short session',
    reviewTitle: 'Review taste insight',
    overviewTitle: 'Your library taste profile'
  },
  ja: {
    fallbackTitle: 'ライブラリキュレーター',
    fallbackBody: '所持ゲーム、ウィッシュリスト、レビュー、プレイ時間をもとに候補を整理しました。',
    sectionTitle: 'おすすめ候補',
    sectionDescription: 'ライブラリのシグナルをもとに選んだゲームです。',
    defaultReason: 'ライブラリの傾向に合う候補です。',
    noCandidatesTitle: '候補が不足しています',
    noCandidatesBody: 'Steam連携、ウィッシュリスト、レビューが増えると精度が上がります。',
    noCandidatesBullet: 'まずは所持ゲーム、ウィッシュリスト、レビューを追加してください。',
    todayTitle: '今日遊びたいゲーム',
    rediscoverTitle: 'もう一度遊びたいゲーム',
    shortTitle: '短時間で遊びやすいゲーム',
    reviewTitle: 'レビュー傾向',
    overviewTitle: 'ライブラリ嗜好まとめ'
  },
  'zh-Hans': {
    fallbackTitle: '库策展助手',
    fallbackBody: '根据已拥有游戏、收藏、评论和游玩时长整理了候选游戏。',
    sectionTitle: '推荐候选',
    sectionDescription: '基于你的游戏库信号挑选。',
    defaultReason: '这个候选符合你的游戏库偏好。',
    noCandidatesTitle: '候选游戏不足',
    noCandidatesBody: '同步 Steam、添加收藏或评论后，推荐会更准确。',
    noCandidatesBullet: '请先添加已拥有、收藏或评论过的游戏。',
    todayTitle: '今天适合玩的游戏',
    rediscoverTitle: '值得重新游玩的游戏',
    shortTitle: '适合短时间游玩的游戏',
    reviewTitle: '评论偏好洞察',
    overviewTitle: '你的游戏库偏好'
  }
};

function getLocaleText(locale) {
  return LOCALE_TEXT[locale] ?? LOCALE_TEXT.ko;
}

function padTwoDigits(value) {
  return String(value).padStart(2, '0');
}

function getKstDateParts(now = new Date()) {
  const kstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  return {
    year: kstDate.getUTCFullYear(),
    month: kstDate.getUTCMonth() + 1,
    day: kstDate.getUTCDate()
  };
}

function getNextKstReset({ now = new Date() } = {}) {
  const { year, month, day } = getKstDateParts(now);
  const resetUtcMs = Date.UTC(year, month - 1, day + 1, 0, 0, 0) - 9 * 60 * 60 * 1000;
  const resetDate = new Date(resetUtcMs);
  const resetKst = getKstDateParts(resetDate);
  const resetAt = `${resetKst.year}-${padTwoDigits(resetKst.month)}-${padTwoDigits(resetKst.day)}T00:00:00+09:00`;

  return {
    resetAt,
    retryAfterSeconds: Math.max(Math.ceil((resetUtcMs - now.getTime()) / 1000), 0)
  };
}

function getUsageDate({ now = new Date(), timeZone = 'Asia/Seoul' } = {}) {
  const usageDateText = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  return new Date(`${usageDateText}T00:00:00.000Z`);
}

function normalizeGameId(gameId) {
  const value = typeof gameId === 'string' ? gameId.trim() : String(gameId ?? '').trim();
  return value || null;
}

function normalizeNumber(value) {
  if (value == null) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function uniqueStrings(values, limit = 12) {
  return normalizeTextList(values, { maxItems: limit, maxLength: 50 });
}

function buildRequestId() {
  return `ai-lib-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeExcludedGameIds(gameIds) {
  return [...new Set((gameIds ?? [])
    .map(normalizeGameId)
    .filter(Boolean))];
}

function buildCandidateHash(candidates) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify((candidates ?? []).map((candidate) => ({
    gameId: candidate.gameId,
    score: Math.round(candidate.score * 100),
    favorite: candidate.isFavorite,
    review: candidate.hasReview,
    playtime: candidate.playtimeMinutes ?? 0,
    lastPlayedAt: candidate.lastPlayedAt ?? null
  }))));
  return hash.digest('hex').slice(0, 16);
}

function buildCacheKey({
  userId,
  query,
  mode,
  limit,
  locale,
  candidateScope,
  excludedGameIds,
  candidateHash
}) {
  return JSON.stringify({
    userId,
    query: query ?? '',
    mode,
    limit,
    locale,
    candidateScope,
    excludedGameIds: [...normalizeExcludedGameIds(excludedGameIds)].sort(),
    candidateHash
  });
}

function readCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(cacheKey);
    return null;
  }

  return JSON.parse(JSON.stringify(cached.value));
}

function writeCachedResponse(cacheKey, value) {
  if (env.aiLibraryCuratorCacheTtlSeconds <= 0) {
    return;
  }

  responseCache.set(cacheKey, {
    value: JSON.parse(JSON.stringify(value)),
    expiresAt: Date.now() + env.aiLibraryCuratorCacheTtlSeconds * 1000
  });
}

async function assertAndIncrementLibraryCuratorUsage({ userId, locale = 'ko' }) {
  const usageDate = getUsageDate();
  const reset = getNextKstReset();

  await prisma.$transaction(async (tx) => {
    const usage = await tx.aiUsageLimit.upsert({
      where: {
        userId_usageDate: {
          userId,
          usageDate
        }
      },
      create: {
        userId,
        usageDate,
        recommendationCount: 1
      },
      update: {
        recommendationCount: {
          increment: 1
        }
      }
    });

    if (usage.recommendationCount > env.aiLibraryCuratorDailyLimit) {
      logger.warn('[LibraryCurator] dailyLimitExceeded', {
        userId,
        count: usage.recommendationCount - 1,
        attemptedCount: usage.recommendationCount,
        limit: env.aiLibraryCuratorDailyLimit,
        usageDate: usageDate.toISOString().slice(0, 10),
        resetAt: reset.resetAt
      });
      throw new AppError(
        429,
        'AI_LIBRARY_CURATOR_DAILY_LIMIT_EXCEEDED',
        locale === 'ko'
          ? '오늘의 AI 라이브러리 분석 한도를 모두 사용했어요. 기존 결과는 계속 볼 수 있고, 내일 다시 분석할 수 있어요.'
          : 'Daily AI library curator limit exceeded',
        reset
      );
    }
  });
}

function shouldReadOwned(scope) {
  return scope === 'owned' || scope === 'mixed';
}

function shouldReadFavorites(scope) {
  return scope === 'favorites' || scope === 'mixed';
}

function shouldReadReviewed(scope) {
  return scope === 'reviewed' || scope === 'mixed';
}

async function fetchLibrarySignals({ userId, candidateScope }) {
  const [libraryEntries, favoriteRows, reviewRows] = await Promise.all([
    shouldReadOwned(candidateScope)
      ? prisma.userGameLibrary.findMany({
        where: { userId },
        orderBy: [
          { lastPlayedAt: 'desc' },
          { updatedAt: 'desc' }
        ],
        take: MAX_SOURCE_ROWS,
        select: {
          gameSource: true,
          externalGameId: true,
          gameName: true,
          coverUrl: true,
          playtimeMinutes: true,
          lastPlayedAt: true,
          updatedAt: true
        }
      })
      : [],
    shouldReadFavorites(candidateScope)
      ? prisma.favoriteGame.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: MAX_SOURCE_ROWS,
        select: {
          gameId: true,
          createdAt: true
        }
      })
      : [],
    shouldReadReviewed(candidateScope)
      ? prisma.review.findMany({
        where: { userId },
        orderBy: [
          { updatedAt: 'desc' },
          { createdAt: 'desc' }
        ],
        take: MAX_SOURCE_ROWS,
        select: {
          gameId: true,
          rating: true,
          content: true,
          createdAt: true,
          updatedAt: true
        }
      })
      : []
  ]);

  return {
    libraryEntries,
    favoriteRows,
    reviewRows
  };
}

async function resolveSteamMappings(libraryEntries) {
  const steamAppIds = [...new Set((libraryEntries ?? [])
    .filter((entry) => String(entry.gameSource) === 'STEAM')
    .map((entry) => normalizeGameId(entry.externalGameId))
    .filter(Boolean))];

  if (steamAppIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.steamIgdbMapping.findMany({
    where: {
      steamAppId: {
        in: steamAppIds
      },
      igdbGameId: {
        not: null
      },
      matchStatus: {
        in: ['CONFIRMED', 'CANDIDATE']
      }
    },
    select: {
      steamAppId: true,
      igdbGameId: true,
      matchedTitle: true,
      matchStatus: true,
      confidenceScore: true
    }
  });

  return new Map(rows
    .filter((row) => normalizeGameId(row.igdbGameId))
    .map((row) => [row.steamAppId, row]));
}

function resolveLibraryGameId(entry, steamMappingByAppId) {
  const externalGameId = normalizeGameId(entry?.externalGameId);

  if (!externalGameId) {
    return null;
  }

  if (String(entry?.gameSource) === 'IGDB') {
    return externalGameId;
  }

  if (String(entry?.gameSource) === 'STEAM') {
    return normalizeGameId(steamMappingByAppId.get(externalGameId)?.igdbGameId) ?? externalGameId;
  }

  return externalGameId;
}

function isBetterText(value, previousValue) {
  return Boolean(value && (!previousValue || String(value).length > String(previousValue).length));
}

function mergeCandidate(candidateMap, patch) {
  const gameId = normalizeGameId(patch?.gameId);

  if (!gameId) {
    return;
  }

  const existing = candidateMap.get(gameId) ?? {
    gameId,
    candidateId: gameId,
    title: null,
    coverUrl: null,
    genres: [],
    themes: [],
    keywords: [],
    platforms: [],
    rating: null,
    source: null,
    gameSource: null,
    externalGameId: null,
    igdbGameId: null,
    playtimeMinutes: null,
    lastPlayedAt: null,
    isFavorite: false,
    hasReview: false,
    userRating: null,
    reviewExcerpt: null,
    latestReviewAt: null,
    signalSources: []
  };

  const preserveOwnedIdentity = existing.source === 'owned' && patch.source !== 'owned';
  const merged = {
    ...existing,
    ...patch,
    title: isBetterText(patch.title, existing.title) ? patch.title : existing.title,
    coverUrl: patch.coverUrl ?? existing.coverUrl,
    genres: uniqueStrings([...(existing.genres ?? []), ...(patch.genres ?? [])], 10),
    themes: uniqueStrings([...(existing.themes ?? []), ...(patch.themes ?? [])], 10),
    keywords: uniqueStrings([...(existing.keywords ?? []), ...(patch.keywords ?? [])], 12),
    platforms: uniqueStrings([...(existing.platforms ?? []), ...(patch.platforms ?? [])], 10),
    rating: patch.rating ?? existing.rating,
    playtimeMinutes: patch.playtimeMinutes ?? existing.playtimeMinutes,
    lastPlayedAt: patch.lastPlayedAt ?? existing.lastPlayedAt,
    isFavorite: Boolean(existing.isFavorite || patch.isFavorite),
    hasReview: Boolean(existing.hasReview || patch.hasReview),
    userRating: patch.userRating ?? existing.userRating,
    reviewExcerpt: patch.reviewExcerpt ?? existing.reviewExcerpt,
    latestReviewAt: patch.latestReviewAt ?? existing.latestReviewAt,
    signalSources: uniqueStrings([...(existing.signalSources ?? []), ...(patch.signalSources ?? [])], 6),
    gameSource: preserveOwnedIdentity ? existing.gameSource : (patch.gameSource ?? existing.gameSource),
    externalGameId: preserveOwnedIdentity ? existing.externalGameId : (patch.externalGameId ?? existing.externalGameId),
    igdbGameId: existing.igdbGameId ?? patch.igdbGameId ?? null
  };

  if (existing.source === 'owned' || patch.source === 'owned') {
    merged.source = 'owned';
  } else if (existing.source === 'reviewed' || patch.source === 'reviewed') {
    merged.source = 'reviewed';
  } else if (existing.source === 'favorites' || patch.source === 'favorites') {
    merged.source = 'favorites';
  } else {
    merged.source = patch.source ?? existing.source;
  }

  candidateMap.set(gameId, merged);
}

function buildReviewExcerpt(content) {
  return normalizeText(content, 200) || null;
}

function applyLibraryRows(candidateMap, libraryEntries, steamMappingByAppId) {
  for (const entry of libraryEntries ?? []) {
    const gameId = resolveLibraryGameId(entry, steamMappingByAppId);

    if (!gameId) {
      continue;
    }

    const externalGameId = normalizeGameId(entry.externalGameId);
    const mapping = steamMappingByAppId.get(externalGameId);
    const gameSource = String(entry.gameSource).toLowerCase();

    mergeCandidate(candidateMap, {
      gameId,
      candidateId: gameId,
      title: normalizeText(mapping?.matchedTitle ?? entry.gameName, 120) || null,
      coverUrl: entry.coverUrl ?? null,
      source: 'owned',
      gameSource,
      externalGameId,
      igdbGameId: gameSource === 'igdb' ? externalGameId : (normalizeGameId(mapping?.igdbGameId) ?? null),
      playtimeMinutes: normalizeNumber(entry.playtimeMinutes),
      lastPlayedAt: entry.lastPlayedAt ? new Date(entry.lastPlayedAt).toISOString() : null,
      signalSources: ['owned']
    });
  }
}

function applyFavoriteRows(candidateMap, favoriteRows) {
  for (const row of favoriteRows ?? []) {
    const gameId = normalizeGameId(row.gameId);

    if (!gameId) {
      continue;
    }

    mergeCandidate(candidateMap, {
      gameId,
      candidateId: gameId,
      source: 'favorites',
      gameSource: 'igdb',
      externalGameId: gameId,
      igdbGameId: gameId,
      isFavorite: true,
      signalSources: ['favorites']
    });
  }
}

function applyReviewRows(candidateMap, reviewRows) {
  const latestByGameId = new Map();

  for (const row of reviewRows ?? []) {
    const gameId = normalizeGameId(row.gameId);

    if (!gameId) {
      continue;
    }

    const existing = latestByGameId.get(gameId);
    const rowAt = new Date(row.updatedAt ?? row.createdAt ?? 0).getTime();
    const existingAt = existing ? new Date(existing.updatedAt ?? existing.createdAt ?? 0).getTime() : -1;

    if (!existing || rowAt >= existingAt) {
      latestByGameId.set(gameId, row);
    }
  }

  for (const [gameId, row] of latestByGameId.entries()) {
    mergeCandidate(candidateMap, {
      gameId,
      candidateId: gameId,
      source: 'reviewed',
      gameSource: 'igdb',
      externalGameId: gameId,
      igdbGameId: gameId,
      hasReview: true,
      userRating: normalizeNumber(row.rating),
      reviewExcerpt: buildReviewExcerpt(row.content),
      latestReviewAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : (row.createdAt ? new Date(row.createdAt).toISOString() : null),
      signalSources: ['reviewed']
    });
  }
}

async function fetchMetadataForCandidates(candidates) {
  const igdbIds = [...new Set((candidates ?? [])
    .map((candidate) => normalizeGameId(candidate.igdbGameId ?? (candidate.gameSource !== 'steam' ? candidate.gameId : null)))
    .filter((gameId) => /^\d+$/.test(gameId ?? '')))]
    .slice(0, MAX_SOURCE_ROWS);

  if (igdbIds.length === 0 || !env.twitchClientId || !env.twitchClientSecret) {
    return new Map();
  }

  try {
    const result = await igdbService.getGamesByIds({ gameIds: igdbIds });
    return new Map((result.games ?? []).map((game) => [String(game.id), {
      gameId: String(game.id),
      title: normalizeText(game.name, 120) || null,
      coverUrl: game.coverUrl ?? null,
      genres: Array.isArray(game.genres) ? game.genres : [],
      themes: Array.isArray(game.themes) ? game.themes : [],
      keywords: Array.isArray(game.keywords) ? game.keywords : [],
      platforms: Array.isArray(game.platforms) ? game.platforms : [],
      rating: normalizeNumber(game.rating)
    }]));
  } catch (error) {
    logger.warn('[AILibraryCurator] metadata lookup failed', {
      requestedCount: igdbIds.length,
      code: error?.code ?? null,
      message: error?.message ?? 'unknown'
    });

    return new Map();
  }
}

function enrichCandidateWithMetadata(candidate, metadataByGameId) {
  const metadata = metadataByGameId.get(String(candidate.igdbGameId ?? candidate.gameId));
  const gameSource = candidate.gameSource ?? (candidate.igdbGameId ? 'igdb' : null);
  const resolvedCoverUrl = gameSource === 'steam'
    ? buildGameImageResolverUrl({
      gameSource,
      externalGameId: candidate.externalGameId,
      igdbCoverUrl: extractUsableIgdbCoverUrl(metadata?.coverUrl ?? candidate.coverUrl)
    })
    : (metadata?.coverUrl ?? candidate.coverUrl ?? null);

  return {
    ...candidate,
    title: metadata?.title ?? candidate.title ?? `Game ${candidate.gameId}`,
    coverUrl: resolvedCoverUrl,
    genres: metadata?.genres?.length > 0 ? metadata.genres : candidate.genres,
    themes: metadata?.themes?.length > 0 ? metadata.themes : candidate.themes,
    keywords: metadata?.keywords?.length > 0 ? metadata.keywords : candidate.keywords,
    platforms: metadata?.platforms?.length > 0 ? metadata.platforms : (candidate.platforms?.length > 0 ? candidate.platforms : (gameSource === 'steam' ? ['Steam'] : [])),
    rating: metadata?.rating ?? candidate.rating ?? null,
    metadataEnriched: Boolean(metadata),
    detailAvailable: Boolean(metadata || candidate.title || candidate.coverUrl || candidate.rating != null)
  };
}

function daysSince(dateValue) {
  if (!dateValue) {
    return null;
  }

  const time = new Date(dateValue).getTime();

  if (!Number.isFinite(time)) {
    return null;
  }

  return Math.max(Math.floor((Date.now() - time) / 86400000), 0);
}

function hasShortSessionSignal(candidate) {
  const values = [
    ...(candidate.genres ?? []),
    ...(candidate.themes ?? []),
    ...(candidate.keywords ?? [])
  ].map((value) => String(value).toLowerCase());

  return values.some((value) => SHORT_SESSION_TAGS.some((tag) => value.includes(tag)));
}

function scoreCandidate(candidate, mode) {
  let score = 1;
  const playtime = Number(candidate.playtimeMinutes ?? 0);
  const userRating = normalizeNumber(candidate.userRating);
  const rating = normalizeNumber(candidate.rating);
  const lastPlayedDays = daysSince(candidate.lastPlayedAt);

  if (playtime > 0) {
    score += Math.min(Math.log10(playtime + 10), 4);
  }

  if (candidate.isFavorite) {
    score += 2.25;
  }

  if (userRating != null) {
    score += Math.max(userRating, 0) * 0.8;
  }

  if (rating != null) {
    score += Math.min(Math.max(rating, 0), 100) / 60;
  }

  if (mode === 'today') {
    if (lastPlayedDays != null && lastPlayedDays <= 14) {
      score += 2;
    }

    if (candidate.isFavorite || (userRating != null && userRating >= 4)) {
      score += 1;
    }
  }

  if (mode === 'rediscover') {
    if (lastPlayedDays == null) {
      score += 1;
    } else if (lastPlayedDays >= 90) {
      score += 3;
    } else if (lastPlayedDays >= 30) {
      score += 1.5;
    }

    if (playtime > 0 && playtime < 180) {
      score += 1;
    }
  }

  if (mode === 'short_session') {
    if (hasShortSessionSignal(candidate)) {
      score += 2.5;
    }

    if (playtime > 0 && playtime <= 600) {
      score += 0.75;
    }
  }

  if (mode === 'review_insight') {
    if (candidate.hasReview) {
      score += 2;
    }

    if (userRating != null && userRating >= 4) {
      score += 1.25;
    }
  }

  return score;
}

function buildMatchTags(candidate, mode) {
  const tags = [];

  if (mode === 'short_session' || hasShortSessionSignal(candidate)) {
    tags.push('short_session');
  }

  if (candidate.isFavorite) {
    tags.push('favorite');
  }

  if (candidate.hasReview) {
    tags.push('reviewed');
  }

  if (Number(candidate.userRating) >= 4) {
    tags.push('high_user_rating');
  }

  if (Number(candidate.playtimeMinutes) > 0) {
    tags.push('played');
  }

  tags.push(...(candidate.genres ?? []).slice(0, 2).map((genre) => genre.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')));

  return uniqueStrings(tags.filter(Boolean), 5);
}

const KO_TAG_LABELS = {
  action: '액션',
  adventure: '어드벤처',
  casual: '캐주얼',
  competitive: '경쟁',
  coop: '협동 선호',
  co_op: '협동 선호',
  favorite: '찜한 게임',
  favorite_driven: '찜 기반',
  high_user_rating: '높은 평점',
  indie: '인디',
  played: '플레이 기록',
  puzzle: '퍼즐',
  review_driven: '리뷰 기반',
  reviewed: '리뷰 기반',
  rpg: 'RPG',
  role_playing_rpg: 'RPG',
  short_session: '짧은 세션',
  simulation: '시뮬레이션',
  strategy: '전략'
};

const ENGLISH_FALLBACK_PATTERNS = [
  /personalized library insight/i,
  /recommended games?/i,
  /game recommendations?/i,
  /based on your gaming history/i,
  /based on your library/i,
  /we recommend the following games/i,
  /selected from your library signals/i,
  /this candidate fits/i,
  /good picks?/i,
  /worth rediscovering/i,
  /review taste insight/i
];

function hasHangul(value) {
  return /[가-힣]/u.test(String(value ?? ''));
}

function shouldReplaceKoreanVisibleText(value) {
  const text = normalizeText(value, 500);

  if (!text) {
    return true;
  }

  if (ENGLISH_FALLBACK_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  return /[A-Za-z]{3,}/.test(text) && !hasHangul(text);
}

function getModeSummary(mode, localeText) {
  return localeText.modeSummaries?.[mode] ?? {
    title: getSectionTitleForMode(mode, localeText),
    body: localeText.fallbackBody
  };
}

function getKoreanReason(candidate, mode, localeText) {
  if (mode === 'short_session' && hasShortSessionSignal(candidate)) {
    return localeText.reasonByMode?.short_session ?? '짧게 즐기기 좋은 후보예요.';
  }

  if (mode === 'rediscover') {
    return localeText.reasonByMode?.rediscover ?? '한동안 쉬었거나 다시 플레이하기 좋은 게임이에요.';
  }

  if (mode === 'today') {
    return localeText.reasonByMode?.today ?? '지금 바로 이어가기 좋은 후보예요.';
  }

  if (mode === 'review_insight' && candidate.hasReview) {
    return localeText.reasonByMode?.review_insight ?? '리뷰 평점이 높아 다시 추천할 만해요.';
  }

  return localeText.reasonByMode?.overview ?? localeText.defaultReason;
}

function tagToDisplayLabel(tag, locale = 'ko') {
  const rawValue = normalizeText(tag, 40);

  if (!rawValue) {
    return null;
  }

  if (locale !== 'ko') {
    return rawValue;
  }

  const key = rawValue.toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/^_+|_+$/g, '');

  if (/^avg_user_rating_\d+(?:\.\d+)?$/.test(key)) {
    return `평균 평점 ${key.replace('avg_user_rating_', '')}`;
  }

  return KO_TAG_LABELS[key] ?? (hasHangul(rawValue) ? rawValue : null);
}

function localizeTagList(tags, locale = 'ko') {
  const result = [];
  const seen = new Set();

  for (const tag of tags ?? []) {
    const label = tagToDisplayLabel(tag, locale);

    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    result.push(label);

    if (result.length >= 5) {
      break;
    }
  }

  return result;
}

function buildDisplayTags(tags, locale = 'ko') {
  const result = [];
  const seen = new Set();

  for (const tag of tags ?? []) {
    const key = normalizeText(tag, 40);
    const label = tagToDisplayLabel(key, locale);

    if (!key || !label || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ key, label });
  }

  return result;
}

function buildReason(candidate, mode, localeText) {
  if (localeText === LOCALE_TEXT.ko) {
    return getKoreanReason(candidate, mode, localeText);
  }

  if (mode === 'short_session' && hasShortSessionSignal(candidate)) {
    return localeText.shortTitle;
  }

  if (mode === 'rediscover') {
    return localeText.rediscoverTitle;
  }

  if (mode === 'today') {
    return localeText.todayTitle;
  }

  if (mode === 'review_insight' && candidate.hasReview) {
    return localeText.reviewTitle;
  }

  return localeText.defaultReason;
}

function buildTasteProfile(candidates, mode) {
  const genreCounts = new Map();
  const themeCounts = new Map();
  const styleTags = new Set();
  let totalPlaytime = 0;
  let playedCount = 0;
  const reviewRatings = [];

  for (const candidate of candidates ?? []) {
    const weight = 1 + (candidate.isFavorite ? 0.8 : 0) + (Number(candidate.userRating) >= 4 ? 1 : 0);

    for (const genre of candidate.genres ?? []) {
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + weight);
    }

    for (const theme of candidate.themes ?? []) {
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + weight);
    }

    if (candidate.isFavorite) {
      styleTags.add('favorite_driven');
    }

    if (candidate.hasReview) {
      styleTags.add('review_driven');
    }

    if (hasShortSessionSignal(candidate)) {
      styleTags.add('short_session');
    }

    if (Number(candidate.playtimeMinutes) > 0) {
      totalPlaytime += Number(candidate.playtimeMinutes);
      playedCount += 1;
    }

    if (candidate.userRating != null) {
      reviewRatings.push(Number(candidate.userRating));
    }
  }

  const avgPlaytime = playedCount > 0 ? totalPlaytime / playedCount : null;
  const avgRating = reviewRatings.length > 0
    ? reviewRatings.reduce((sum, rating) => sum + rating, 0) / reviewRatings.length
    : null;

  return normalizeTasteProfile({
    topGenres: [...genreCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 6)
      .map(([genre]) => genre),
    topThemes: [...themeCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 6)
      .map(([theme]) => theme),
    preferredSession: mode === 'short_session'
      ? 'short'
      : (avgPlaytime == null ? 'unknown' : (avgPlaytime <= 600 ? 'short' : (avgPlaytime <= 3000 ? 'medium' : 'long'))),
    playStyleTags: [...styleTags],
    ratingStyle: avgRating == null ? null : `avg_user_rating_${Math.round(avgRating * 10) / 10}`
  });
}

function decorateTasteProfile(profile, locale = 'ko') {
  const normalizedProfile = normalizeTasteProfile(profile);
  const displayTags = buildDisplayTags(normalizedProfile.playStyleTags, locale);

  return {
    ...normalizedProfile,
    tags: displayTags.map((tag) => tag.label),
    displayTags
  };
}

function buildLocalizedSummaryBullets({ llmBullets = [], candidates = [], mode, locale = 'ko' }) {
  if (locale !== 'ko') {
    return normalizeTextList(llmBullets, { maxItems: 5, maxLength: 90 });
  }

  const acceptedBullets = normalizeTextList(llmBullets, { maxItems: 5, maxLength: 90 })
    .filter((bullet) => !shouldReplaceKoreanVisibleText(bullet));

  if (acceptedBullets.length > 0) {
    return acceptedBullets.slice(0, 5);
  }

  const bullets = [];

  if ((candidates ?? []).some((candidate) => candidate.hasReview)) {
    bullets.push('리뷰 평점과 작성 기록을 반영했어요.');
  }

  if ((candidates ?? []).some((candidate) => Number(candidate.playtimeMinutes) > 0)) {
    bullets.push('플레이 시간과 최근 기록을 함께 봤어요.');
  }

  if (mode === 'short_session') {
    bullets.push('짧은 세션에 맞는 후보를 우선했어요.');
  } else if (mode === 'rediscover') {
    bullets.push('다시 시작하기 좋은 후보를 우선했어요.');
  } else {
    bullets.push('취향 신호가 뚜렷한 게임을 우선했어요.');
  }

  return bullets.slice(0, 5);
}

function getSectionTitleForMode(mode, localeText) {
  if (mode === 'today') {
    return localeText.todayTitle;
  }

  if (mode === 'rediscover') {
    return localeText.rediscoverTitle;
  }

  if (mode === 'short_session') {
    return localeText.shortTitle;
  }

  if (mode === 'review_insight') {
    return localeText.reviewTitle;
  }

  return localeText.overviewTitle;
}

function buildFallbackData({
  mode,
  locale,
  limit,
  candidates,
  fallbackReason
}) {
  const localeText = getLocaleText(locale);
  const selectedCandidates = (candidates ?? []).slice(0, limit);
  const items = selectedCandidates.map((candidate) => ({
    gameId: candidate.gameId,
    reason: buildReason(candidate, mode, localeText),
    matchTags: localizeTagList(buildMatchTags(candidate, mode), locale),
    confidence: Math.min(0.95, Math.max(0.35, candidate.confidence ?? 0.65))
  }));
  const noCandidates = (candidates ?? []).length === 0;
  const modeSummary = getModeSummary(mode, localeText);
  const flattenedItems = items;
  const games = buildResponseGames(items.map((item) => item.gameId), candidates);
  const responseItems = buildResponseItems(flattenedItems, candidates);
  const insufficientCandidates = candidates.length < limit;

  return {
    mode,
    source: 'fallback',
    summary: {
      title: noCandidates ? localeText.noCandidatesTitle : modeSummary.title,
      body: noCandidates ? localeText.noCandidatesBody : modeSummary.body,
      bullets: noCandidates
        ? [localeText.noCandidatesBullet]
        : (locale === 'ko'
          ? [
            `후보 ${candidates.length}개 중 ${selectedCandidates.length}개를 골랐어요.`,
            ...buildLocalizedSummaryBullets({ candidates, mode, locale })
          ]
          : [
            `${selectedCandidates.length} / ${candidates.length}`,
            ...buildTasteProfile(candidates, mode).topGenres.slice(0, 3)
          ]).filter(Boolean).slice(0, 5)
    },
    tasteProfile: decorateTasteProfile(buildTasteProfile(candidates, mode), locale),
    sections: noCandidates
      ? []
      : [{
        id: MODE_SECTION_IDS[mode] ?? 'curator',
        title: getSectionTitleForMode(mode, localeText),
        description: localeText.sectionDescription,
        items: enrichSectionItems(items, candidates)
      }],
    items: responseItems,
    recommendations: responseItems,
    games,
    candidateCount: candidates.length,
    selectedCount: items.length,
    meta: {
      candidateCount: candidates.length,
      selectedCount: items.length,
      requestedLimit: limit,
      validatedSelectionCount: 0,
      supplementedCount: items.length,
      insufficientCandidates,
      fallbackReason,
      generatedAt: new Date().toISOString(),
      locale
    }
  };
}

function buildResponseGames(selectedGameIds, candidates) {
  const candidateMap = new Map((candidates ?? []).map((candidate) => [String(candidate.gameId), candidate]));

  return (selectedGameIds ?? [])
    .map((gameId) => candidateMap.get(String(gameId)))
    .filter(Boolean)
    .map((candidate) => ({
      gameId: String(candidate.gameId),
      title: candidate.title,
      coverUrl: candidate.coverUrl ?? null,
      genres: candidate.genres ?? [],
      platforms: candidate.platforms ?? [],
      rating: candidate.rating ?? null,
      source: candidate.gameSource ?? candidate.source ?? null,
      playtimeMinutes: candidate.playtimeMinutes ?? null,
      lastPlayedAt: candidate.lastPlayedAt ?? null,
      isFavorite: Boolean(candidate.isFavorite),
      hasReview: Boolean(candidate.hasReview),
      userRating: candidate.userRating ?? null,
      detailAvailable: Boolean(candidate.detailAvailable),
      metadataEnriched: Boolean(candidate.metadataEnriched)
    }));
}

function buildResponseItems(items, candidates) {
  const gameMap = new Map(buildResponseGames((items ?? []).map((item) => item.gameId), candidates)
    .map((game) => [String(game.gameId), game]));

  return (items ?? []).map((item) => ({
    ...item,
    ...(gameMap.get(String(item.gameId)) ?? {})
  }));
}

function enrichSectionItems(items, candidates) {
  const itemMap = new Map(buildResponseItems(items, candidates).map((item) => [String(item.gameId), item]));

  return (items ?? []).map((item) => itemMap.get(String(item.gameId)) ?? item);
}

function buildLlmCandidatePayload(candidates) {
  return candidates.slice(0, MAX_LLM_CANDIDATES).map((candidate) => ({
    candidateId: candidate.candidateId,
    gameId: candidate.gameId,
    title: candidate.title,
    genres: candidate.genres ?? [],
    themes: candidate.themes ?? [],
    platforms: candidate.platforms ?? [],
    playtimeMinutes: candidate.playtimeMinutes ?? null,
    lastPlayedAt: candidate.lastPlayedAt ?? null,
    isFavorite: Boolean(candidate.isFavorite),
    hasReview: Boolean(candidate.hasReview),
    userRating: candidate.userRating ?? null,
    reviewExcerpt: candidate.reviewExcerpt ? normalizeText(candidate.reviewExcerpt, 200) : null
  }));
}

function hydrateLlmData({
  mode,
  locale,
  candidates,
  llmData,
  candidateCount,
  limit,
  validation
}) {
  const localeText = getLocaleText(locale);
  const modeSummary = getModeSummary(mode, localeText);
  const candidateMap = new Map((candidates ?? []).map((candidate) => [String(candidate.gameId), candidate]));
  const selectedGameIds = [];

  for (const section of llmData.sections) {
    for (const item of section.items) {
      selectedGameIds.push(item.gameId);
    }
  }

  const seenGameIds = new Set(selectedGameIds.map(String));
  let supplementedCount = 0;

  for (const candidate of rankSupplementCandidates(candidates)) {
    if (selectedGameIds.length >= limit) {
      break;
    }

    if (seenGameIds.has(String(candidate.gameId))) {
      continue;
    }

    const item = {
      gameId: String(candidate.gameId),
      reason: buildReason(candidate, mode, localeText),
      matchTags: localizeTagList(buildMatchTags(candidate, mode), locale),
      confidence: Math.min(0.95, Math.max(0.35, candidate.confidence ?? 0.6))
    };

    if (llmData.sections.length === 0) {
      llmData.sections.push({
        id: MODE_SECTION_IDS[mode] ?? 'curator',
        title: getSectionTitleForMode(mode, localeText),
        description: localeText.sectionDescription,
        items: []
      });
    }

    llmData.sections[0].items.push(item);
    selectedGameIds.push(String(candidate.gameId));
    seenGameIds.add(String(candidate.gameId));
    supplementedCount += 1;
  }

  const localizedSections = llmData.sections.map((section) => ({
    id: normalizeText(section.id, 50) || (MODE_SECTION_IDS[mode] ?? 'curator'),
    title: locale === 'ko' && shouldReplaceKoreanVisibleText(section.title)
      ? getSectionTitleForMode(mode, localeText)
      : (normalizeText(section.title, 80) || localeText.sectionTitle),
    description: locale === 'ko' && shouldReplaceKoreanVisibleText(section.description)
      ? localeText.sectionDescription
      : (normalizeText(section.description, 180) || localeText.sectionDescription),
    items: (section.items ?? []).map((item) => {
      const candidate = candidateMap.get(String(item.gameId));
      const reason = locale === 'ko' && shouldReplaceKoreanVisibleText(item.reason)
        ? buildReason(candidate, mode, localeText)
        : (normalizeText(item.reason, 220) || buildReason(candidate, mode, localeText));

      return {
        gameId: String(item.gameId),
        reason,
        matchTags: localizeTagList(item.matchTags?.length ? item.matchTags : buildMatchTags(candidate, mode), locale),
        confidence: Math.min(1, Math.max(0, Number(item.confidence) || candidate?.confidence || 0.6))
      };
    })
  }));

  const flatItems = localizedSections.flatMap((section) => section.items).slice(0, limit);
  const finalGameIds = flatItems.map((item) => item.gameId);
  const games = buildResponseGames(finalGameIds, candidates);
  const responseItems = buildResponseItems(flatItems, candidates);
  const insufficientCandidates = candidates.length < limit;

  return {
    mode,
    source: 'llm',
    summary: {
      title: locale === 'ko' && shouldReplaceKoreanVisibleText(llmData.summary?.title)
        ? modeSummary.title
        : (normalizeText(llmData.summary?.title, 80) || modeSummary.title),
      body: locale === 'ko' && shouldReplaceKoreanVisibleText(llmData.summary?.body)
        ? modeSummary.body
        : (normalizeText(llmData.summary?.body, 400) || modeSummary.body),
      bullets: locale === 'ko'
        ? buildLocalizedSummaryBullets({
          llmBullets: llmData.summary?.bullets,
          candidates,
          mode,
          locale
        })
        : normalizeTextList(llmData.summary?.bullets, { maxItems: 5, maxLength: 90 })
    },
    tasteProfile: decorateTasteProfile(llmData.tasteProfile, locale),
    sections: localizedSections.map((section) => ({
      ...section,
      items: enrichSectionItems(section.items, candidates)
    })),
    items: responseItems,
    recommendations: responseItems,
    games,
    candidateCount,
    selectedCount: flatItems.length,
    meta: {
      candidateCount,
      selectedCount: flatItems.length,
      requestedLimit: limit,
      validatedSelectionCount: validation?.validatedSelectionCount ?? flatItems.length - supplementedCount,
      supplementedCount,
      insufficientCandidates,
      removedOutOfScope: validation?.removedOutOfScope ?? 0,
      removedDuplicate: validation?.removedDuplicate ?? 0,
      fallbackReason: null,
      generatedAt: new Date().toISOString(),
      locale
    }
  };
}

function rankSupplementCandidates(candidates) {
  return [...(candidates ?? [])].sort((left, right) => {
    const leftSignalScore = (left.detailAvailable ? 2 : 0) +
      (left.coverUrl ? 1 : 0) +
      (left.rating != null ? 0.8 : 0) +
      (left.hasReview ? 0.7 : 0) +
      (Number(left.playtimeMinutes) > 0 ? 0.5 : 0) +
      (left.isFavorite ? 0.4 : 0);
    const rightSignalScore = (right.detailAvailable ? 2 : 0) +
      (right.coverUrl ? 1 : 0) +
      (right.rating != null ? 0.8 : 0) +
      (right.hasReview ? 0.7 : 0) +
      (Number(right.playtimeMinutes) > 0 ? 0.5 : 0) +
      (right.isFavorite ? 0.4 : 0);

    return (right.score + rightSignalScore) - (left.score + leftSignalScore) ||
      String(left.title).localeCompare(String(right.title));
  });
}

function getFallbackReasonFromLlmResult(llmResult) {
  if (llmResult?.skipReason === 'timeout') {
    return 'LLM_TIMEOUT';
  }

  if (llmResult?.skipped) {
    return 'LLM_REQUEST_FAILED';
  }

  return null;
}

async function writeLibraryCuratorLog({
  userId,
  query,
  mode,
  model,
  source,
  candidateCount,
  selectedGameIds,
  promptTokens,
  completionTokens,
  latencyMs,
  fallbackReason
}) {
  try {
    await prisma.aiRecommendationLog.create({
      data: {
        userId,
        query: query ?? '',
        normalizedQuery: normalizeText(query ?? mode, 300),
        intent: {
          feature: 'library_curator',
          mode,
          source,
          candidateCount,
          fallbackReason
        },
        resultGameIds: selectedGameIds.map(String),
        model,
        promptTokens,
        completionTokens,
        latencyMs
      }
    });
  } catch (error) {
    logger.warn('[AILibraryCurator] log write failed', {
      userId,
      message: error?.message ?? 'unknown'
    });
  }
}

async function buildLibraryCuratorCandidates({
  userId,
  mode,
  candidateScope,
  excludedGameIds = []
}) {
  const normalizedExcluded = new Set(normalizeExcludedGameIds(excludedGameIds));
  const { libraryEntries, favoriteRows, reviewRows } = await fetchLibrarySignals({ userId, candidateScope });
  const steamMappingByAppId = await resolveSteamMappings(libraryEntries);
  const candidateMap = new Map();

  applyLibraryRows(candidateMap, libraryEntries, steamMappingByAppId);
  applyFavoriteRows(candidateMap, favoriteRows);
  applyReviewRows(candidateMap, reviewRows);

  let candidates = [...candidateMap.values()]
    .filter((candidate) => !normalizedExcluded.has(String(candidate.gameId)));
  const metadataByGameId = await fetchMetadataForCandidates(candidates);

  candidates = candidates
    .map((candidate) => enrichCandidateWithMetadata(candidate, metadataByGameId))
    .map((candidate) => {
      const score = scoreCandidate(candidate, mode);
      return {
        ...candidate,
        score,
        confidence: Math.min(0.95, Math.max(0.35, 0.45 + (score / 14)))
      };
    })
    .sort((left, right) => right.score - left.score || String(left.title).localeCompare(String(right.title)));

  return {
    candidates,
    counts: {
      owned: libraryEntries.length,
      favorites: favoriteRows.length,
      reviewed: reviewRows.length,
      deduped: candidates.length
    }
  };
}

async function createLibraryCuratorRecommendation({
  userId,
  query = null,
  mode = 'overview',
  limit = DEFAULT_LIMIT,
  locale = 'ko',
  candidateScope = 'mixed',
  excludedGameIds = [],
  enforceDailyLimit = false
}) {
  const startedAt = Date.now();
  const requestId = buildRequestId();
  const normalizedExcludedGameIds = normalizeExcludedGameIds(excludedGameIds);

  logger.info('[AILibraryCurator] request', {
    userId,
    mode,
    locale,
    candidateScope,
    limit,
    excludedCount: normalizedExcludedGameIds.length,
    queryLength: typeof query === 'string' ? query.length : 0
  });

  const { candidates, counts } = await buildLibraryCuratorCandidates({
    userId,
    mode,
    candidateScope,
    excludedGameIds: normalizedExcludedGameIds
  });

  logger.info('[AILibraryCurator] candidates built', {
    userId,
    mode,
    locale,
    candidateScope,
    count: candidates.length,
    owned: counts.owned,
    favorites: counts.favorites,
    reviewed: counts.reviewed,
    deduped: counts.deduped
  });

  if (candidates.length === 0) {
    const response = buildFallbackData({
      mode,
      locale,
      limit,
      candidates,
      fallbackReason: 'NO_CANDIDATES'
    });

    await writeLibraryCuratorLog({
      userId,
      query,
      mode,
      model: 'fallback',
      source: 'fallback',
      candidateCount: 0,
      selectedGameIds: [],
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt,
      fallbackReason: 'NO_CANDIDATES'
    });

    return response;
  }

  if (enforceDailyLimit) {
    await assertAndIncrementLibraryCuratorUsage({
      userId,
      locale
    });
  }

  const candidateHash = buildCandidateHash(candidates);
  const cacheKey = buildCacheKey({
    userId,
    query,
    mode,
    limit,
    locale,
    candidateScope,
    excludedGameIds: normalizedExcludedGameIds,
    candidateHash
  });
  const cachedResponse = readCachedResponse(cacheKey);

  if (cachedResponse) {
    logger.info('[AILibraryCurator] cache hit', {
      userId,
      mode,
      locale,
      candidateScope,
      selectedCount: cachedResponse.meta?.selectedCount ?? 0
    });

    return {
      ...cachedResponse,
      meta: {
        ...cachedResponse.meta,
        generatedAt: new Date().toISOString()
      }
    };
  }

  const llmCandidates = buildLlmCandidatePayload(candidates);
  const systemPrompt = buildLibraryCuratorSystemPrompt({ locale });
  const userPrompt = buildLibraryCuratorUserPrompt({
    query,
    mode,
    locale,
    limit,
    candidateScope,
    candidateGames: llmCandidates
  });
  let llmResult = null;
  let response = null;
  let fallbackReason = null;
  const llmStartedAt = Date.now();
  const llmConfig = aiClient.getLlmConfig();

  try {
    llmResult = await aiClient.createChatCompletion({
      systemPrompt,
      userPrompt,
      contextLabel: 'AI Library Curator',
      retryCount: 0,
      maxTokens: 1000,
      temperature: 0.3,
      responseFormat: true
    });
  } catch (error) {
    logger.warn('[AILibraryCurator] LLM request threw', {
      userId,
      provider: llmConfig.provider,
      model: llmConfig.model,
      timeoutMs: llmConfig.timeoutMs,
      message: error?.message ?? 'unknown'
    });
    fallbackReason = error?.name === 'AbortError' ? 'LLM_TIMEOUT' : 'LLM_REQUEST_FAILED';
  }

  fallbackReason = fallbackReason ?? getFallbackReasonFromLlmResult(llmResult);

  if (!fallbackReason) {
    const validated = validateLlmLibraryCuratorResponse({
      rawContent: llmResult?.content,
      candidates: llmCandidates,
      limit,
      localeText: getLocaleText(locale)
    });

    if (validated.source === 'llm') {
      response = hydrateLlmData({
        mode,
        locale,
        candidates,
        llmData: validated.data,
        candidateCount: candidates.length,
        limit,
        validation: validated.validation
      });
      logger.info('[AILibraryCurator] llm completed', {
        userId,
        provider: llmConfig.provider,
        model: llmResult.model ?? llmConfig.model,
        selectedCount: response.meta.selectedCount,
        supplementedCount: response.meta.supplementedCount,
        latencyMs: Date.now() - llmStartedAt
      });
      logger.info('[LibraryCurator] validation', {
        requestedLimit: limit,
        llmSelected: validated.validation?.llmSelectedCount ?? 0,
        removedOutOfScope: validated.validation?.removedOutOfScope ?? 0,
        removedDuplicate: validated.validation?.removedDuplicate ?? 0,
        supplemented: response.meta.supplementedCount,
        finalSelected: response.meta.selectedCount,
        candidateCount: candidates.length
      });
    } else {
      fallbackReason = validated.fallbackReason;
      logger.warn('[AILibraryCurator] LLM response rejected', {
        userId,
        provider: llmConfig.provider,
        model: llmResult?.model ?? llmConfig.model,
        fallbackReason,
        issueCount: validated.issues?.length ?? 0,
        latencyMs: Date.now() - llmStartedAt
      });
    }
  }

  if (!response) {
    response = buildFallbackData({
      mode,
      locale,
      limit,
      candidates,
      fallbackReason: fallbackReason ?? 'LLM_REQUEST_FAILED'
    });
    logger.info('[AILibraryCurator] fallback used', {
      userId,
      reason: response.meta.fallbackReason,
      candidateCount: candidates.length,
      selectedCount: response.meta.selectedCount
    });
  }

  writeCachedResponse(cacheKey, response);

  await writeLibraryCuratorLog({
    userId,
    query,
    mode,
    model: response.source === 'llm' ? (llmResult?.model ?? env.llmModel) : 'fallback',
    source: response.source,
    candidateCount: response.meta.candidateCount,
    selectedGameIds: response.games.map((game) => game.gameId),
    promptTokens: response.source === 'llm' ? (llmResult?.promptTokens ?? 0) : 0,
    completionTokens: response.source === 'llm' ? (llmResult?.completionTokens ?? 0) : 0,
    latencyMs: Date.now() - startedAt,
    fallbackReason: response.meta.fallbackReason
  });

  logger.info('[AILibraryCurator] response', {
    userId,
    mode,
    source: response.source,
    candidateCount: response.meta.candidateCount,
    selectedCount: response.meta.selectedCount,
    requestedLimit: limit,
    locale,
    elapsedMs: Date.now() - startedAt
  });

  return response;
}

module.exports = {
  assertAndIncrementLibraryCuratorUsage,
  buildCacheKey,
  buildLlmCandidatePayload,
  buildLibraryCuratorCandidates,
  buildTasteProfile,
  createLibraryCuratorRecommendation,
  normalizeExcludedGameIds,
  scoreCandidate
};
