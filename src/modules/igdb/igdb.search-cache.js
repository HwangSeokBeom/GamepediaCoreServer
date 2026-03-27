const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 200;

const searchCache = new Map();
const suggestionCache = new Map();

function getCacheEntry(cache, key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  cache.delete(key);
  cache.set(key, entry);

  return entry.value;
}

function setCacheEntry(cache, key, value) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS
  });

  if (cache.size <= SEARCH_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = cache.keys().next().value;

  if (oldestKey) {
    cache.delete(oldestKey);
  }
}

function buildSearchCacheKey(normalizedQuery) {
  return `search:${normalizedQuery}`;
}

function buildSuggestionCacheKey(normalizedQuery) {
  return `suggestion:${normalizedQuery}`;
}

function getCachedSearch(normalizedQuery) {
  return getCacheEntry(searchCache, buildSearchCacheKey(normalizedQuery));
}

function setCachedSearch(normalizedQuery, value) {
  setCacheEntry(searchCache, buildSearchCacheKey(normalizedQuery), value);
}

function getCachedSuggestions(normalizedQuery) {
  return getCacheEntry(suggestionCache, buildSuggestionCacheKey(normalizedQuery));
}

function setCachedSuggestions(normalizedQuery, value) {
  setCacheEntry(suggestionCache, buildSuggestionCacheKey(normalizedQuery), value);
}

module.exports = {
  getCachedSearch,
  getCachedSuggestions,
  setCachedSearch,
  setCachedSuggestions
};
