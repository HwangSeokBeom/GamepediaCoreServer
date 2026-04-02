const {
  resolveExactSearchAlias,
  resolvePrefixSearchAlias
} = require('../modules/igdb/igdb.search-aliases');
const { normalizeQuery } = require('../modules/igdb/igdb.search-utils');

// Legacy filename kept for compatibility. The active implementation is
// alias-based query resolution and does not call any external translator.
const MIN_TRANSLATABLE_CHARACTER_COUNT = 2;

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
    return 'zh-Hans';
  }

  return null;
}

function getMeaningfulCharacterCount(query) {
  return (query.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function finalizeSearchResolution(resolution, {
  translationSource = null,
  translationSkipped,
  skipReason = null,
  cacheHit = false,
  translationRequested = false
}) {
  return {
    ...resolution,
    translationSource,
    translationSkipped,
    translationSkipReason: skipReason,
    translationCacheHit: cacheHit,
    aliasMatched: Boolean(resolution.exactAliasMatchedQuery || resolution.prefixAliasMatchedQuery),
    translationRequested
  };
}

function buildSearchResolution({
  queryInfo,
  sourceLanguage,
  effectiveQuery,
  translationUsed,
  translationProvider,
  translatedQuery = null,
  aliasMatchType = null,
  aliasLocale = null,
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
    aliasLocale,
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
    aliasMatchType: exactAlias?.matchType ?? prefixAlias?.matchType ?? null,
    aliasLocale: exactAlias?.locale ?? prefixAlias?.locale ?? null,
    exactAliasMatchedQuery: exactAlias?.target ?? null,
    exactAliasMatchedKey: exactAlias?.matchedKey ?? null,
    prefixAliasMatchedQuery: prefixAlias?.target ?? null,
    prefixAliasMatchedKey: prefixAlias?.matchedKey ?? null,
    aliasConfidence: exactAlias?.confidence ?? prefixAlias?.confidence ?? null,
    aliasCandidateQueries: exactAlias?.candidateQueries ?? prefixAlias?.candidateQueries ?? []
  });
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

  return finalizeSearchResolution(buildAliasResolution({
    queryInfo,
    sourceLanguage,
    prefixAlias: prefixOriginalAlias,
    effectiveQuery: prefixOriginalAlias?.target ?? normalizedOriginalQuery,
    translationUsed: false,
    translationProvider: prefixOriginalAlias ? 'alias-prefix' : null
  }), {
    translationSkipped: true,
    skipReason: prefixOriginalAlias ? 'alias_prefix' : 'alias_only_search_pipeline'
  });
}

module.exports = {
  detectSourceLanguage,
  needsTranslation,
  resolveSearchQuery
};
