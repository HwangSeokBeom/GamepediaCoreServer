const {
  resolveExactSearchAlias,
  resolvePrefixSearchAlias
} = require('../modules/igdb/igdb.search-aliases');
const { normalizeQuery } = require('../modules/igdb/igdb.search-utils');
const { translateSearchQuery } = require('../modules/translation/libreTranslateClient');

const SEARCH_TRANSLATION_TARGET_LANGUAGE = 'en';
const SEARCH_TRANSLATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_TRANSLATION_CACHE_MAX_ENTRIES = 200;
const MIN_TRANSLATABLE_CHARACTER_COUNT = 2;

const searchTranslationCache = new Map();
const searchTranslationPendingRequests = new Map();

function needsTranslation(query) {
  return /[^\x00-\x7F]/.test(query);
}

function detectSourceLanguage(query) {
  if (/[\uAC00-\uD7A3]/u.test(query)) {
    return 'ko';
  }

  if (/[\u3040-\u30FF]/u.test(query)) {
    return 'ja';
  }

  if (/[\u4E00-\u9FFF]/u.test(query)) {
    return 'zh-CN';
  }

  return null;
}

function getMeaningfulCharacterCount(query) {
  return (query.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function buildTranslationCacheKey({ sourceLanguage, targetLanguage, normalizedQuery }) {
  return `${sourceLanguage}:${targetLanguage}:${normalizedQuery}`;
}

function getCachedTranslation(cacheKey) {
  const cachedEntry = searchTranslationCache.get(cacheKey);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    searchTranslationCache.delete(cacheKey);
    return null;
  }

  searchTranslationCache.delete(cacheKey);
  searchTranslationCache.set(cacheKey, cachedEntry);

  return cachedEntry.translatedQuery;
}

function setCachedTranslation(cacheKey, translatedQuery) {
  searchTranslationCache.set(cacheKey, {
    translatedQuery,
    expiresAt: Date.now() + SEARCH_TRANSLATION_CACHE_TTL_MS
  });

  if (searchTranslationCache.size <= SEARCH_TRANSLATION_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = searchTranslationCache.keys().next().value;

  if (oldestKey) {
    searchTranslationCache.delete(oldestKey);
  }
}

function getPendingTranslationRequest(cacheKey) {
  return searchTranslationPendingRequests.get(cacheKey) ?? null;
}

function logSearchResolution(resolution) {
  console.info(
    `[search-translation] originalQuery=${JSON.stringify(resolution.originalQuery)} normalizedQuery=${JSON.stringify(resolution.normalizedQuery)} compactQuery=${JSON.stringify(resolution.compactQuery)} exactAliasMatchedQuery=${JSON.stringify(resolution.exactAliasMatchedQuery)} exactAliasMatchedKey=${JSON.stringify(resolution.exactAliasMatchedKey)} prefixAliasMatchedQuery=${JSON.stringify(resolution.prefixAliasMatchedQuery)} prefixAliasMatchedKey=${JSON.stringify(resolution.prefixAliasMatchedKey)} aliasMatchType=${JSON.stringify(resolution.aliasMatchType)} aliasConfidence=${JSON.stringify(resolution.aliasConfidence)} aliasMatched=${resolution.aliasMatched} cacheHit=${resolution.translationCacheHit} translationSource=${JSON.stringify(resolution.translationSource)} translationSkipped=${resolution.translationSkipped} skipReason=${JSON.stringify(resolution.translationSkipReason)} translationRequested=${resolution.translationRequested} translated=${JSON.stringify(resolution.translatedQuery)} effectiveQuery=${JSON.stringify(resolution.effectiveQuery)}`
  );
}

function finalizeSearchResolution(resolution, {
  translationSource = null,
  translationSkipped,
  skipReason = null,
  cacheHit = false,
  translationRequested = false
}) {
  const finalizedResolution = {
    ...resolution,
    translationSource,
    translationSkipped,
    translationSkipReason: skipReason,
    translationCacheHit: cacheHit,
    aliasMatched: Boolean(resolution.exactAliasMatchedQuery || resolution.prefixAliasMatchedQuery),
    translationRequested
  };

  logSearchResolution(finalizedResolution);

  return finalizedResolution;
}

function buildSearchResolution({
  queryInfo,
  sourceLanguage,
  effectiveQuery,
  translationUsed,
  translationProvider,
  translatedQuery = null,
  aliasMatchType = null,
  exactAliasMatchedQuery = null,
  exactAliasMatchedKey = null,
  prefixAliasMatchedQuery = null,
  prefixAliasMatchedKey = null,
  aliasConfidence = null,
  aliasCandidateQueries = []
}) {
  return {
    originalQuery: queryInfo.trimmed,
    normalizedQuery: queryInfo.normalized,
    compactQuery: queryInfo.compact,
    effectiveQuery,
    translationUsed,
    translationProvider,
    sourceLanguage,
    translatedQuery,
    aliasMatchType,
    exactAliasMatchedQuery,
    exactAliasMatchedKey,
    prefixAliasMatchedQuery,
    prefixAliasMatchedKey,
    aliasConfidence,
    aliasCandidateQueries
  };
}

function buildAliasResolution({
  queryInfo,
  sourceLanguage,
  translatedQuery = null,
  exactAlias = null,
  prefixAlias = null,
  effectiveQuery,
  translationUsed,
  translationProvider
}) {
  return buildSearchResolution({
    queryInfo,
    sourceLanguage,
    effectiveQuery,
    translationUsed,
    translationProvider,
    translatedQuery,
    aliasMatchType: exactAlias?.matchType ?? prefixAlias?.matchType ?? null,
    exactAliasMatchedQuery: exactAlias?.target ?? null,
    exactAliasMatchedKey: exactAlias?.matchedKey ?? null,
    prefixAliasMatchedQuery: prefixAlias?.target ?? null,
    prefixAliasMatchedKey: prefixAlias?.matchedKey ?? null,
    aliasConfidence: exactAlias?.confidence ?? prefixAlias?.confidence ?? null,
    aliasCandidateQueries: exactAlias?.candidateQueries ?? prefixAlias?.candidateQueries ?? []
  });
}

async function requestSearchTranslation({ cacheKey, normalizedQuery, sourceLanguage }) {
  const pendingRequest = getPendingTranslationRequest(cacheKey);

  if (pendingRequest) {
    console.info(`[search-translation] cache_hit key=${cacheKey} source=pending translationSource=libretranslate`);

    return {
      ...(await pendingRequest),
      reusedPendingRequest: true
    };
  }

  console.info(
    `[search-translation] translation_called key=${cacheKey} sourceLanguage=${sourceLanguage} targetLanguage=${SEARCH_TRANSLATION_TARGET_LANGUAGE} translationSource=libretranslate`
  );

  const translationRequest = (async () => {
    const translatedQuery = await translateSearchQuery(normalizedQuery, {
      sourceLanguage,
      targetLanguage: SEARCH_TRANSLATION_TARGET_LANGUAGE
    });

    if (translatedQuery && translatedQuery !== normalizedQuery) {
      setCachedTranslation(cacheKey, translatedQuery);
    }

    return {
      translatedQuery,
      translationApplied: Boolean(translatedQuery && translatedQuery !== normalizedQuery)
    };
  })()
    .finally(() => {
      searchTranslationPendingRequests.delete(cacheKey);
    });

  searchTranslationPendingRequests.set(cacheKey, translationRequest);

  return {
    ...(await translationRequest),
    reusedPendingRequest: false
  };
}

async function resolveSearchQuery(query) {
  const queryInfo = normalizeQuery(query);
  const normalizedOriginalQuery = queryInfo.normalized;
  const sourceLanguage = detectSourceLanguage(queryInfo.trimmed);
  const meaningfulCharacterCount = getMeaningfulCharacterCount(normalizedOriginalQuery);
  const exactOriginalAlias = resolveExactSearchAlias(queryInfo);
  const prefixOriginalAlias = exactOriginalAlias ? null : resolvePrefixSearchAlias(queryInfo);

  if (!normalizedOriginalQuery) {
    return finalizeSearchResolution(buildAliasResolution({
      queryInfo,
      sourceLanguage: null,
      effectiveQuery: normalizedOriginalQuery,
      translationUsed: false,
      translationProvider: null
    }), {
      translationSkipped: true,
      skipReason: 'empty_query'
    });
  }

  if (exactOriginalAlias) {
    console.info(
      `[search-translation] alias_hit stage=original matchType=exact originalQuery=${JSON.stringify(normalizedOriginalQuery)} compactQuery=${JSON.stringify(queryInfo.compact)} matchedAliasKey=${JSON.stringify(exactOriginalAlias.matchedKey)} matchedInputKey=${JSON.stringify(exactOriginalAlias.matchedInputKey)} target=${JSON.stringify(exactOriginalAlias.target)} confidence=${JSON.stringify(exactOriginalAlias.confidence)}`
    );

    return finalizeSearchResolution(buildAliasResolution({
      queryInfo,
      sourceLanguage,
      exactAlias: exactOriginalAlias,
      effectiveQuery: exactOriginalAlias.target,
      translationUsed: false,
      translationProvider: 'alias-exact'
    }), {
      translationSkipped: true,
      skipReason: 'alias_exact'
    });
  }

  if (prefixOriginalAlias) {
    console.info(
      `[search-translation] alias_hit stage=original matchType=prefix originalQuery=${JSON.stringify(normalizedOriginalQuery)} compactQuery=${JSON.stringify(queryInfo.compact)} matchedAliasKey=${JSON.stringify(prefixOriginalAlias.matchedKey)} matchedInputKey=${JSON.stringify(prefixOriginalAlias.matchedInputKey)} target=${JSON.stringify(prefixOriginalAlias.target)} confidence=${JSON.stringify(prefixOriginalAlias.confidence)}`
    );
  }

  if (meaningfulCharacterCount < MIN_TRANSLATABLE_CHARACTER_COUNT) {
    return finalizeSearchResolution(buildAliasResolution({
      queryInfo,
      sourceLanguage,
      prefixAlias: prefixOriginalAlias,
      effectiveQuery: prefixOriginalAlias?.target ?? normalizedOriginalQuery,
      translationUsed: false,
      translationProvider: prefixOriginalAlias ? 'alias-prefix' : null
    }), {
      translationSkipped: true,
      skipReason: prefixOriginalAlias ? 'alias_prefix' : 'query_too_short'
    });
  }

  if (!needsTranslation(normalizedOriginalQuery)) {
    return finalizeSearchResolution(buildAliasResolution({
      queryInfo,
      sourceLanguage: null,
      prefixAlias: prefixOriginalAlias,
      effectiveQuery: prefixOriginalAlias?.target ?? normalizedOriginalQuery,
      translationUsed: false,
      translationProvider: prefixOriginalAlias ? 'alias-prefix' : null
    }), {
      translationSkipped: true,
      skipReason: prefixOriginalAlias ? 'alias_prefix' : 'ascii_query'
    });
  }

  if (!sourceLanguage) {
    return finalizeSearchResolution(buildAliasResolution({
      queryInfo,
      sourceLanguage: null,
      prefixAlias: prefixOriginalAlias,
      effectiveQuery: prefixOriginalAlias?.target ?? normalizedOriginalQuery,
      translationUsed: false,
      translationProvider: prefixOriginalAlias ? 'alias-prefix' : null
    }), {
      translationSkipped: true,
      skipReason: prefixOriginalAlias ? 'alias_prefix' : 'unsupported_script'
    });
  }

  const translationCacheKey = buildTranslationCacheKey({
    sourceLanguage,
    targetLanguage: SEARCH_TRANSLATION_TARGET_LANGUAGE,
    normalizedQuery: normalizedOriginalQuery
  });

  const cachedTranslation = getCachedTranslation(translationCacheKey);

  if (cachedTranslation) {
    const cachedAlias = resolveExactSearchAlias(cachedTranslation);
    const effectiveQuery = cachedAlias?.target ?? cachedTranslation;

    console.info(
      `[search-translation] cache_hit key=${translationCacheKey} original=${JSON.stringify(normalizedOriginalQuery)} translated=${JSON.stringify(cachedTranslation)} translationSource=libretranslate`
    );

    return finalizeSearchResolution(buildAliasResolution({
      queryInfo,
      sourceLanguage,
      translatedQuery: cachedTranslation,
      prefixAlias: prefixOriginalAlias,
      exactAlias: cachedAlias,
      effectiveQuery: prefixOriginalAlias?.target ?? effectiveQuery,
      translationUsed: true,
      translationProvider:
        cachedAlias
          ? 'libretranslate-alias'
          : (prefixOriginalAlias ? 'alias-prefix-libretranslate' : 'libretranslate')
    }), {
      translationSource: 'libretranslate',
      translationSkipped: true,
      skipReason: 'cache_hit',
      cacheHit: true
    });
  }

  const translationResult = await requestSearchTranslation({
    cacheKey: translationCacheKey,
    normalizedQuery: normalizedOriginalQuery,
    sourceLanguage
  });

  if (translationResult.translationApplied) {
    const translatedAlias = resolveExactSearchAlias(translationResult.translatedQuery);
    const effectiveQuery = translatedAlias?.target ?? translationResult.translatedQuery;

    return finalizeSearchResolution(buildAliasResolution({
      queryInfo,
      sourceLanguage,
      translatedQuery: translationResult.translatedQuery,
      prefixAlias: prefixOriginalAlias,
      exactAlias: translatedAlias,
      effectiveQuery: prefixOriginalAlias?.target ?? effectiveQuery,
      translationUsed: true,
      translationProvider:
        translatedAlias
          ? 'libretranslate-alias'
          : (prefixOriginalAlias ? 'alias-prefix-libretranslate' : 'libretranslate')
    }), {
      translationSource: 'libretranslate',
      translationSkipped: false,
      cacheHit: translationResult.reusedPendingRequest,
      translationRequested: !translationResult.reusedPendingRequest
    });
  }

  return finalizeSearchResolution(buildAliasResolution({
    queryInfo,
    sourceLanguage,
    translatedQuery: normalizedOriginalQuery,
    prefixAlias: prefixOriginalAlias,
    effectiveQuery: prefixOriginalAlias?.target ?? normalizedOriginalQuery,
    translationUsed: false,
    translationProvider: prefixOriginalAlias ? 'alias-prefix' : null
  }), {
    translationSource: 'libretranslate',
    translationSkipped: !translationResult.reusedPendingRequest,
    skipReason: translationResult.reusedPendingRequest ? 'inflight_hit' : 'translation_unavailable',
    cacheHit: translationResult.reusedPendingRequest,
    translationRequested: !translationResult.reusedPendingRequest
  });
}

module.exports = {
  detectSourceLanguage,
  needsTranslation,
  resolveSearchQuery
};
