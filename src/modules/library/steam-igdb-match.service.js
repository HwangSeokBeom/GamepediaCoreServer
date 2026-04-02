const { SteamIgdbMatchStatus } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { logger } = require('../../utils/logger');
const igdbService = require('../igdb/igdb.service');
const steamService = require('../../services/steam.service');
const { normalizeQuery } = require('../igdb/igdb.search-utils');
const {
  buildNormalizedSetCacheKey,
  memoizeLibraryRequestPromise
} = require('./library-request-context');

const CONFIRMED_CONFIDENCE_THRESHOLD = 0.92;
const CANDIDATE_CONFIDENCE_THRESHOLD = 0.80;
const DOMINANCE_MARGIN_THRESHOLD = 0.18;
const MATCH_CANDIDATE_LIMIT = 20;
const HIGH_CONFIDENCE_EARLY_EXIT_THRESHOLD = 0.97;
const IGDB_ENRICHMENT_SKIPPED_REASON_RATE_LIMITED = 'RATE_LIMITED';
const RECENT_UNMATCHED_CACHE_TTL_MS = 1000 * 60 * 10;
const RATE_LIMITED_SKIP_CACHE_TTL_MS = 1000 * 60 * 2;
const MAX_UNRESOLVED_STEAM_APP_IDS_PER_REQUEST = 12;
const TARGET_DEBUG_STEAM_APP_IDS = new Set(['3321460']);
const PC_PLATFORM_PATTERN = /\b(pc|windows|win|linux|mac)\b/i;
const BRIDGE_TOKENS = new Set(['of', 'the', 'and']);
const SAFE_SHORT_QUERY_TERMS = new Set(['ark', 'pubg', 'cs2', 'tf2', 'wow', 'f1', 'fc']);
const TITLE_ALIAS_MAP = new Map([
  ['pubg', ['playerunknowns battlegrounds', 'playerunknowns battlegrounds pubg']],
  ['pubg battlegrounds', ['playerunknowns battlegrounds', 'playerunknowns battlegrounds pubg']],
  ['playerunknowns battlegrounds', ['pubg', 'pubg battlegrounds']],
  ['cs2', ['counter strike 2']],
  ['counter strike 2', ['cs2']],
  ['pico park classic edition', ['pico park']],
  ['pico park', ['pico park classic edition']],
  ['피코 파크', ['pico park']],
  ['리스크 오브 레인 2', ['risk of rain 2']],
  ['리스크 오브 레인 ii', ['risk of rain 2']],
  ['데드 셀', ['dead cells']],
  ['스타듀 밸리', ['stardew valley']],
  ['하데스', ['hades']],
  ['프로젝트 좀보이드', ['project zomboid']],
  ['딥 락 갤럭틱', ['deep rock galactic']],
  ['파티 애니멀즈', ['party animals']],
  ['몬스터 헌터', ['monster hunter']],
  ['콜 오브 듀티', ['call of duty']],
  ['도타 2', ['dota 2']],
  ['붉은사막', ['crimson desert']],
  ['crimson desert', ['붉은사막']]
]);
const STEAM_TITLE_SUFFIX_PATTERNS = [
  /\bclassic edition\b/giu,
  /\bgame of the year edition\b/giu,
  /\bgoty edition\b/giu,
  /\bdefinitive edition\b/giu,
  /\bdeluxe edition\b/giu,
  /\bcomplete edition\b/giu,
  /\bultimate edition\b/giu,
  /\bdirectors cut\b/giu,
  /\bdirector's cut\b/giu,
  /\bremastered\b/giu,
  /\bremaster\b/giu,
  /\bremake\b/giu,
  /\bvr\b/giu,
  /\bdemo\b/giu,
  /\bplaytest\b/giu,
  /\btest server\b/giu,
  /\bdedicated server\b/giu,
  /\bsoundtrack\b/giu,
  /\bost\b/giu,
  /\bdlc\b/giu,
  /\bbeta\b/giu
];
const EXTRA_CONTENT_PATTERN = /\b(classic edition|dlc|demo|playtest|test server|dedicated server|soundtrack|ost|beta|vr|remastered|remaster|remake|definitive edition|deluxe edition|complete edition|ultimate edition|directors cut|director's cut|game of the year edition|goty edition)\b/i;
const ROMAN_NUMERAL_MAP = new Map([
  ['ii', '2'],
  ['iii', '3'],
  ['iv', '4'],
  ['v', '5'],
  ['vi', '6'],
  ['vii', '7'],
  ['viii', '8'],
  ['ix', '9'],
  ['x', '10']
]);
const SEPARATOR_VARIANTS_PATTERN = /[‐‑‒–—―:|/_\\]+/gu;
const DECORATIVE_PUNCTUATION_PATTERN = /[()[\]{}!?,.;"'`´“”‘’]+/gu;
const KNOWN_LOCALIZED_TITLE_MAP = new Map([
  ['피코 파크', 'pico park'],
  ['도타 2', 'dota 2'],
  ['스타듀 밸리', 'stardew valley'],
  ['하데스', 'hades'],
  ['데드 셀', 'dead cells'],
  ['프로젝트 좀보이드', 'project zomboid'],
  ['딥 락 갤럭틱', 'deep rock galactic'],
  ['파티 애니멀즈', 'party animals'],
  ['리스크 오브 레인 2', 'risk of rain 2'],
  ['리스크 오브 레인 ii', 'risk of rain 2'],
  ['붉은사막', 'crimson desert']
]);
const activeSteamMatchResolutionPromises = new Map();
const recentSteamMatchSkipCache = new Map();

function hasUsableGameName(gameName) {
  return typeof gameName === 'string' && gameName.trim().length > 0;
}

function getRecentSteamMatchSkipCache(steamAppId) {
  const normalizedSteamAppId = typeof steamAppId === 'string' ? steamAppId.trim() : '';

  if (!normalizedSteamAppId) {
    return null;
  }

  const entry = recentSteamMatchSkipCache.get(normalizedSteamAppId);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    recentSteamMatchSkipCache.delete(normalizedSteamAppId);
    return null;
  }

  return entry;
}

function setRecentSteamMatchSkipCache(steamAppId, {
  reason,
  ttlMs,
  localTitleExists = false,
  mappingRowExists = false,
  igdbCandidateFound = false
}) {
  const normalizedSteamAppId = typeof steamAppId === 'string' ? steamAppId.trim() : '';

  if (!normalizedSteamAppId || !reason || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return;
  }

  recentSteamMatchSkipCache.set(normalizedSteamAppId, {
    reason,
    localTitleExists: Boolean(localTitleExists),
    mappingRowExists: Boolean(mappingRowExists),
    igdbCandidateFound: Boolean(igdbCandidateFound),
    expiresAt: Date.now() + ttlMs
  });

  if (recentSteamMatchSkipCache.size > 500) {
    const oldestKey = recentSteamMatchSkipCache.keys().next().value;

    if (oldestKey !== undefined) {
      recentSteamMatchSkipCache.delete(oldestKey);
    }
  }
}

function clearRecentSteamMatchSkipCache(steamAppId) {
  const normalizedSteamAppId = typeof steamAppId === 'string' ? steamAppId.trim() : '';

  if (!normalizedSteamAppId) {
    return;
  }

  recentSteamMatchSkipCache.delete(normalizedSteamAppId);
}

async function loadSteamSourceInfoForMapping(steamAppId, userId = null) {
  const [userScopedRow, persistedRows] = await Promise.all([
    typeof userId === 'string' && userId.trim()
      ? prisma.userGameLibrary.findUnique({
        where: {
          userId_gameSource_externalGameId: {
            userId: userId.trim(),
            gameSource: 'STEAM',
            externalGameId: steamAppId
          }
        },
        select: {
          userId: true,
          gameName: true,
          gameSource: true,
          coverUrl: true,
          updatedAt: true
        }
      })
      : Promise.resolve(null),
    prisma.userGameLibrary.findMany({
      where: {
        externalGameId: steamAppId,
        gameSource: 'STEAM'
      },
      orderBy: {
        updatedAt: 'desc'
      },
      take: 12,
      select: {
        userId: true,
        gameName: true,
        gameSource: true,
        coverUrl: true,
        updatedAt: true
      }
    })
  ]);
  const persistedTitledRow = persistedRows.find((row) => hasUsableGameName(row?.gameName)) ?? null;
  const persistedRawTitleRow = persistedRows[0] ?? null;

  return {
    userScopedRow: userScopedRow
      ? {
        userId: userScopedRow.userId,
        gameName: userScopedRow.gameName ?? null,
        gameSource: userScopedRow.gameSource ?? null,
        coverUrl: userScopedRow.coverUrl ?? null,
        updatedAt: userScopedRow.updatedAt ?? null
      }
      : null,
    persistedTitledRow: persistedTitledRow
      ? {
        userId: persistedTitledRow.userId,
        gameName: persistedTitledRow.gameName ?? null,
        gameSource: persistedTitledRow.gameSource ?? null,
        coverUrl: persistedTitledRow.coverUrl ?? null,
        updatedAt: persistedTitledRow.updatedAt ?? null
      }
      : null,
    persistedRawTitleRow: persistedRawTitleRow
      ? {
        userId: persistedRawTitleRow.userId,
        gameName: persistedRawTitleRow.gameName ?? null,
        gameSource: persistedRawTitleRow.gameSource ?? null,
        coverUrl: persistedRawTitleRow.coverUrl ?? null,
        updatedAt: persistedRawTitleRow.updatedAt ?? null
      }
      : null
  };
}

async function loadTargetSteamSourceInfo(steamAppId) {
  if (!shouldDebugSteamAppId(steamAppId)) {
    return null;
  }

  const sourceInfo = await loadSteamSourceInfoForMapping(steamAppId);
  return sourceInfo.userScopedRow ?? sourceInfo.persistedTitledRow ?? sourceInfo.persistedRawTitleRow ?? null;
}

function logSteamApp3321460CreateDebug({
  stage = null,
  libraryRowExists = false,
  libraryRowFound = false,
  libraryRowGameName = null,
  mappingRowExists = false,
  userId = null,
  externalGameId = null,
  titleSource = null,
  titleSourcesTried = [],
  titleExtractionFailureReason = null,
  rawSteamTitle = null,
  normalizedSteamTitle = null,
  matchingFlowEntered = false,
  attemptedQueries = [],
  candidateCountsByQuery = [],
  topCandidateTitles = [],
  chosenCandidateId = null,
  chosenCandidateTitle = null,
  chosenConfidence = null,
  candidateRejectedReason = null,
  mappingInsertAttempted = false,
  mappingInsertSucceeded = false,
  mappingInsertSkippedReason = null,
  finalEnrichmentStatus = null,
  finalFallbackReason = null
}) {
  if (!shouldDebugSteamAppId(externalGameId)) {
    return;
  }

  logger.info('steam-appid-3321460-create-debug', {
    stage,
    libraryRowExists,
    libraryRowFound,
    libraryRowGameName,
    mappingRowExists,
    userId,
    externalGameId,
    titleSource,
    resolvedTitleSource: titleSource,
    titleSourcesTried,
    titleExtractionFailureReason,
    rawSteamTitle,
    normalizedSteamTitle,
    matchingFlowEntered,
    attemptedQueries,
    searchQueriesTried: attemptedQueries,
    candidateCountsByQuery,
    candidateCount: candidateCountsByQuery.reduce((total, item) => total + (item?.candidateCount ?? 0), 0),
    topCandidateTitles,
    chosenCandidateId,
    selectedIgdbId: chosenCandidateId,
    chosenCandidateTitle,
    selectedIgdbTitle: chosenCandidateTitle,
    chosenConfidence,
    confidenceScore: chosenConfidence,
    candidateRejectedReason,
    mappingInsertAttempted,
    mappingInsertSucceeded,
    mappingInsertSkippedReason,
    finalEnrichmentStatus,
    finalFallbackReason
  });
}

async function resolveSteamTitleForMappingCreation({ steamAppId, inputTitle, inputUserId = null }) {
  const titleSourcesTried = [];
  titleSourcesTried.push('steam_payload');
  const trimmedInputTitle = typeof inputTitle === 'string' ? inputTitle.trim() : '';

  if (trimmedInputTitle) {
    return {
      title: trimmedInputTitle,
      titleSource: 'steam_payload',
      titleSourcesTried,
      sourceLibraryRow: null,
      steamApiFallbackTried: false,
      steamApiFallbackSucceeded: false,
      titleExtractionFailureReason: null
    };
  }

  titleSourcesTried.push('current_user_library');
  const sourceInfo = await loadSteamSourceInfoForMapping(steamAppId, inputUserId);
  const userScopedRow = sourceInfo.userScopedRow;
  const persistedTitledRow = sourceInfo.persistedTitledRow ?? null;
  const persistedRawTitleRow = sourceInfo.persistedRawTitleRow;
  const userScopedLibraryTitle = typeof userScopedRow?.gameName === 'string' ? userScopedRow.gameName.trim() : '';

  if (userScopedLibraryTitle) {
    return {
      title: userScopedLibraryTitle,
      titleSource: 'current_user_library',
      titleSourcesTried,
      sourceLibraryRow: userScopedRow,
      steamApiFallbackTried: false,
      steamApiFallbackSucceeded: false,
      titleExtractionFailureReason: null
    };
  }

  titleSourcesTried.push('any_user_library');
  const persistedLibraryTitle = typeof persistedTitledRow?.gameName === 'string' ? persistedTitledRow.gameName.trim() : '';

  if (persistedLibraryTitle) {
    return {
      title: persistedLibraryTitle,
      titleSource: 'any_user_library',
      titleSourcesTried,
      sourceLibraryRow: persistedTitledRow,
      steamApiFallbackTried: false,
      steamApiFallbackSucceeded: false,
      titleExtractionFailureReason: null
    };
  }

  const sourceLibraryRow = userScopedRow ?? persistedRawTitleRow ?? null;
  const fallbackUserId = sourceLibraryRow?.userId
    ?? (typeof inputUserId === 'string' && inputUserId.trim() ? inputUserId.trim() : null);

  if (!fallbackUserId || !steamService.isSteamSyncConfigured()) {
    return {
      title: '',
      titleSource: fallbackUserId ? 'missing_steam_api_title' : 'missing_game_name',
      titleSourcesTried,
      sourceLibraryRow,
      steamApiFallbackTried: false,
      steamApiFallbackSucceeded: false,
      titleExtractionFailureReason: fallbackUserId
        ? 'steam_api_unavailable_or_not_configured'
        : 'missing_game_name'
    };
  }

  const socialAccount = await prisma.socialAccount.findUnique({
    where: {
      userId_provider: {
        userId: fallbackUserId,
        provider: steamService.STEAM_AUTH_PROVIDER
      }
    },
    select: {
      providerSubject: true
    }
  });
  const steamId64 = steamService.normalizeSteamId64(socialAccount?.providerSubject ?? null);

  if (!steamId64) {
    return {
      title: '',
      titleSource: 'missing_steam_api_title',
      titleSourcesTried,
      sourceLibraryRow,
      steamApiFallbackTried: false,
      steamApiFallbackSucceeded: false,
      titleExtractionFailureReason: 'missing_linked_steam_account'
    };
  }

  let steamApiFallbackTried = false;
  const steamRequestMemoKey = steamId64;

  try {
    steamApiFallbackTried = true;
    titleSourcesTried.push('steam_api_owned_games');
    const ownedGamesResult = await memoizeLibraryRequestPromise(
      'ownedGamesBySteamId',
      steamRequestMemoKey,
      () => steamService.fetchOwnedGames({ steamId64 })
    );
    const ownedGame = ownedGamesResult.games.find((game) => game.externalGameId === steamAppId) ?? null;
    const ownedGameTitle = typeof ownedGame?.gameName === 'string' ? ownedGame.gameName.trim() : '';

    if (ownedGameTitle) {
      return {
        title: ownedGameTitle,
        titleSource: 'steam_api_owned_games',
        titleSourcesTried,
        sourceLibraryRow,
        steamApiFallbackTried,
        steamApiFallbackSucceeded: true,
        titleExtractionFailureReason: null
      };
    }
  } catch (error) {
    if (shouldDebugSteamAppId(steamAppId)) {
      logger.warn('steam-appid-3321460-title-source-owned-games-failed', {
        steamAppId,
        code: error?.code ?? null,
        message: error?.message ?? null
      });
    }
  }

  try {
    steamApiFallbackTried = true;
    titleSourcesTried.push('steam_api_recently_played');
    const recentGamesResult = await memoizeLibraryRequestPromise(
      'recentPlayedBySteamId',
      steamRequestMemoKey,
      () => steamService.fetchRecentlyPlayedGames({ steamId64 })
    );
    const recentGame = recentGamesResult.games.find((game) => game.externalGameId === steamAppId) ?? null;
    const recentGameTitle = typeof recentGame?.title === 'string' ? recentGame.title.trim() : '';

    if (recentGameTitle) {
      return {
        title: recentGameTitle,
        titleSource: 'steam_api_recently_played',
        titleSourcesTried,
        sourceLibraryRow,
        steamApiFallbackTried,
        steamApiFallbackSucceeded: true,
        titleExtractionFailureReason: null
      };
    }
  } catch (error) {
    if (shouldDebugSteamAppId(steamAppId)) {
      logger.warn('steam-appid-3321460-title-source-recently-played-failed', {
        steamAppId,
        code: error?.code ?? null,
        message: error?.message ?? null
      });
    }
  }

  return {
    title: '',
    titleSource: 'missing_steam_api_title',
    titleSourcesTried,
    sourceLibraryRow,
    steamApiFallbackTried,
    steamApiFallbackSucceeded: false,
    titleExtractionFailureReason: 'no_title_found_in_any_source'
  };
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function replaceRomanNumeralToken(token) {
  return ROMAN_NUMERAL_MAP.get(token) ?? token;
}

function mapKnownLocalizedTitle(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  return KNOWN_LOCALIZED_TITLE_MAP.get(value.trim()) ?? value;
}

function canonicalizeComparisonTitle(value) {
  const queryInfo = normalizeQuery(mapKnownLocalizedTitle(value));

  if (!queryInfo.normalized) {
    return '';
  }

  return collapseWhitespace(
    queryInfo.tokens
      .map(replaceRomanNumeralToken)
      .join(' ')
  );
}

function shouldDebugSteamAppId(steamAppId) {
  return TARGET_DEBUG_STEAM_APP_IDS.has(typeof steamAppId === 'string' ? steamAppId.trim() : '');
}

function buildMainFranchiseQuery(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return '';
  }

  const franchiseTokens = [];
  let nonBridgeTokenCount = 0;

  for (const token of tokens) {
    franchiseTokens.push(token);

    if (!BRIDGE_TOKENS.has(token)) {
      nonBridgeTokenCount += 1;
    }

    if (nonBridgeTokenCount >= 2) {
      break;
    }
  }

  return collapseWhitespace(franchiseTokens.join(' '));
}

function getTitleAliasVariants(value) {
  const normalizedValue = canonicalizeComparisonTitle(value);

  if (!normalizedValue) {
    return [];
  }

  return TITLE_ALIAS_MAP.get(normalizedValue) ?? [];
}

function normalizeSteamTitle(title) {
  const originalTitle = typeof title === 'string' ? title : '';
  const localizedCanonicalTitle = mapKnownLocalizedTitle(originalTitle);
  const lowerCased = localizedCanonicalTitle.normalize('NFKC').toLowerCase().trim();

  if (!lowerCased) {
    return {
      originalTitle,
      localizedCanonicalTitle: '',
      originalNormalizedTitle: '',
      strippedComparisonTitle: '',
      titleWithoutSubtitle: '',
      franchiseQuery: '',
      comparisonAliases: [],
      hasExtraContent: false,
      tokens: [],
      comparisonTokens: [],
      rawSearchTitle: '',
      normalizedSearchTitle: '',
      strippedSearchTitle: ''
    };
  }

  const subtitleSegmentSource = lowerCased
    .replace(DECORATIVE_PUNCTUATION_PATTERN, ' ')
    .replace(/[’'`]/g, '');
  const subtitleSegments = subtitleSegmentSource
    .split(/\s*:\s*|\s+\|\s+|\s+-\s+|\s+\/\s+/)
    .map(collapseWhitespace)
    .filter(Boolean);
  const punctuationNormalized = subtitleSegmentSource
    .replace(SEPARATOR_VARIANTS_PATTERN, ' ');
  const subtitleSource = collapseWhitespace(punctuationNormalized);
  const originalNormalizedTitle = collapseWhitespace(subtitleSource);
  let strippedTitle = originalNormalizedTitle;

  for (const pattern of STEAM_TITLE_SUFFIX_PATTERNS) {
    strippedTitle = strippedTitle.replace(pattern, ' ');
  }

  strippedTitle = collapseWhitespace(strippedTitle);

  const strippedComparisonTitle = canonicalizeComparisonTitle(strippedTitle || originalNormalizedTitle);
  let subtitleBaseTitle = subtitleSegments[0] ?? strippedTitle;

  for (const pattern of STEAM_TITLE_SUFFIX_PATTERNS) {
    subtitleBaseTitle = subtitleBaseTitle.replace(pattern, ' ');
  }

  subtitleBaseTitle = collapseWhitespace(subtitleBaseTitle);

  const titleWithoutSubtitle = canonicalizeComparisonTitle(subtitleBaseTitle || strippedComparisonTitle);
  const comparisonTokens = normalizeQuery(strippedComparisonTitle).tokens;
  const franchiseQuery = buildMainFranchiseQuery(comparisonTokens);
  const comparisonAliases = [...new Set([
    ...getTitleAliasVariants(strippedComparisonTitle),
    ...getTitleAliasVariants(titleWithoutSubtitle),
    ...getTitleAliasVariants(franchiseQuery),
    canonicalizeComparisonTitle(localizedCanonicalTitle)
  ].filter(Boolean))];

  return {
    originalTitle,
    localizedCanonicalTitle,
    originalNormalizedTitle,
    strippedComparisonTitle,
    titleWithoutSubtitle,
    franchiseQuery,
    comparisonAliases,
    hasExtraContent: EXTRA_CONTENT_PATTERN.test(originalNormalizedTitle),
    tokens: normalizeQuery(originalNormalizedTitle).tokens,
    comparisonTokens,
    rawSearchTitle: collapseWhitespace(originalTitle.normalize('NFKC')),
    normalizedSearchTitle: originalNormalizedTitle,
    strippedSearchTitle: strippedTitle
  };
}

function compactNormalizedValue(value) {
  return normalizeQuery(value).compact;
}

function extractReleaseYear(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const matchedYear = value.match(/\b(19|20)\d{2}\b/);

  return matchedYear ? Number(matchedYear[0]) : null;
}

function getIgdbReleaseYear(candidate) {
  if (typeof candidate?.first_release_date !== 'number') {
    return null;
  }

  return new Date(candidate.first_release_date * 1000).getUTCFullYear();
}

function computeDiceCoefficient(left, right) {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (left.length < 2 || right.length < 2) {
    return 0;
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

function computeSimilarityScore(left, right) {
  return computeDiceCoefficient(
    compactNormalizedValue(left),
    compactNormalizedValue(right)
  );
}

function clampConfidenceScore(value) {
  return Math.max(0, Math.min(1, value));
}

function getCandidateAlternativeNames(candidate) {
  if (!Array.isArray(candidate?.alternative_names)) {
    return [];
  }

  return candidate.alternative_names
    .map((item) => normalizeSteamTitle(item?.name).strippedComparisonTitle)
    .filter(Boolean);
}

function getCandidateFranchiseNames(candidate) {
  if (!Array.isArray(candidate?.franchises)) {
    return [];
  }

  return candidate.franchises
    .map((item) => normalizeSteamTitle(item?.name).strippedComparisonTitle)
    .filter(Boolean);
}

function getCandidateNameVariants(candidate) {
  const variants = [
    normalizeSteamTitle(candidate?.name).strippedComparisonTitle,
    ...getCandidateAlternativeNames(candidate)
  ];

  return [...new Set(variants.filter(Boolean))];
}

function hasPcPlatform(candidate) {
  if (!Array.isArray(candidate?.platforms)) {
    return false;
  }

  return candidate.platforms.some((platform) => PC_PLATFORM_PATTERN.test(platform?.name ?? ''));
}

function hasVersionParent(candidate) {
  return Boolean(candidate?.version_parent?.id);
}

function isLikelyExtraContent(candidate) {
  return EXTRA_CONTENT_PATTERN.test(normalizeQuery(candidate?.name ?? '').normalized) || hasVersionParent(candidate);
}

function computeYearScore(steamReleaseYear, candidateReleaseYear) {
  if (!steamReleaseYear || !candidateReleaseYear) {
    return null;
  }

  const difference = Math.abs(steamReleaseYear - candidateReleaseYear);

  if (difference === 0) {
    return 1;
  }

  if (difference === 1) {
    return 0.8;
  }

  if (difference === 2) {
    return 0.55;
  }

  if (difference === 3) {
    return 0.3;
  }

  return 0;
}

function computeTokenOverlapRatio(steamTokens, candidateTokens) {
  if (!steamTokens.length || !candidateTokens.length) {
    return 0;
  }

  const steamTokenSet = new Set(steamTokens);
  const overlapCount = candidateTokens.filter((token) => steamTokenSet.has(token)).length;

  return overlapCount / steamTokens.length;
}

function computeOrderedTokenMatchRatio(steamTokens, candidateTokens) {
  if (!steamTokens.length || !candidateTokens.length) {
    return 0;
  }

  let candidateIndex = 0;
  let matchedCount = 0;

  for (const steamToken of steamTokens) {
    while (candidateIndex < candidateTokens.length) {
      const candidateToken = candidateTokens[candidateIndex];
      candidateIndex += 1;

      if (candidateToken === steamToken) {
        matchedCount += 1;
        break;
      }
    }
  }

  return matchedCount / steamTokens.length;
}

function extractNumericTokens(tokens) {
  return tokens.filter((token) => /^\d+$/.test(token));
}

function computeSequelNumberScore(steamTokens, candidateTokens) {
  const steamNumbers = extractNumericTokens(steamTokens);
  const candidateNumbers = extractNumericTokens(candidateTokens);

  if (steamNumbers.length === 0 && candidateNumbers.length === 0) {
    return {
      score: 1,
      conflict: false
    };
  }

  if (steamNumbers.length === 0 || candidateNumbers.length === 0) {
    return {
      score: 0.55,
      conflict: false
    };
  }

  const sameNumbers = steamNumbers.join(' ') === candidateNumbers.join(' ');

  return {
    score: sameNumbers ? 1 : 0,
    conflict: !sameNumbers
  };
}

function computeFranchiseMatchScore(normalization, candidateComparisonTitle, candidateFranchiseNames) {
  const franchiseQuery = normalization.franchiseQuery;

  if (!franchiseQuery) {
    return 0.5;
  }

  if (candidateComparisonTitle.startsWith(franchiseQuery)) {
    return 1;
  }

  if (candidateComparisonTitle.includes(franchiseQuery)) {
    return 0.8;
  }

  if (candidateFranchiseNames.includes(franchiseQuery)) {
    return 0.7;
  }

  return 0;
}

function computeSubtitleSimilarity(normalization, candidateComparisonTitle) {
  const steamBase = normalization.titleWithoutSubtitle || normalization.strippedComparisonTitle;

  if (!steamBase || steamBase === normalization.strippedComparisonTitle) {
    return computeSimilarityScore(normalization.strippedComparisonTitle, candidateComparisonTitle);
  }

  const steamSubtitle = normalization.strippedComparisonTitle.replace(steamBase, '').trim();
  const candidateSubtitle = candidateComparisonTitle.replace(steamBase, '').trim();

  if (!steamSubtitle || !candidateSubtitle) {
    return 0.6;
  }

  return computeSimilarityScore(steamSubtitle, candidateSubtitle);
}

function isSafeCandidateQuery(candidateQuery) {
  const rawValue = typeof candidateQuery === 'string' ? candidateQuery.trim() : '';

  if (!rawValue) {
    return false;
  }

  const queryInfo = normalizeQuery(rawValue.replace(/^"+|"+$/g, ''));

  if (!queryInfo.normalized) {
    return false;
  }

  if (queryInfo.compact.length >= 4) {
    return true;
  }

  if (/\d/.test(queryInfo.normalized)) {
    return true;
  }

  if (SAFE_SHORT_QUERY_TERMS.has(queryInfo.compact)) {
    return true;
  }

  return queryInfo.tokens.length >= 2;
}

function addCandidateQuery(queries, candidateQuery) {
  const normalizedValue = typeof candidateQuery === 'string' ? candidateQuery.trim() : '';

  if (!normalizedValue || queries.includes(normalizedValue) || !isSafeCandidateQuery(normalizedValue)) {
    return;
  }

  queries.push(normalizedValue);
}

function buildExactCandidateQueries(normalization) {
  const queries = [];
  const strippedComparisonTitle = normalization.strippedComparisonTitle;
  const originalNormalizedTitle = normalization.originalNormalizedTitle;

  addCandidateQuery(queries, strippedComparisonTitle);
  addCandidateQuery(queries, `"${strippedComparisonTitle}"`);

  if (originalNormalizedTitle && originalNormalizedTitle !== strippedComparisonTitle) {
    addCandidateQuery(queries, originalNormalizedTitle);
  }

  return queries.slice(0, 3);
}

function buildSteamCandidateQueries(normalization) {
  const queries = [];
  const strippedComparisonTitle = normalization.strippedComparisonTitle;
  const originalNormalizedTitle = normalization.originalNormalizedTitle;
  const titleWithoutSubtitle = normalization.titleWithoutSubtitle;
  const franchiseQuery = normalization.franchiseQuery;
  const comparisonAliases = normalization.comparisonAliases ?? [];

  addCandidateQuery(queries, originalNormalizedTitle);
  addCandidateQuery(queries, `"${originalNormalizedTitle}"`);
  addCandidateQuery(queries, strippedComparisonTitle);

  if (titleWithoutSubtitle && titleWithoutSubtitle !== strippedComparisonTitle) {
    addCandidateQuery(queries, titleWithoutSubtitle);
  }

  if (franchiseQuery && franchiseQuery !== titleWithoutSubtitle && franchiseQuery !== strippedComparisonTitle) {
    addCandidateQuery(queries, franchiseQuery);
  }

  for (const comparisonAlias of comparisonAliases) {
    addCandidateQuery(queries, comparisonAlias);
    addCandidateQuery(queries, `"${comparisonAlias}"`);
  }

  const wildcardBase = titleWithoutSubtitle || franchiseQuery || strippedComparisonTitle;

  if (wildcardBase) {
    addCandidateQuery(queries, `${wildcardBase}*`);
  }

  return queries.slice(0, 8);
}

function buildSteamQueryStages(normalization) {
  const queryStages = [];
  const pushStage = (stage, queries) => {
    const stageQueries = [];

    for (const query of queries ?? []) {
      addCandidateQuery(stageQueries, query);
    }

    if (stageQueries.length > 0) {
      queryStages.push({
        stage,
        queries: stageQueries
      });
    }
  };

  pushStage('raw_title', [
    normalization.rawSearchTitle,
    `"${normalization.rawSearchTitle}"`
  ]);
  pushStage('normalized_title', [
    normalization.normalizedSearchTitle,
    `"${normalization.normalizedSearchTitle}"`
  ]);

  if (normalization.strippedSearchTitle && normalization.strippedSearchTitle !== normalization.normalizedSearchTitle) {
    pushStage('stripped_title', [
      normalization.strippedSearchTitle,
      `"${normalization.strippedSearchTitle}"`
    ]);
  }

  pushStage('comparison_title', buildExactCandidateQueries(normalization));
  pushStage('base_title', [
    normalization.titleWithoutSubtitle,
    normalization.franchiseQuery
  ]);
  pushStage('alias', normalization.comparisonAliases);

  const fallbackQueries = buildSteamCandidateQueries(normalization)
    .filter((query) => !queryStages.some((stage) => stage.queries.includes(query)));

  pushStage('fallback', fallbackQueries);

  return queryStages;
}

function mergeCandidateGames(existingCandidates, nextCandidates) {
  const mergedCandidates = [...existingCandidates];
  const seenIds = new Set(existingCandidates.map((candidate) => candidate?.id).filter((id) => typeof id === 'number'));

  for (const candidate of nextCandidates ?? []) {
    if (typeof candidate?.id !== 'number' || seenIds.has(candidate.id)) {
      continue;
    }

    seenIds.add(candidate.id);
    mergedCandidates.push(candidate);
  }

  return mergedCandidates;
}

function getSteamComparisonVariants(normalization) {
  return [...new Set([
    normalization.strippedComparisonTitle,
    normalization.titleWithoutSubtitle,
    normalization.franchiseQuery,
    ...(normalization.comparisonAliases ?? [])
  ].filter(Boolean))];
}

function computeAliasMatchScore(normalization, candidateVariants) {
  const aliasVariants = [...new Set(normalization.comparisonAliases ?? [])];

  if (aliasVariants.length === 0 || candidateVariants.length === 0) {
    return 0;
  }

  for (const aliasVariant of aliasVariants) {
    for (const candidateVariant of candidateVariants) {
      if (aliasVariant === candidateVariant) {
        return 1;
      }

      if (computeSimilarityScore(aliasVariant, candidateVariant) >= 0.93) {
        return 0.82;
      }
    }
  }

  return 0;
}

function computeBaseTitleMatchScore(normalization, candidateComparisonTitle) {
  const baseTitle = normalization.titleWithoutSubtitle || normalization.franchiseQuery || normalization.strippedComparisonTitle;

  if (!baseTitle || !candidateComparisonTitle) {
    return 0;
  }

  if (candidateComparisonTitle === baseTitle) {
    return 1;
  }

  if (candidateComparisonTitle.startsWith(baseTitle) || baseTitle.startsWith(candidateComparisonTitle)) {
    return 0.82;
  }

  if (candidateComparisonTitle.includes(baseTitle)) {
    return 0.68;
  }

  return 0;
}

function isCandidateStronglyIrrelevant({
  normalization,
  steamReleaseYear,
  candidate,
  candidateComparisonTitle,
  candidateTokens,
  bestVariantSimilarity,
  tokenOverlapRatio,
  sequelNumberScore,
  extraContentMismatch
}) {
  const yearScore = computeYearScore(steamReleaseYear, getIgdbReleaseYear(candidate));

  if (bestVariantSimilarity < 0.28 && tokenOverlapRatio < 0.4) {
    return 'low_similarity';
  }

  if (tokenOverlapRatio < 0.28) {
    return 'low_token_overlap';
  }

  if (sequelNumberScore.conflict) {
    return 'sequel_conflict';
  }

  if (extraContentMismatch && tokenOverlapRatio < 0.95) {
    return 'extra_content_mismatch';
  }

  if (!hasPcPlatform(candidate) && bestVariantSimilarity < 0.5 && tokenOverlapRatio < 0.5) {
    return 'missing_pc_platform';
  }

  if (yearScore === 0 && steamReleaseYear && tokenOverlapRatio < 0.55) {
    return 'release_year_conflict';
  }

  if (!candidateComparisonTitle.startsWith(normalization.comparisonTokens[0] ?? '') && bestVariantSimilarity < 0.42) {
    return 'franchise_conflict';
  }

  if (candidateTokens.length < Math.max(2, Math.floor(normalization.comparisonTokens.length / 2)) && tokenOverlapRatio < 0.5) {
    return 'token_coverage_too_low';
  }

  return null;
}

function analyzeCandidateMatch({ normalization, steamReleaseYear, candidate }) {
  const candidateVariants = getCandidateNameVariants(candidate);
  const candidateFranchiseNames = getCandidateFranchiseNames(candidate);
  const steamComparisonVariants = getSteamComparisonVariants(normalization);
  const bestVariant = steamComparisonVariants.reduce((bestMatch, steamComparisonTitle) => {
    const steamTokens = normalizeQuery(steamComparisonTitle).tokens;

    for (const candidateComparisonTitle of candidateVariants) {
      const candidateTokens = normalizeQuery(candidateComparisonTitle).tokens;
      const tokenOverlapRatio = computeTokenOverlapRatio(steamTokens, candidateTokens);
      const orderedTokenMatchRatio = computeOrderedTokenMatchRatio(steamTokens, candidateTokens);
      const similarityScore = computeSimilarityScore(steamComparisonTitle, candidateComparisonTitle);
      const currentScore = similarityScore + tokenOverlapRatio + orderedTokenMatchRatio;

      if (!bestMatch || currentScore > bestMatch.currentScore) {
        bestMatch = {
          steamComparisonTitle,
          steamTokens,
          candidateComparisonTitle,
          candidateTokens,
          tokenOverlapRatio,
          orderedTokenMatchRatio,
          similarityScore,
          currentScore
        };
      }
    }

    return bestMatch;
  }, null) ?? {
    steamComparisonTitle: normalization.strippedComparisonTitle,
    steamTokens: normalization.comparisonTokens,
    candidateComparisonTitle: '',
    candidateTokens: [],
    tokenOverlapRatio: 0,
    orderedTokenMatchRatio: 0,
    similarityScore: 0,
    currentScore: 0
  };
  const sequelNumberScore = computeSequelNumberScore(bestVariant.steamTokens, bestVariant.candidateTokens);
  const pcPlatformScore = hasPcPlatform(candidate) ? 1 : 0.7;
  const franchiseMatchScore = computeFranchiseMatchScore(
    normalization,
    bestVariant.candidateComparisonTitle,
    candidateFranchiseNames
  );
  const aliasMatchScore = computeAliasMatchScore(normalization, candidateVariants);
  const baseTitleMatchScore = computeBaseTitleMatchScore(normalization, bestVariant.candidateComparisonTitle);
  const subtitleSimilarity = computeSubtitleSimilarity(normalization, bestVariant.candidateComparisonTitle);
  const yearScore = computeYearScore(steamReleaseYear, getIgdbReleaseYear(candidate));
  const exactNormalizedTitleMatch = steamComparisonVariants.includes(bestVariant.candidateComparisonTitle);
  const nearExactTitleMatch = !exactNormalizedTitleMatch &&
    (bestVariant.similarityScore >= 0.94 || (bestVariant.tokenOverlapRatio >= 0.9 && bestVariant.orderedTokenMatchRatio >= 0.85));
  const extraContentMismatch = !normalization.hasExtraContent && isLikelyExtraContent(candidate);
  const rejectionReason = isCandidateStronglyIrrelevant({
    normalization,
    steamReleaseYear,
    candidate,
    candidateComparisonTitle: bestVariant.candidateComparisonTitle,
    candidateTokens: bestVariant.candidateTokens,
    bestVariantSimilarity: bestVariant.similarityScore,
    tokenOverlapRatio: bestVariant.tokenOverlapRatio,
    sequelNumberScore,
    extraContentMismatch
  });
  let confidenceScore = 0;

  if (!rejectionReason) {
    const weightedScores = [
      { weight: 0.25, value: exactNormalizedTitleMatch ? 1 : 0 },
      { weight: 0.12, value: nearExactTitleMatch ? 1 : 0 },
      { weight: 0.20, value: bestVariant.tokenOverlapRatio },
      { weight: 0.14, value: bestVariant.similarityScore },
      { weight: 0.09, value: bestVariant.orderedTokenMatchRatio },
      { weight: 0.08, value: sequelNumberScore.score },
      { weight: 0.04, value: pcPlatformScore },
      { weight: 0.03, value: franchiseMatchScore },
      { weight: 0.02, value: subtitleSimilarity },
      { weight: 0.02, value: aliasMatchScore },
      { weight: 0.01, value: baseTitleMatchScore }
    ];

    if (yearScore !== null) {
      weightedScores.push({
        weight: 0.05,
        value: yearScore
      });
    }

    const totalWeight = weightedScores.reduce((sum, part) => sum + part.weight, 0);
    const weightedValue = weightedScores.reduce((sum, part) => sum + (part.weight * part.value), 0);
    const versionPenalty = hasVersionParent(candidate) ? 0.04 : 0;
    const extraContentPenalty = extraContentMismatch ? 0.18 : 0;
    const pcPenalty = hasPcPlatform(candidate) ? 0 : 0.02;

    confidenceScore = Number(
      clampConfidenceScore((weightedValue / totalWeight) - versionPenalty - extraContentPenalty - pcPenalty).toFixed(4)
    );
  }

  return {
    candidate,
    steamComparisonTitle: bestVariant.steamComparisonTitle,
    candidateComparisonTitle: bestVariant.candidateComparisonTitle,
    confidenceScore,
    exactNormalizedTitleMatch,
    nearExactTitleMatch,
    tokenOverlapRatio: bestVariant.tokenOverlapRatio,
    orderedTokenMatchRatio: bestVariant.orderedTokenMatchRatio,
    similarityScore: bestVariant.similarityScore,
    aliasMatchScore,
    baseTitleMatchScore,
    sequelNumberConflict: sequelNumberScore.conflict,
    hasPcPlatform: hasPcPlatform(candidate),
    extraContentMismatch,
    rejectionReason
  };
}

function selectExactShortcutCandidate(analyses) {
  return analyses.find((analysis) => (
    (analysis.exactNormalizedTitleMatch || analysis.nearExactTitleMatch || analysis.aliasMatchScore >= 0.82) &&
    analysis.hasPcPlatform &&
    !analysis.extraContentMismatch &&
    !analysis.rejectionReason
  )) ?? null;
}

function determineMatchDecision(rankedAnalyses) {
  const bestAnalysis = rankedAnalyses[0] ?? null;
  const nextAnalysis = rankedAnalyses[1] ?? null;

  if (!bestAnalysis) {
    return {
      selectedAnalysis: null,
      confidenceScore: 0,
      matchStatus: SteamIgdbMatchStatus.UNMATCHED,
      rejectionReason: 'no_viable_candidate'
    };
  }

  const dominanceMargin = bestAnalysis.confidenceScore - (nextAnalysis?.confidenceScore ?? 0);

  if (bestAnalysis.confidenceScore >= CONFIRMED_CONFIDENCE_THRESHOLD) {
    return {
      selectedAnalysis: bestAnalysis,
      confidenceScore: bestAnalysis.confidenceScore,
      matchStatus: SteamIgdbMatchStatus.CONFIRMED,
      rejectionReason: null
    };
  }

  if (bestAnalysis.confidenceScore >= CANDIDATE_CONFIDENCE_THRESHOLD) {
    return {
      selectedAnalysis: bestAnalysis,
      confidenceScore: bestAnalysis.confidenceScore,
      matchStatus: SteamIgdbMatchStatus.CANDIDATE,
      rejectionReason: dominanceMargin >= DOMINANCE_MARGIN_THRESHOLD &&
        !bestAnalysis.sequelNumberConflict &&
        !bestAnalysis.extraContentMismatch
        ? 'tentative_high_confidence_match'
        : (bestAnalysis.rejectionReason ?? 'below_confirmation_threshold')
    };
  }

  return {
    selectedAnalysis: bestAnalysis,
    confidenceScore: bestAnalysis.confidenceScore,
    matchStatus: SteamIgdbMatchStatus.UNMATCHED,
    rejectionReason: bestAnalysis.rejectionReason ?? 'low_confidence'
  };
}

function isIgdbRateLimitedError(error) {
  return error?.code === 'IGDB_RATE_LIMITED' || error?.statusCode === 429 || error?.status === 429;
}

function isAcceptedSteamIgdbMapping(mapping) {
  return mapping?.matchStatus === SteamIgdbMatchStatus.CONFIRMED && Boolean(mapping?.igdbGameId);
}

function logSteamMatchInitialLookup({
  steamAppId,
  mapping
}) {
  logger.info('steam-match-initial-lookup', {
    stage: 'initial_lookup',
    steamAppId,
    localMappingRowExists: Boolean(mapping),
    initialLookupStatus: mapping ? 'existing_local_mapping_row' : 'missing_local_mapping_row',
    existingIgdbId: mapping?.igdbGameId ?? null,
    existingMatchedTitle: mapping?.matchedTitle ?? null,
    existingMatchStatus: mapping?.matchStatus ?? null,
    existingConfidenceScore: typeof mapping?.confidenceScore === 'number'
      ? Number(mapping.confidenceScore)
      : null
  });
}

function summarizeTopCandidateTitles(analyses, limit = 3) {
  return (analyses ?? [])
    .slice(0, limit)
    .map((analysis) => analysis?.candidate?.name ?? null)
    .filter(Boolean);
}

function summarizeCandidateCountsByQuery(queryStages = []) {
  return queryStages.flatMap((stage) => (
    (stage.queries ?? []).map((query) => ({
      query,
      candidateCount: stage.candidateCount ?? 0
    }))
  ));
}

function getSteamMatchResolutionKey(game) {
  const steamAppId = typeof game?.externalGameId === 'string' ? game.externalGameId.trim() : '';
  return steamAppId;
}

async function persistSteamIgdbMapping({
  steamAppId,
  selectedAnalysis,
  confidenceScore,
  matchStatus
}) {
  const matchedAt = new Date();
  const persistedIgdbGameId = selectedAnalysis?.candidate?.id
    ? String(selectedAnalysis.candidate.id)
    : null;

  if (shouldDebugSteamAppId(steamAppId)) {
    logger.info('steam-appid-3321460-mapping-upsert-attempt', {
      steamAppId,
      igdbGameId: matchStatus === SteamIgdbMatchStatus.UNMATCHED ? null : persistedIgdbGameId,
      matchedTitle: selectedAnalysis?.candidate?.name ?? null,
      confidenceScore,
      matchStatus
    });
  }

  try {
    const mapping = await prisma.steamIgdbMapping.upsert({
      where: {
        steamAppId
      },
      update: {
        igdbGameId: matchStatus === SteamIgdbMatchStatus.UNMATCHED ? null : persistedIgdbGameId,
        matchedTitle: selectedAnalysis?.candidate?.name ?? null,
        confidenceScore,
        matchStatus,
        matchedAt
      },
      create: {
        steamAppId,
        igdbGameId: matchStatus === SteamIgdbMatchStatus.UNMATCHED ? null : persistedIgdbGameId,
        matchedTitle: selectedAnalysis?.candidate?.name ?? null,
        confidenceScore,
        matchStatus,
        matchedAt
      }
    });

    if (shouldDebugSteamAppId(steamAppId)) {
      logger.info('steam-appid-3321460-mapping-upsert-result', {
        steamAppId,
        mappingInsertSucceeded: true,
        igdbGameId: mapping.igdbGameId ?? null,
        matchedTitle: mapping.matchedTitle ?? null,
        confidenceScore: typeof mapping.confidenceScore === 'number' ? Number(mapping.confidenceScore) : null,
        matchStatus: mapping.matchStatus ?? null
      });
    }

    if (matchStatus === SteamIgdbMatchStatus.CONFIRMED) {
      clearRecentSteamMatchSkipCache(steamAppId);
    }

    return mapping;
  } catch (error) {
    if (shouldDebugSteamAppId(steamAppId)) {
      logger.warn('steam-appid-3321460-mapping-upsert-result', {
        steamAppId,
        mappingInsertSucceeded: false,
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null
      });
    }

    throw error;
  }
}

function buildSyntheticAnalysisFromExternalGame(externalGame, steamTitle) {
  const igdbGameId = typeof externalGame?.game === 'number'
    ? externalGame.game
    : Number(String(externalGame?.game ?? '').trim());

  if (!Number.isInteger(igdbGameId)) {
    return null;
  }

  return {
    candidate: {
      id: igdbGameId,
      name: externalGame?.name ?? steamTitle ?? `IGDB Game ${igdbGameId}`
    },
    steamComparisonTitle: canonicalizeComparisonTitle(steamTitle),
    candidateComparisonTitle: canonicalizeComparisonTitle(externalGame?.name ?? steamTitle ?? ''),
    confidenceScore: 0.98,
    exactNormalizedTitleMatch: false,
    tokenOverlapRatio: 1,
    orderedTokenMatchRatio: 1,
    similarityScore: 1,
    sequelNumberConflict: false,
    hasPcPlatform: true,
    extraContentMismatch: false,
    rejectionReason: null
  };
}

async function resolveExternalGamesMatch({
  steamAppId,
  steamTitle,
  normalization,
  steamReleaseYear
}) {
  try {
    const externalGamesResult = await igdbService.getSteamExternalGameCandidates({ steamAppId });
    const externalGames = externalGamesResult.externalGames ?? [];
    const games = externalGamesResult.games ?? [];

    if (externalGamesResult.rateLimited) {
      logger.warn('steam-match-external-games-attempt', {
        stage: 'external_games_lookup',
        steamAppId,
        externalGamesCandidateCount: 0,
        selectedIgdbId: null,
        selectedIgdbTitle: null,
        confidenceScore: null,
        resolutionStatus: 'rate_limited',
        errorCode: 'IGDB_RATE_LIMITED',
        errorMessage: 'IGDB is temporarily rate limited'
      });

      return {
        hit: false,
        mapping: null,
        rateLimited: true,
        strategy: null
      };
    }

    if (externalGames.length === 0) {
      logger.info('steam-match-external-games-attempt', {
        stage: 'external_games_lookup',
        steamAppId,
        externalGamesCandidateCount: 0,
        selectedIgdbId: null,
        selectedIgdbTitle: null,
        confidenceScore: null,
        resolutionStatus: 'no_external_games_candidate'
      });

      return {
        hit: false,
        mapping: null,
        rateLimited: false,
        strategy: null
      };
    }

    const rankedAnalyses = games
      .map((candidate) => analyzeCandidateMatch({
        normalization,
        steamReleaseYear,
        candidate
      }))
      .filter((analysis) => !analysis.rejectionReason)
      .sort((left, right) => right.confidenceScore - left.confidenceScore);
    const selectedAnalysis = rankedAnalyses[0] ?? buildSyntheticAnalysisFromExternalGame(externalGames[0], steamTitle);

    if (!selectedAnalysis) {
      logger.info('steam-match-external-games-attempt', {
        stage: 'external_games_lookup',
        steamAppId,
        externalGamesCandidateCount: externalGames.length,
        selectedIgdbId: null,
        selectedIgdbTitle: null,
        confidenceScore: 0,
        resolutionStatus: 'no_external_games_candidate'
      });

      return {
        hit: false,
        mapping: null,
        rateLimited: false,
        strategy: null
      };
    }

    const persistedMapping = await persistSteamIgdbMapping({
      steamAppId,
      selectedAnalysis,
      confidenceScore: Math.max(selectedAnalysis.confidenceScore ?? 0.98, 0.98),
      matchStatus: SteamIgdbMatchStatus.CONFIRMED
    });

    logger.info('steam-match-external-games-attempt', {
      stage: 'external_games_lookup',
      steamAppId,
      externalGamesCandidateCount: externalGames.length,
      selectedIgdbId: persistedMapping.igdbGameId,
      selectedIgdbTitle: selectedAnalysis.candidate?.name ?? null,
      confidenceScore: persistedMapping.confidenceScore,
      resolutionStatus: 'confirmed'
    });

    return {
      hit: true,
      mapping: persistedMapping,
      rateLimited: false,
      strategy: 'external_games'
    };
  } catch (error) {
    const rateLimited = isIgdbRateLimitedError(error);

    logger.warn('steam-match-external-games-attempt', {
      stage: 'external_games_lookup',
      steamAppId,
      externalGamesCandidateCount: 0,
      selectedIgdbId: null,
      selectedIgdbTitle: null,
      confidenceScore: null,
      resolutionStatus: rateLimited ? 'rate_limited' : 'external_games_lookup_failed',
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null
    });

    return {
      hit: false,
      mapping: null,
      rateLimited,
      strategy: null
    };
  }
}

async function fetchMatchCandidates(normalization, steamReleaseYear) {
  const queryStages = buildSteamQueryStages(normalization);
  let mergedCandidates = [];
  const searchQueriesTried = [];

  for (const queryStage of queryStages) {
    const result = await igdbService.searchGamesForSteamMatch({
      query: normalization.strippedComparisonTitle,
      candidateQueries: queryStage.queries,
      limit: MATCH_CANDIDATE_LIMIT
    });

    searchQueriesTried.push(...(result.candidateQueries ?? queryStage.queries ?? []));

    if (result?.rateLimited) {
      return {
        candidates: mergedCandidates,
        searchQueriesTried,
        exactShortcut: null,
        exactShortcutStage: queryStage.stage,
        rateLimited: true
      };
    }

    mergedCandidates = mergeCandidateGames(mergedCandidates, result.games);

    const stageAnalyses = mergedCandidates
      .map((candidate) => analyzeCandidateMatch({
        normalization,
        steamReleaseYear,
        candidate
      }))
      .filter((analysis) => !analysis.rejectionReason)
      .sort((left, right) => right.confidenceScore - left.confidenceScore);
    const exactShortcut = selectExactShortcutCandidate(stageAnalyses);

    if (exactShortcut) {
      return {
        candidates: mergedCandidates,
        searchQueriesTried,
        exactShortcut,
        exactShortcutStage: queryStage.stage
      };
    }

    if ((stageAnalyses[0]?.confidenceScore ?? 0) >= HIGH_CONFIDENCE_EARLY_EXIT_THRESHOLD) {
      return {
        candidates: mergedCandidates,
        searchQueriesTried,
        exactShortcut: null,
        exactShortcutStage: queryStage.stage
      };
    }
  }

  return {
    candidates: mergedCandidates,
    searchQueriesTried,
    exactShortcut: null,
    exactShortcutStage: null,
    rateLimited: false
  };
}

async function buildSteamMatchDebugSummary(game) {
  const steamAppId = typeof game?.externalGameId === 'string' ? game.externalGameId.trim() : '';
  const rawSteamTitle = typeof game?.title === 'string'
    ? game.title.trim()
    : (typeof game?.gameName === 'string' ? game.gameName.trim() : '');
  const normalization = normalizeSteamTitle(rawSteamTitle);
  const steamReleaseYear = extractReleaseYear(rawSteamTitle);
  const queryStages = buildSteamQueryStages(normalization);
  const stageResults = [];
  let externalGamesResult = null;

  try {
    externalGamesResult = await igdbService.getSteamExternalGameCandidates({ steamAppId });
  } catch (error) {
    externalGamesResult = {
      error: {
        code: error?.code ?? null,
        message: error?.message ?? null
      },
      externalGames: [],
      games: []
    };
  }

  for (const queryStage of queryStages) {
    try {
      const result = await igdbService.searchGamesForSteamMatch({
        query: normalization.strippedComparisonTitle,
        candidateQueries: queryStage.queries,
        limit: MATCH_CANDIDATE_LIMIT
      });
      const analyses = result.games
        .map((candidate) => analyzeCandidateMatch({
          normalization,
          steamReleaseYear,
          candidate
        }))
        .sort((left, right) => right.confidenceScore - left.confidenceScore);

      stageResults.push({
        stage: queryStage.stage,
        queries: result.candidateQueries,
        candidateCount: result.games.length,
        topCandidates: analyses.slice(0, 5).map((analysis) => ({
          igdbId: analysis.candidate?.id ?? null,
          title: analysis.candidate?.name ?? null,
          confidenceScore: analysis.confidenceScore,
          rejectionReason: analysis.rejectionReason ?? null,
          tokenOverlapRatio: analysis.tokenOverlapRatio,
          similarityScore: analysis.similarityScore
        }))
      });

      if (shouldDebugSteamAppId(steamAppId)) {
        logger.info('steam-appid-3321460-query-debug', {
          steamAppId,
          stage: queryStage.stage,
          queries: result.candidateQueries,
          candidateCount: result.games.length,
          topCandidates: analyses.slice(0, 3).map((analysis) => ({
            igdbId: analysis.candidate?.id ?? null,
            title: analysis.candidate?.name ?? null,
            rejectionReason: analysis.rejectionReason ?? null,
            confidenceScore: analysis.confidenceScore
          }))
        });
      }
    } catch (error) {
      stageResults.push({
        stage: queryStage.stage,
        queries: queryStage.queries,
        candidateCount: 0,
        error: {
          code: error?.code ?? null,
          message: error?.message ?? null
        }
      });

      if (shouldDebugSteamAppId(steamAppId)) {
        logger.warn('steam-appid-3321460-query-debug', {
          steamAppId,
          stage: queryStage.stage,
          queries: queryStage.queries,
          candidateCount: 0,
          errorCode: error?.code ?? null,
          errorMessage: error?.message ?? null
        });
      }
    }
  }

  return {
    steamAppId,
    rawSteamTitle,
    normalizedTitle: normalization.originalNormalizedTitle,
    strippedTitle: normalization.strippedComparisonTitle,
    titleWithoutSubtitle: normalization.titleWithoutSubtitle,
    franchiseQuery: normalization.franchiseQuery,
    comparisonAliases: normalization.comparisonAliases,
    externalGames: {
      count: externalGamesResult?.externalGames?.length ?? 0,
      candidates: (externalGamesResult?.games ?? []).slice(0, 5).map((candidate) => ({
        igdbId: candidate?.id ?? null,
        title: candidate?.name ?? null
      })),
      error: externalGamesResult?.error ?? null
    },
    queryStages: stageResults
  };
}

async function resolveSingleSteamGameMapping(game) {
  const resolutionKey = getSteamMatchResolutionKey(game);

  return memoizeLibraryRequestPromise('titleFallbackResolutionByExternalGameId', resolutionKey, async () => {
    if (activeSteamMatchResolutionPromises.has(resolutionKey)) {
      logger.info('steam-request-coalesced', {
        requestType: 'titleFallbackResolutionByExternalGameId',
        externalGameId: resolutionKey,
        hit: true
      });
      return activeSteamMatchResolutionPromises.get(resolutionKey);
    }

    const resolutionPromise = (async () => {
    const steamAppId = typeof game?.externalGameId === 'string' ? game.externalGameId.trim() : '';
    const inputUserId = typeof game?.userId === 'string' && game.userId.trim() ? game.userId.trim() : null;
    const steamTitle = typeof game?.title === 'string'
      ? game.title.trim()
      : (typeof game?.gameName === 'string' ? game.gameName.trim() : '');
    const titleResolution = await resolveSteamTitleForMappingCreation({
      steamAppId,
      inputTitle: steamTitle,
      inputUserId
    });
    const targetSourceInfo = shouldDebugSteamAppId(steamAppId)
      ? (titleResolution.sourceLibraryRow ?? await loadTargetSteamSourceInfo(steamAppId))
      : null;
    const effectiveSteamTitle = titleResolution.title || '';
    const titleMissingInSource = !effectiveSteamTitle;
    const normalization = normalizeSteamTitle(effectiveSteamTitle);
    const steamReleaseYear = extractReleaseYear(effectiveSteamTitle);

    if (shouldDebugSteamAppId(steamAppId)) {
      logger.info('steam-match-creation-targeted-source', {
        steamAppId,
        inputUserId,
        inputSteamTitle: steamTitle || null,
        sourceLibraryRow: targetSourceInfo,
        titleSource: titleResolution.titleSource,
        titleSourcesTried: titleResolution.titleSourcesTried ?? [],
        effectiveSteamTitle: effectiveSteamTitle || null,
        normalizedSteamTitle: normalization.strippedComparisonTitle || null,
        titleMissingInSource,
        titleExtractionFailureReason: titleResolution.titleExtractionFailureReason ?? null
      });
    }

    logger.info('steam-match-title-resolution', {
      stage: 'title_resolution',
      steamAppId,
      userId: inputUserId,
      titleSource: titleResolution.titleSource ?? null,
      rawSteamTitle: effectiveSteamTitle || null,
      normalizedSteamTitle: normalization.strippedComparisonTitle || null,
      titleSourcesTried: titleResolution.titleSourcesTried ?? [],
      resolutionStatus: effectiveSteamTitle ? 'title_resolved' : 'title_unavailable',
      titleUnavailableReason: effectiveSteamTitle
        ? null
        : (titleResolution.titleExtractionFailureReason ?? 'title_unavailable_from_all_sources')
    });

    logSteamApp3321460CreateDebug({
      stage: 'title_resolution',
      libraryRowExists: Boolean(targetSourceInfo),
      libraryRowFound: Boolean(targetSourceInfo),
      libraryRowGameName: targetSourceInfo?.gameName ?? null,
      mappingRowExists: false,
      userId: inputUserId ?? targetSourceInfo?.userId ?? null,
      externalGameId: steamAppId || null,
      titleSource: titleResolution.titleSource,
      titleSourcesTried: titleResolution.titleSourcesTried ?? [],
      titleExtractionFailureReason: titleResolution.titleExtractionFailureReason ?? null,
      rawSteamTitle: effectiveSteamTitle || null,
      normalizedSteamTitle: normalization.strippedComparisonTitle || null,
      matchingFlowEntered: Boolean(steamAppId),
      attemptedQueries: [],
      candidateCountsByQuery: [],
      topCandidateTitles: [],
      chosenCandidateId: null,
      chosenCandidateTitle: null,
      chosenConfidence: null,
      candidateRejectedReason: null,
      mappingInsertAttempted: false,
      mappingInsertSucceeded: false,
      mappingInsertSkippedReason: effectiveSteamTitle ? null : (titleResolution.titleExtractionFailureReason ?? 'title_unavailable_from_all_sources'),
      finalEnrichmentStatus: null,
      finalFallbackReason: effectiveSteamTitle ? null : (titleResolution.titleExtractionFailureReason ?? 'title_unavailable_from_all_sources')
    });

    if (!steamAppId || !normalization.strippedComparisonTitle) {
    setRecentSteamMatchSkipCache(steamAppId, {
      reason: titleMissingInSource
        ? (titleResolution.titleExtractionFailureReason ?? 'title_unavailable_from_all_sources')
        : 'missing_normalized_title',
      ttlMs: RECENT_UNMATCHED_CACHE_TTL_MS,
      localTitleExists: Boolean(effectiveSteamTitle),
      mappingRowExists: false,
      igdbCandidateFound: false
    });

    logSteamApp3321460CreateDebug({
      stage: 'title_resolution',
      libraryRowExists: Boolean(targetSourceInfo),
      libraryRowFound: Boolean(targetSourceInfo),
      libraryRowGameName: targetSourceInfo?.gameName ?? null,
      mappingRowExists: false,
      userId: targetSourceInfo?.userId ?? null,
      externalGameId: steamAppId || null,
      titleSource: titleResolution.titleSource,
      titleSourcesTried: titleResolution.titleSourcesTried ?? [],
      titleExtractionFailureReason: titleResolution.titleExtractionFailureReason ?? null,
      rawSteamTitle: effectiveSteamTitle || null,
      normalizedSteamTitle: normalization.strippedComparisonTitle || null,
      matchingFlowEntered: Boolean(steamAppId),
      attemptedQueries: [],
      candidateCountsByQuery: [],
      topCandidateTitles: [],
      chosenCandidateId: null,
      chosenCandidateTitle: null,
      chosenConfidence: null,
      candidateRejectedReason: titleMissingInSource ? 'title_unavailable_from_all_sources' : 'missing_normalized_title',
      mappingInsertAttempted: false,
      mappingInsertSucceeded: false,
      mappingInsertSkippedReason: titleMissingInSource
        ? (titleResolution.titleExtractionFailureReason ?? 'title_unavailable_from_all_sources')
        : 'missing_normalized_title',
      finalEnrichmentStatus: 'steam_only',
      finalFallbackReason: titleMissingInSource
        ? (titleResolution.titleExtractionFailureReason ?? 'title_unavailable_from_all_sources')
        : 'missing_normalized_title'
    });

      logger.warn('Steam IGDB matching skipped for invalid game payload', {
        steamAppId: steamAppId || null,
        rawSteamTitle: effectiveSteamTitle || null,
        normalizedSteamTitle: normalization.strippedComparisonTitle || null,
        skipReason: titleMissingInSource
          ? (titleResolution.titleExtractionFailureReason ?? 'title_unavailable_from_all_sources')
          : 'missing_normalized_title',
        finalEnrichmentStatus: 'enrichment_failure'
      });

      logger.info('steam-match-final', {
        stage: 'final_resolution',
        steamAppId: steamAppId || null,
        finalIgdbId: null,
        finalIgdbTitle: null,
        strategyUsed: 'steam_only',
        finalConfidenceScore: null,
        mappingUpserted: false
      });

    return {
      mapping: null,
      rateLimited: false,
      strategy: 'unmatched'
    };
  }

  if (igdbService.isIgdbRateLimitCooldownActive()) {
    setRecentSteamMatchSkipCache(steamAppId, {
      reason: 'rate_limited',
      ttlMs: RATE_LIMITED_SKIP_CACHE_TTL_MS,
      localTitleExists: Boolean(effectiveSteamTitle),
      mappingRowExists: false,
      igdbCandidateFound: false
    });

    logger.warn('steam-match-final', {
      stage: 'final_resolution',
      steamAppId,
      finalIgdbId: null,
      finalIgdbTitle: null,
      strategyUsed: 'steam_only',
      finalConfidenceScore: null,
      mappingUpserted: false,
      finalEnrichmentStatus: 'enrichment_pending',
      finalFallbackReason: 'rate_limited'
    });

    return {
      mapping: null,
      rateLimited: true,
      strategy: null
    };
  }

  try {
    const externalGamesResult = await resolveExternalGamesMatch({
      steamAppId,
      steamTitle: effectiveSteamTitle,
      normalization,
      steamReleaseYear
    });

    if (externalGamesResult.hit) {
      logger.info('steam-match-final', {
        stage: 'final_resolution',
        steamAppId,
        finalIgdbId: externalGamesResult.mapping?.igdbGameId ?? null,
        finalIgdbTitle: externalGamesResult.mapping?.matchedTitle ?? null,
        strategyUsed: 'external_games',
        finalConfidenceScore: typeof externalGamesResult.mapping?.confidenceScore === 'number'
          ? Number(externalGamesResult.mapping.confidenceScore)
          : null,
        mappingUpserted: Boolean(externalGamesResult.mapping)
      });

      logSteamApp3321460CreateDebug({
        stage: 'external_games_lookup',
        libraryRowExists: Boolean(targetSourceInfo),
        libraryRowFound: Boolean(targetSourceInfo),
        libraryRowGameName: targetSourceInfo?.gameName ?? null,
        mappingRowExists: false,
        userId: targetSourceInfo?.userId ?? null,
        externalGameId: steamAppId,
        titleSource: titleResolution.titleSource,
        titleSourcesTried: titleResolution.titleSourcesTried ?? [],
        titleExtractionFailureReason: titleResolution.titleExtractionFailureReason ?? null,
        rawSteamTitle: effectiveSteamTitle,
        normalizedSteamTitle: normalization.strippedComparisonTitle,
        matchingFlowEntered: true,
        attemptedQueries: [],
        candidateCountsByQuery: [{ query: 'external_games', candidateCount: 1 }],
        topCandidateTitles: externalGamesResult.mapping?.matchedTitle ? [externalGamesResult.mapping.matchedTitle] : [],
        chosenCandidateId: externalGamesResult.mapping?.igdbGameId ?? null,
        chosenCandidateTitle: externalGamesResult.mapping?.matchedTitle ?? null,
        chosenConfidence: typeof externalGamesResult.mapping?.confidenceScore === 'number'
          ? Number(externalGamesResult.mapping.confidenceScore)
          : null,
        candidateRejectedReason: null,
        mappingInsertAttempted: true,
        mappingInsertSucceeded: Boolean(externalGamesResult.mapping),
        mappingInsertSkippedReason: externalGamesResult.mapping ? null : 'external_games_hit_without_mapping',
        finalEnrichmentStatus: 'steam_plus_igdb_enriched',
        finalFallbackReason: null
      });

      logger.info('steam-match-mapping-persisted', {
        stage: 'mapping_persisted',
        steamAppId,
        igdbGameId: externalGamesResult.mapping?.igdbGameId ?? null,
        matchedTitle: externalGamesResult.mapping?.matchedTitle ?? null,
        confidenceScore: typeof externalGamesResult.mapping?.confidenceScore === 'number'
          ? Number(externalGamesResult.mapping.confidenceScore)
          : null,
        matchStatus: externalGamesResult.mapping?.matchStatus ?? null
      });

      return {
        mapping: externalGamesResult.mapping,
        rateLimited: externalGamesResult.rateLimited,
        strategy: externalGamesResult.strategy
      };
    }

    if (externalGamesResult.rateLimited) {
      setRecentSteamMatchSkipCache(steamAppId, {
        reason: 'rate_limited',
        ttlMs: RATE_LIMITED_SKIP_CACHE_TTL_MS,
        localTitleExists: Boolean(effectiveSteamTitle),
        mappingRowExists: false,
        igdbCandidateFound: false
      });

      logSteamApp3321460CreateDebug({
        stage: 'external_games_lookup',
        libraryRowExists: Boolean(targetSourceInfo),
        libraryRowFound: Boolean(targetSourceInfo),
        libraryRowGameName: targetSourceInfo?.gameName ?? null,
        mappingRowExists: false,
        userId: targetSourceInfo?.userId ?? null,
        externalGameId: steamAppId,
        titleSource: titleResolution.titleSource,
        titleSourcesTried: titleResolution.titleSourcesTried ?? [],
        titleExtractionFailureReason: titleResolution.titleExtractionFailureReason ?? null,
        rawSteamTitle: effectiveSteamTitle,
        normalizedSteamTitle: normalization.strippedComparisonTitle,
        matchingFlowEntered: true,
        attemptedQueries: [],
        candidateCountsByQuery: [{ query: 'external_games', candidateCount: 0 }],
        topCandidateTitles: [],
        chosenCandidateId: null,
        chosenCandidateTitle: null,
        chosenConfidence: null,
        candidateRejectedReason: 'rate_limited',
        mappingInsertAttempted: false,
        mappingInsertSucceeded: false,
        mappingInsertSkippedReason: 'rate_limited',
        finalEnrichmentStatus: 'enrichment_pending',
        finalFallbackReason: 'rate_limited'
      });

      return {
        mapping: null,
        rateLimited: true,
        strategy: null
      };
    }

    const { candidates, searchQueriesTried, exactShortcut, exactShortcutStage, rateLimited: titleSearchRateLimited } = await fetchMatchCandidates(normalization, steamReleaseYear);

    if (titleSearchRateLimited) {
      setRecentSteamMatchSkipCache(steamAppId, {
        reason: 'rate_limited',
        ttlMs: RATE_LIMITED_SKIP_CACHE_TTL_MS,
        localTitleExists: Boolean(effectiveSteamTitle),
        mappingRowExists: false,
        igdbCandidateFound: false
      });

      logger.warn('steam-match-title-search-attempt', {
        stage: 'title_fallback_search',
        steamAppId,
        rawSteamTitle: effectiveSteamTitle,
        normalizedSteamTitle: normalization.strippedComparisonTitle,
        attemptedQueries: searchQueriesTried,
        candidateCountsByQuery: [],
        selectedIgdbId: null,
        selectedIgdbTitle: null,
        confidenceScore: null,
        resolutionStatus: 'rate_limited'
      });

      return {
        mapping: null,
        rateLimited: true,
        strategy: null
      };
    }

    const analyses = candidates
      .map((candidate) => analyzeCandidateMatch({
        normalization,
        steamReleaseYear,
        candidate
      }))
      .filter((analysis) => !analysis.rejectionReason)
      .sort((left, right) => right.confidenceScore - left.confidenceScore);
    const exactShortcutDecision = exactShortcut
      ? {
        selectedAnalysis: analyses.find((analysis) => analysis.candidate.id === exactShortcut.candidate.id) ?? exactShortcut,
        confidenceScore: Math.max(exactShortcut.confidenceScore, 0.97),
        matchStatus: SteamIgdbMatchStatus.CONFIRMED,
        rejectionReason: null
      }
      : null;
    const decision = exactShortcutDecision ?? determineMatchDecision(analyses);
    const persistedMapping = await persistSteamIgdbMapping({
      steamAppId,
      selectedAnalysis: decision.selectedAnalysis,
      confidenceScore: decision.confidenceScore,
      matchStatus: decision.matchStatus
    });
    const topAnalyses = analyses.slice(0, 5);
    const debugSummary = shouldDebugSteamAppId(steamAppId)
      ? await buildSteamMatchDebugSummary({
        externalGameId: steamAppId,
        gameName: effectiveSteamTitle
      })
      : null;

    logger.info('steam-match-title-search-attempt', {
      stage: 'title_fallback_search',
      steamAppId,
      rawSteamTitle: effectiveSteamTitle,
      normalizedSteamTitle: normalization.strippedComparisonTitle,
      attemptedQueries: searchQueriesTried,
      candidateCountsByQuery: debugSummary
        ? summarizeCandidateCountsByQuery(debugSummary.queryStages)
        : [],
      selectedIgdbId: decision.selectedAnalysis?.candidate?.id ?? null,
      selectedIgdbTitle: decision.selectedAnalysis?.candidate?.name ?? null,
      confidenceScore: decision.confidenceScore,
      resolutionStatus: decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED ? 'confirmed' : 'failed'
    });

    logger.info('steam-match-candidate-scoring', {
      stage: 'candidate_scoring',
      steamAppId,
      rawSteamTitle: effectiveSteamTitle,
      normalizedSteamTitle: normalization.strippedComparisonTitle,
      candidateCount: candidates.length,
      topCandidateTitles: summarizeTopCandidateTitles(topAnalyses),
      selectedIgdbId: decision.selectedAnalysis?.candidate?.id ?? null,
      selectedIgdbTitle: decision.selectedAnalysis?.candidate?.name ?? null,
      confidenceScore: decision.confidenceScore,
      candidateRejectedReason: decision.rejectionReason ?? null
    });

    logger.info('steam-match', {
      steamAppId,
      rawSteamTitle: effectiveSteamTitle,
      normalizedSteamTitle: normalization.strippedComparisonTitle,
      comparisonTitle: normalization.strippedComparisonTitle,
      strategy: exactShortcutDecision
        ? 'exact_title'
        : (decision.matchStatus === SteamIgdbMatchStatus.UNMATCHED ? 'unmatched' : 'normalized_title_fallback'),
      searchQueriesTried,
      candidateCount: candidates.length,
      topCandidates: topAnalyses.map((analysis) => analysis.candidate?.name ?? null),
      topCandidateScores: topAnalyses.map((analysis) => analysis.confidenceScore),
      topCandidateDiagnostics: topAnalyses.map((analysis) => ({
        name: analysis.candidate?.name ?? null,
        score: analysis.confidenceScore,
        similarity: analysis.similarityScore,
        tokenOverlapRatio: analysis.tokenOverlapRatio,
        orderedTokenMatchRatio: analysis.orderedTokenMatchRatio,
        matchedAgainst: analysis.steamComparisonTitle,
        hasPcPlatform: analysis.hasPcPlatform,
        aliasMatchScore: analysis.aliasMatchScore,
        baseTitleMatchScore: analysis.baseTitleMatchScore
      })),
      chosenIgdbTitle: decision.selectedAnalysis?.candidate?.name ?? null,
      chosenIgdbId: decision.selectedAnalysis?.candidate?.id ?? null,
      confidenceScore: decision.confidenceScore,
      status: persistedMapping.matchStatus.toLowerCase(),
      rejectionReason: decision.rejectionReason,
      exactShortcutStage,
      finalEnrichmentStatus: decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED
        ? (exactShortcutDecision ? 'exact_title_match_success' : 'normalized_title_fallback_success')
        : 'low_confidence_rejection'
    });

    logger.info('steam-match-final', {
      stage: 'final_resolution',
      steamAppId,
      finalIgdbId: decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED
        ? (decision.selectedAnalysis?.candidate?.id ?? null)
        : null,
      finalIgdbTitle: decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED
        ? (decision.selectedAnalysis?.candidate?.name ?? null)
        : null,
      strategyUsed: decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED
        ? (exactShortcutDecision ? 'title_search' : 'title_search')
        : 'steam_only',
      finalConfidenceScore: decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED
        ? decision.confidenceScore
        : null,
      mappingUpserted: Boolean(persistedMapping)
    });

    if (decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED) {
      clearRecentSteamMatchSkipCache(steamAppId);
      logger.info('steam-match-mapping-persisted', {
        stage: 'mapping_persisted',
        steamAppId,
        igdbGameId: persistedMapping?.igdbGameId ?? null,
        matchedTitle: persistedMapping?.matchedTitle ?? null,
        confidenceScore: typeof persistedMapping?.confidenceScore === 'number'
          ? Number(persistedMapping.confidenceScore)
          : null,
        matchStatus: persistedMapping?.matchStatus ?? null
      });
    } else {
      setRecentSteamMatchSkipCache(steamAppId, {
        reason: decision.rejectionReason ?? 'low_confidence',
        ttlMs: RECENT_UNMATCHED_CACHE_TTL_MS,
        localTitleExists: Boolean(effectiveSteamTitle),
        mappingRowExists: Boolean(persistedMapping),
        igdbCandidateFound: candidates.length > 0
      });
    }

      if (shouldDebugSteamAppId(steamAppId)) {
      logSteamApp3321460CreateDebug({
        stage: 'candidate_scoring',
        libraryRowExists: Boolean(targetSourceInfo),
        libraryRowFound: Boolean(targetSourceInfo),
        libraryRowGameName: targetSourceInfo?.gameName ?? null,
        mappingRowExists: false,
        userId: targetSourceInfo?.userId ?? null,
        externalGameId: steamAppId,
        titleSource: titleResolution.titleSource,
        titleSourcesTried: titleResolution.titleSourcesTried ?? [],
        titleExtractionFailureReason: titleResolution.titleExtractionFailureReason ?? null,
        rawSteamTitle: effectiveSteamTitle,
        normalizedSteamTitle: normalization.strippedComparisonTitle,
        matchingFlowEntered: true,
        attemptedQueries: searchQueriesTried,
        candidateCountsByQuery: debugSummary.queryStages.flatMap((stage) => (
          (stage.queries ?? []).map((query) => ({
            query,
            candidateCount: stage.candidateCount ?? 0
          }))
        )),
        topCandidateTitles: topAnalyses.slice(0, 3).map((analysis) => analysis.candidate?.name ?? null).filter(Boolean),
        chosenCandidateId: decision.selectedAnalysis?.candidate?.id ?? null,
        chosenCandidateTitle: decision.selectedAnalysis?.candidate?.name ?? null,
        chosenConfidence: decision.confidenceScore,
        candidateRejectedReason: decision.rejectionReason ?? null,
        mappingInsertAttempted: true,
        mappingInsertSucceeded: Boolean(persistedMapping),
        mappingInsertSkippedReason: null,
        finalEnrichmentStatus: decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED
          ? 'steam_plus_igdb_enriched'
          : 'steam_only',
        finalFallbackReason: decision.matchStatus === SteamIgdbMatchStatus.CONFIRMED
          ? null
          : (decision.rejectionReason ?? 'title_fallback_rejected')
      });

      logger.info('steam-match-targeted-debug', {
        steamAppId,
        sourceLibraryRow: targetSourceInfo,
        ...debugSummary,
        finalDecision: {
          chosenIgdbId: decision.selectedAnalysis?.candidate?.id ?? null,
          chosenIgdbTitle: decision.selectedAnalysis?.candidate?.name ?? null,
          confidenceScore: decision.confidenceScore,
          matchStatus: persistedMapping.matchStatus,
          rejectionReason: decision.rejectionReason ?? null
        }
      });
    } else {
      logSteamApp3321460CreateDebug({
        stage: 'candidate_scoring',
        libraryRowExists: Boolean(targetSourceInfo),
        libraryRowFound: Boolean(targetSourceInfo),
        libraryRowGameName: targetSourceInfo?.gameName ?? null,
        mappingRowExists: false,
        userId: targetSourceInfo?.userId ?? null,
        externalGameId: steamAppId,
        titleSource: titleResolution.titleSource,
        titleSourcesTried: titleResolution.titleSourcesTried ?? [],
        titleExtractionFailureReason: titleResolution.titleExtractionFailureReason ?? null,
        rawSteamTitle: effectiveSteamTitle,
        normalizedSteamTitle: normalization.strippedComparisonTitle,
        matchingFlowEntered: true,
        attemptedQueries: searchQueriesTried,
        candidateCountsByQuery: [],
        topCandidateTitles: topAnalyses.slice(0, 3).map((analysis) => analysis.candidate?.name ?? null).filter(Boolean),
        chosenCandidateId: decision.selectedAnalysis?.candidate?.id ?? null,
        chosenCandidateTitle: decision.selectedAnalysis?.candidate?.name ?? null,
        chosenConfidence: decision.confidenceScore,
        candidateRejectedReason: decision.rejectionReason ?? null,
        mappingInsertAttempted: true,
        mappingInsertSucceeded: Boolean(persistedMapping),
        mappingInsertSkippedReason: null,
        finalEnrichmentStatus: 'steam_only',
        finalFallbackReason: decision.rejectionReason ?? 'title_fallback_rejected'
      });
    }

      return {
        mapping: persistedMapping,
        rateLimited: false,
        strategy: exactShortcutDecision
          ? 'exact_title'
          : (decision.matchStatus === SteamIgdbMatchStatus.UNMATCHED ? 'unmatched' : 'normalized_title_fallback')
      };
    } catch (error) {
      const rateLimited = isIgdbRateLimitedError(error);

      setRecentSteamMatchSkipCache(steamAppId, {
        reason: rateLimited ? 'rate_limited' : 'upstream_error',
        ttlMs: rateLimited ? RATE_LIMITED_SKIP_CACHE_TTL_MS : RECENT_UNMATCHED_CACHE_TTL_MS,
        localTitleExists: Boolean(effectiveSteamTitle),
        mappingRowExists: false,
        igdbCandidateFound: false
      });

      logSteamApp3321460CreateDebug({
        stage: 'final_resolution',
        libraryRowExists: Boolean(targetSourceInfo),
        libraryRowFound: Boolean(targetSourceInfo),
        libraryRowGameName: targetSourceInfo?.gameName ?? null,
        mappingRowExists: false,
        userId: targetSourceInfo?.userId ?? null,
        externalGameId: steamAppId,
        titleSource: titleResolution.titleSource,
        titleSourcesTried: titleResolution.titleSourcesTried ?? [],
        titleExtractionFailureReason: titleResolution.titleExtractionFailureReason ?? null,
        rawSteamTitle: effectiveSteamTitle || null,
        normalizedSteamTitle: normalization.strippedComparisonTitle || null,
        matchingFlowEntered: true,
        attemptedQueries: [],
        candidateCountsByQuery: [],
        topCandidateTitles: [],
        chosenCandidateId: null,
        chosenCandidateTitle: null,
        chosenConfidence: null,
        candidateRejectedReason: rateLimited ? 'rate_limited' : 'upstream_error',
        mappingInsertAttempted: false,
        mappingInsertSucceeded: false,
        mappingInsertSkippedReason: rateLimited ? 'rate_limited' : 'upstream_error',
        finalEnrichmentStatus: 'enrichment_failed',
        finalFallbackReason: rateLimited ? 'rate_limited' : 'upstream_error'
      });

      logger.warn('Steam IGDB match skipped', {
        steamAppId,
        rawSteamTitle: effectiveSteamTitle,
        normalizedSteamTitle: normalization.strippedComparisonTitle,
        comparisonTitle: normalization.strippedComparisonTitle,
        reason: rateLimited ? 'rate_limited' : 'upstream_error',
        code: error?.code,
        message: error?.message,
        finalEnrichmentStatus: 'enrichment_failure'
      });

      logger.info('steam-match-final', {
        stage: 'final_resolution',
        steamAppId,
        finalIgdbId: null,
        finalIgdbTitle: null,
        strategyUsed: 'steam_only',
        finalConfidenceScore: null,
        mappingUpserted: false
      });

      return {
        mapping: null,
        rateLimited,
        strategy: null
      };
    }
    })();

    activeSteamMatchResolutionPromises.set(resolutionKey, resolutionPromise);

    try {
      const result = await resolutionPromise;
      setTimeout(() => activeSteamMatchResolutionPromises.delete(resolutionKey), 30000);
      return result;
    } catch (error) {
      activeSteamMatchResolutionPromises.delete(resolutionKey);
      throw error;
    }
  });
}

function buildResolvedMappingMap({ dedupedGames, mappingMap, igdbGameMap }) {
  return new Map(
    dedupedGames.map((game) => {
      const mapping = mappingMap.get(game.externalGameId) ?? null;

      return [
        game.externalGameId,
        mapping
          ? {
            ...mapping,
            igdbGame: mapping.igdbGameId ? (igdbGameMap.get(mapping.igdbGameId) ?? null) : null,
            accepted: isAcceptedSteamIgdbMapping(mapping)
          }
          : null
      ];
    })
  );
}

async function buildAcceptedIgdbGameMap(mappingMap) {
  const acceptedIgdbIds = [...new Set(
    [...mappingMap.values()]
      .filter(isAcceptedSteamIgdbMapping)
      .map((mapping) => mapping?.igdbGameId)
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
  )];

  if (acceptedIgdbIds.length === 0) {
    return {
      igdbGameMap: new Map(),
      rateLimited: false,
      missingCount: 0
    };
  }

  try {
    const igdbGameResult = await igdbService.getGamesByIds({ gameIds: acceptedIgdbIds });
    return {
      igdbGameMap: new Map(
        (igdbGameResult.games ?? []).map((game) => [String(game.id), game])
      ),
      rateLimited: igdbGameResult?.meta?.liveFetchSkippedReason === 'rate_limited',
      missingCount: Array.isArray(igdbGameResult?.meta?.missingGameIds)
        ? igdbGameResult.meta.missingGameIds.length
        : 0
    };
  } catch (error) {
    logger.warn('Steam IGDB cover hydration skipped', {
      reason: isIgdbRateLimitedError(error) ? 'rate_limited' : 'upstream_error',
      code: error?.code,
      message: error?.message,
      igdbGameIdCount: acceptedIgdbIds.length
    });
    return {
      igdbGameMap: new Map(),
      rateLimited: isIgdbRateLimitedError(error),
      missingCount: acceptedIgdbIds.length
    };
  }
}

async function resolveSteamGameMappings(games) {
  const dedupedGames = [];
  const seenAppIds = new Set();

  for (const game of games ?? []) {
    const steamAppId = typeof game?.externalGameId === 'string' ? game.externalGameId.trim() : '';

    if (!steamAppId || seenAppIds.has(steamAppId)) {
      continue;
    }

    seenAppIds.add(steamAppId);
    dedupedGames.push(game);
  }

  if (dedupedGames.length === 0) {
    return {
      mappings: new Map(),
      igdbEnrichmentApplied: true,
      igdbEnrichmentSkippedReason: null,
      resolutionSummary: {
        steamAppIdCount: 0,
        cachedConfirmedCount: 0,
        unmatchedCountBeforeResolution: 0,
        externalGamesResolvedCount: 0,
        titleFallbackResolvedCount: 0,
        unmatchedCountAfterResolution: 0
      }
    };
  }

  const requestMemoKey = buildNormalizedSetCacheKey(
    dedupedGames.map((game) => getSteamMatchResolutionKey(game))
  );

  return memoizeLibraryRequestPromise('unmatchedSteamAppResolutionBySet', requestMemoKey, async () => {
    const cachedMappings = await prisma.steamIgdbMapping.findMany({
      where: {
        steamAppId: {
          in: dedupedGames.map((game) => game.externalGameId)
        }
      }
    });
    const cachedMappingMap = new Map(cachedMappings.map((mapping) => [mapping.steamAppId, mapping]));
    const recentSkipGames = [];
    const unresolvedGames = dedupedGames.filter((game) => {
      const cachedMapping = cachedMappingMap.get(game.externalGameId);
      const recentSkipEntry = getRecentSteamMatchSkipCache(game.externalGameId);

      if (!cachedMapping) {
        if (recentSkipEntry) {
          recentSkipGames.push({
            externalGameId: game.externalGameId,
            ...recentSkipEntry
          });
          return false;
        }

        return true;
      }

      if (cachedMapping.matchStatus === SteamIgdbMatchStatus.REJECTED) {
        return false;
      }

      if (recentSkipEntry && !isAcceptedSteamIgdbMapping(cachedMapping)) {
        recentSkipGames.push({
          externalGameId: game.externalGameId,
          ...recentSkipEntry
        });
        return false;
      }

      return !isAcceptedSteamIgdbMapping(cachedMapping);
    });

    for (const game of dedupedGames) {
      logSteamMatchInitialLookup({
        steamAppId: game.externalGameId,
        mapping: cachedMappingMap.get(game.externalGameId) ?? null
      });
    }

    if (seenAppIds.has('3321460')) {
      const targetCachedMapping = cachedMappingMap.get('3321460') ?? null;
      const targetGame = dedupedGames.find((game) => game.externalGameId === '3321460') ?? null;
      const targetRawTitle = targetGame?.gameName ?? targetGame?.title ?? null;

      logger.info('steam-match-creation-targeted-pipeline', {
        steamAppId: '3321460',
        gamePayloadExists: Boolean(targetGame),
        rawGamePayloadTitle: targetRawTitle,
        cachedMappingRowExists: Boolean(targetCachedMapping),
        cachedMappingRow: targetCachedMapping
          ? {
            steamAppId: targetCachedMapping.steamAppId,
            igdbGameId: targetCachedMapping.igdbGameId ?? null,
            matchedTitle: targetCachedMapping.matchedTitle ?? null,
            matchStatus: targetCachedMapping.matchStatus ?? null,
            confidenceScore: typeof targetCachedMapping.confidenceScore === 'number'
              ? Number(targetCachedMapping.confidenceScore)
              : null
          }
          : null,
        includedInUnresolvedSet: unresolvedGames.some((game) => game.externalGameId === '3321460'),
        skipReason: targetCachedMapping
          ? (targetCachedMapping.matchStatus === SteamIgdbMatchStatus.REJECTED
            ? 'cached_mapping_rejected'
            : (isAcceptedSteamIgdbMapping(targetCachedMapping) ? 'cached_mapping_already_confirmed' : 'will_retry_matching'))
          : 'no_cached_mapping_row'
      });

      if (!unresolvedGames.some((game) => game.externalGameId === '3321460')) {
        logSteamApp3321460CreateDebug({
          stage: 'initial_lookup',
          libraryRowExists: Boolean(targetGame),
          libraryRowFound: Boolean(targetGame),
          libraryRowGameName: targetRawTitle ?? null,
          mappingRowExists: Boolean(targetCachedMapping),
          userId: targetGame?.userId ?? null,
          externalGameId: '3321460',
          titleSource: targetRawTitle ? 'input_payload' : null,
          titleSourcesTried: targetRawTitle ? ['input_payload'] : [],
          titleExtractionFailureReason: targetRawTitle ? null : 'target_game_not_in_unresolved_set',
          rawSteamTitle: targetRawTitle,
          normalizedSteamTitle: targetRawTitle ? normalizeSteamTitle(targetRawTitle).strippedComparisonTitle : null,
          matchingFlowEntered: false,
          attemptedQueries: [],
          candidateCountsByQuery: [],
          topCandidateTitles: [],
          chosenCandidateId: targetCachedMapping?.igdbGameId ?? null,
          chosenCandidateTitle: targetCachedMapping?.matchedTitle ?? null,
          chosenConfidence: typeof targetCachedMapping?.confidenceScore === 'number'
            ? Number(targetCachedMapping.confidenceScore)
            : null,
          candidateRejectedReason: null,
          mappingInsertAttempted: false,
          mappingInsertSucceeded: false,
          mappingInsertSkippedReason: targetCachedMapping
            ? (targetCachedMapping.matchStatus === SteamIgdbMatchStatus.REJECTED
              ? 'cached_mapping_rejected'
              : (isAcceptedSteamIgdbMapping(targetCachedMapping) ? 'cached_mapping_already_confirmed' : 'excluded_from_unresolved_set'))
            : 'target_game_not_in_unresolved_set',
          finalEnrichmentStatus: isAcceptedSteamIgdbMapping(targetCachedMapping) ? 'steam_plus_igdb_enriched' : null,
          finalFallbackReason: targetCachedMapping
            ? null
            : 'missing_local_mapping_row'
        });
      }
    }

    const mappingMap = new Map(cachedMappingMap);
    let igdbEnrichmentApplied = true;
    let igdbEnrichmentSkippedReason = null;
    let processedUnresolvedCount = 0;
    let externalGamesResolvedCount = 0;
    let titleFallbackResolvedCount = 0;
    const cachedConfirmedCount = dedupedGames.filter((game) => {
      const cachedMapping = cachedMappingMap.get(game.externalGameId);
      return isAcceptedSteamIgdbMapping(cachedMapping);
    }).length;
    const unmatchedCountBeforeResolution = unresolvedGames.length;
    const unresolvedGamesToProcess = unresolvedGames.slice(0, MAX_UNRESOLVED_STEAM_APP_IDS_PER_REQUEST);
    const unresolvedSkippedByLimitCount = Math.max(unresolvedGames.length - unresolvedGamesToProcess.length, 0);

    if (cachedConfirmedCount > 0) {
      logger.info('steam-enrichment-skipped-existing-confirmed-mapping', {
        cachedConfirmedCount,
        requestedSteamAppIdCount: dedupedGames.length
      });
    }

    if (recentSkipGames.length > 0) {
      logger.info('steam-enrichment-skipped-recent-unmatched-cache', {
        skippedCount: recentSkipGames.length,
        sampleSteamAppIds: recentSkipGames.slice(0, 5).map((entry) => entry.externalGameId),
        reasons: [...new Set(recentSkipGames.map((entry) => entry.reason).filter(Boolean))]
      });
    }

    if (unresolvedSkippedByLimitCount > 0) {
      logger.warn('steam-enrichment-batch-capped', {
        requestedUnresolvedCount: unresolvedGames.length,
        processedUnresolvedLimit: MAX_UNRESOLVED_STEAM_APP_IDS_PER_REQUEST,
        skippedUnresolvedCount: unresolvedSkippedByLimitCount
      });
    }

    if (igdbService.isIgdbRateLimitCooldownActive() && unresolvedGamesToProcess.length > 0) {
      igdbEnrichmentApplied = false;
      igdbEnrichmentSkippedReason = IGDB_ENRICHMENT_SKIPPED_REASON_RATE_LIMITED;

      for (const game of unresolvedGamesToProcess) {
        setRecentSteamMatchSkipCache(game.externalGameId, {
          reason: 'rate_limited',
          ttlMs: RATE_LIMITED_SKIP_CACHE_TTL_MS,
          localTitleExists: hasUsableGameName(game.gameName) || hasUsableGameName(game.title),
          mappingRowExists: Boolean(cachedMappingMap.get(game.externalGameId)),
          igdbCandidateFound: false
        });
      }

      logger.warn('steam-enrichment-batch-stopped-rate-limited', {
        processedUnresolvedCount: 0,
        remainingUnresolvedCount: unresolvedGamesToProcess.length,
        reason: 'cooldown_active_at_batch_start'
      });

      const {
        igdbGameMap,
        rateLimited: cachedCoverRateLimited
      } = await buildAcceptedIgdbGameMap(mappingMap);

      if (cachedCoverRateLimited) {
        igdbEnrichmentApplied = false;
        igdbEnrichmentSkippedReason = IGDB_ENRICHMENT_SKIPPED_REASON_RATE_LIMITED;
      }

      return {
        mappings: buildResolvedMappingMap({
          dedupedGames,
          mappingMap,
          igdbGameMap
        }),
        igdbEnrichmentApplied,
        igdbEnrichmentSkippedReason,
        resolutionSummary: {
          steamAppIdCount: dedupedGames.length,
          cachedConfirmedCount,
          unmatchedCountBeforeResolution,
          externalGamesResolvedCount,
          titleFallbackResolvedCount,
          unmatchedCountAfterResolution: dedupedGames.filter((game) => {
            const mapping = mappingMap.get(game.externalGameId);
            return !isAcceptedSteamIgdbMapping(mapping);
          }).length
        }
      };
    }

    for (const game of unresolvedGamesToProcess) {
      const result = await resolveSingleSteamGameMapping(game);
      processedUnresolvedCount += 1;

      if (result.mapping?.steamAppId) {
        mappingMap.set(result.mapping.steamAppId, result.mapping);

        if (isAcceptedSteamIgdbMapping(result.mapping)) {
          if (result.strategy === 'external_games') {
            externalGamesResolvedCount += 1;
          } else if (result.strategy === 'title_search') {
            titleFallbackResolvedCount += 1;
          }
        }
      }

      if (result.rateLimited) {
        igdbEnrichmentApplied = false;
        igdbEnrichmentSkippedReason = IGDB_ENRICHMENT_SKIPPED_REASON_RATE_LIMITED;

        for (const remainingGame of unresolvedGamesToProcess.slice(processedUnresolvedCount)) {
          setRecentSteamMatchSkipCache(remainingGame.externalGameId, {
            reason: 'rate_limited',
            ttlMs: RATE_LIMITED_SKIP_CACHE_TTL_MS,
            localTitleExists: hasUsableGameName(remainingGame.gameName) || hasUsableGameName(remainingGame.title),
            mappingRowExists: Boolean(cachedMappingMap.get(remainingGame.externalGameId)),
            igdbCandidateFound: false
          });
        }

        logger.warn('steam-enrichment-batch-stopped-rate-limited', {
          processedUnresolvedCount,
          remainingUnresolvedCount: unresolvedGamesToProcess.length - processedUnresolvedCount,
          reason: 'rate_limited'
        });

        const {
          igdbGameMap,
          rateLimited: cachedCoverRateLimited
        } = await buildAcceptedIgdbGameMap(mappingMap);

        if (cachedCoverRateLimited) {
          igdbEnrichmentApplied = false;
          igdbEnrichmentSkippedReason = IGDB_ENRICHMENT_SKIPPED_REASON_RATE_LIMITED;
        }

        return {
          mappings: buildResolvedMappingMap({
            dedupedGames,
            mappingMap,
            igdbGameMap
          }),
          igdbEnrichmentApplied,
          igdbEnrichmentSkippedReason,
          resolutionSummary: {
            steamAppIdCount: dedupedGames.length,
            cachedConfirmedCount,
            unmatchedCountBeforeResolution,
            externalGamesResolvedCount,
            titleFallbackResolvedCount,
            unmatchedCountAfterResolution: dedupedGames.filter((game) => {
              const mapping = mappingMap.get(game.externalGameId);
              return !isAcceptedSteamIgdbMapping(mapping);
            }).length
          }
        };
      }
    }

    for (const game of dedupedGames) {
      const resolvedMapping = mappingMap.get(game.externalGameId) ?? null;

      if (isAcceptedSteamIgdbMapping(resolvedMapping) && cachedMappingMap.get(game.externalGameId)?.matchStatus === SteamIgdbMatchStatus.CONFIRMED) {
        logger.info('steam-match-final', {
          stage: 'final_resolution',
          steamAppId: game.externalGameId,
          finalIgdbId: resolvedMapping.igdbGameId ?? null,
          finalIgdbTitle: resolvedMapping.matchedTitle ?? null,
          strategyUsed: 'existing_mapping',
          finalConfidenceScore: typeof resolvedMapping.confidenceScore === 'number'
            ? Number(resolvedMapping.confidenceScore)
            : null,
          mappingUpserted: false
        });
      }
    }
    const {
      igdbGameMap,
      rateLimited: cachedCoverRateLimited,
      missingCount: cachedCoverMissingCount
    } = await buildAcceptedIgdbGameMap(mappingMap);

    if (cachedCoverRateLimited || (igdbService.isIgdbRateLimitCooldownActive() && (igdbGameMap.size === 0 || cachedCoverMissingCount > 0))) {
      igdbEnrichmentApplied = false;
      igdbEnrichmentSkippedReason = IGDB_ENRICHMENT_SKIPPED_REASON_RATE_LIMITED;
    }

    return {
      mappings: buildResolvedMappingMap({
        dedupedGames,
        mappingMap,
        igdbGameMap
      }),
      igdbEnrichmentApplied,
      igdbEnrichmentSkippedReason,
      resolutionSummary: {
        steamAppIdCount: dedupedGames.length,
        cachedConfirmedCount,
        unmatchedCountBeforeResolution,
        externalGamesResolvedCount,
        titleFallbackResolvedCount,
        unmatchedCountAfterResolution: dedupedGames.filter((game) => {
          const mapping = mappingMap.get(game.externalGameId);
          return !isAcceptedSteamIgdbMapping(mapping);
        }).length
      }
    };
  });
}

module.exports = {
  buildSteamMatchDebugSummary,
  normalizeSteamTitle,
  resolveSteamGameMappings
};
