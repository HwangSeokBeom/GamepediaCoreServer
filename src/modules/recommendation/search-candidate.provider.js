const { getGameCandidates } = require('./game-candidate.provider');
const {
  inferSearchIntent,
  normalizeSearchQuery
} = require('./search-assist-ranker');

const TARGET_SEARCH_CANDIDATE_COUNT = 50;

async function getSearchCandidates({
  query,
  platforms = [],
  genres = [],
  targetCount = TARGET_SEARCH_CANDIDATE_COUNT
}) {
  const intent = inferSearchIntent({ query, platforms, genres });
  const normalizedQuery = normalizeSearchQuery(query, intent);
  const searchTerms = [...new Set([
    ...genres,
    ...(intent.keywords ?? []),
    normalizedQuery
  ].filter(Boolean))];

  return getGameCandidates({
    query,
    platforms,
    preferredGenres: searchTerms,
    excludedGameIds: [],
    targetCount
  });
}

module.exports = {
  TARGET_SEARCH_CANDIDATE_COUNT,
  getSearchCandidates
};
