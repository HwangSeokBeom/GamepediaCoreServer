const { buildSearchAliasRules } = require('../search/aliases');
const { normalizeQuery } = require('./igdb.search-utils');

const MIN_PREFIX_ALIAS_LENGTH = 2;
const MIN_PREFIX_ALIAS_CONFIDENCE = 0.4;

const SEARCH_ALIAS_RULES = buildSearchAliasRules();
const exactAliasMap = new Map();
const prefixAliasEntries = [];

initializeAliasLookups();

function containsNonAscii(value) {
  return /[^\x00-\x7F]/.test(value);
}

function buildAliasCandidateQueries(rule) {
  const candidates = [];
  const targetInfo = normalizeQuery(rule.target);

  for (const normalizedTarget of targetInfo.normalizedVariants ?? [targetInfo.normalized]) {
    if (normalizedTarget && !candidates.includes(normalizedTarget)) {
      candidates.push(normalizedTarget);
    }
  }

  for (const canonicalQuery of rule.canonicalQueries ?? []) {
    const canonicalInfo = normalizeQuery(canonicalQuery);

    for (const normalizedCandidate of canonicalInfo.normalizedVariants ?? [canonicalInfo.normalized]) {
      if (normalizedCandidate && !candidates.includes(normalizedCandidate)) {
        candidates.push(normalizedCandidate);
      }
    }

    for (const compactCandidate of canonicalInfo.compactVariants ?? [canonicalInfo.compact]) {
      if (compactCandidate && compactCandidate.length >= MIN_PREFIX_ALIAS_LENGTH) {
        const wildcardCandidate = `${compactCandidate}*`;

        if (!candidates.includes(wildcardCandidate)) {
          candidates.push(wildcardCandidate);
        }
      }
    }
  }

  return candidates.slice(0, 5);
}

function createAliasEntry(rule, alias, order) {
  const aliasInfo = normalizeQuery(alias);
  const targetInfo = normalizeQuery(rule.target);

  return {
    locale: rule.locale ?? 'common',
    target: rule.target,
    matchedAliasKey: aliasInfo.compact || aliasInfo.normalized,
    normalizedAlias: aliasInfo.normalized,
    compactAlias: aliasInfo.compact,
    allowsSingleCharacterPrefix:
      aliasInfo.compact.length <= 2 &&
      targetInfo.tokens.length <= 1,
    candidateQueries: buildAliasCandidateQueries(rule),
    order
  };
}

function initializeAliasLookups() {
  let order = 0;

  for (const rule of SEARCH_ALIAS_RULES) {
    for (const alias of rule.aliases ?? []) {
      const aliasEntry = createAliasEntry(rule, alias, order);
      order += 1;

      if (aliasEntry.normalizedAlias && !exactAliasMap.has(aliasEntry.normalizedAlias)) {
        exactAliasMap.set(aliasEntry.normalizedAlias, aliasEntry);
      }

      if (aliasEntry.compactAlias && !exactAliasMap.has(aliasEntry.compactAlias)) {
        exactAliasMap.set(aliasEntry.compactAlias, aliasEntry);
      }

      if (containsNonAscii(alias) && aliasEntry.compactAlias.length >= MIN_PREFIX_ALIAS_LENGTH) {
        prefixAliasEntries.push(aliasEntry);
      }
    }
  }
}

function buildResolvedAlias(aliasEntry, matchType, {
  matchedInputKey = null,
  confidence = 1
} = {}) {
  return {
    target: aliasEntry.target,
    matchedKey: aliasEntry.matchedAliasKey,
    matchedInputKey,
    matchType,
    confidence,
    candidateQueries: aliasEntry.candidateQueries,
    locale: aliasEntry.locale
  };
}

function resolveExactSearchAlias(query) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const lookupKeys = [
    queryInfo.normalized,
    queryInfo.compact,
    ...(queryInfo.normalizedVariants ?? []),
    ...(queryInfo.compactVariants ?? [])
  ].filter(Boolean);

  for (const lookupKey of lookupKeys) {
    const aliasEntry = exactAliasMap.get(lookupKey);

    if (aliasEntry) {
      return buildResolvedAlias(aliasEntry, 'exact', {
        matchedInputKey: lookupKey,
        confidence: 1
      });
    }
  }

  return null;
}

function comparePrefixAliasEntries(leftEntry, rightEntry) {
  const confidenceDifference =
    rightEntry.matchConfidence - leftEntry.matchConfidence;

  if (confidenceDifference !== 0) {
    return confidenceDifference;
  }

  const compactLengthDifference = leftEntry.compactAlias.length - rightEntry.compactAlias.length;

  if (compactLengthDifference !== 0) {
    return compactLengthDifference;
  }

  return leftEntry.order - rightEntry.order;
}

function resolvePrefixSearchAlias(query) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const compactQueryCandidates = [...new Set([
    queryInfo.compact,
    ...(queryInfo.compactVariants ?? [])
  ].filter(Boolean))];

  for (const compactQuery of compactQueryCandidates) {
    const matchingAliasEntries = prefixAliasEntries
      .map((aliasEntry) => ({
        ...aliasEntry,
        matchConfidence: compactQuery.length / aliasEntry.compactAlias.length,
        minimumPrefixLength:
          aliasEntry.allowsSingleCharacterPrefix
            ? 1
            : Math.max(MIN_PREFIX_ALIAS_LENGTH, Math.ceil(aliasEntry.compactAlias.length * MIN_PREFIX_ALIAS_CONFIDENCE))
      }))
      .filter((aliasEntry) => (
        aliasEntry.compactAlias.startsWith(compactQuery) &&
        compactQuery.length >= aliasEntry.minimumPrefixLength &&
        aliasEntry.matchConfidence >= MIN_PREFIX_ALIAS_CONFIDENCE
      ));

    if (matchingAliasEntries.length === 0) {
      continue;
    }

    matchingAliasEntries.sort(comparePrefixAliasEntries);

    return buildResolvedAlias(matchingAliasEntries[0], 'prefix', {
      matchedInputKey: compactQuery,
      confidence: matchingAliasEntries[0].matchConfidence
    });
  }

  return null;
}

module.exports = {
  SEARCH_ALIAS_RULES,
  resolveExactSearchAlias,
  resolvePrefixSearchAlias
};
