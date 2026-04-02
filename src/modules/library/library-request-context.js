const { AsyncLocalStorage } = require('async_hooks');
const { logger } = require('../../utils/logger');

const libraryRequestContextStorage = new AsyncLocalStorage();
const REQUEST_CACHE_DEBUG_CATEGORIES = new Set([
  'recentPlayedBySteamId',
  'ownedGamesBySteamId',
  'igdbBatchByKey',
  'mappingResolutionByAppIdSet',
  'titleFallbackResolutionByExternalGameId',
  'unmatchedSteamAppResolutionBySet',
  'imageUrlByExternalGameId',
  'lastSteamSyncUpdate'
]);

function createLibraryRequestContext() {
  return {
    memoBuckets: new Map()
  };
}

function runWithLibraryRequestContext(callback) {
  const existingContext = libraryRequestContextStorage.getStore();

  if (existingContext) {
    return callback();
  }

  return libraryRequestContextStorage.run(createLibraryRequestContext(), callback);
}

function getLibraryRequestContext() {
  return libraryRequestContextStorage.getStore() ?? null;
}

function getMemoBucket(category) {
  const context = getLibraryRequestContext();

  if (!context) {
    return null;
  }

  if (!context.memoBuckets.has(category)) {
    context.memoBuckets.set(category, new Map());
  }

  return context.memoBuckets.get(category);
}

function logLibraryRequestCache(category, key, hit) {
  if (!REQUEST_CACHE_DEBUG_CATEGORIES.has(category)) {
    return;
  }

  logger.info('library-request-cache', {
    cacheType: category,
    cacheKey: key,
    hit
  });
}

function getLibraryRequestMemoEntry(category, key) {
  const memoBucket = getMemoBucket(category);

  if (!memoBucket) {
    return null;
  }

  return memoBucket.get(key) ?? null;
}

function setLibraryRequestMemoEntry(category, key, value) {
  const memoBucket = getMemoBucket(category);

  if (!memoBucket) {
    return value;
  }

  memoBucket.set(key, value);
  return value;
}

function buildNormalizedSetCacheKey(values) {
  return [...new Set(
    (values ?? [])
      .map((value) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          return String(value);
        }

        return typeof value === 'string' ? value.trim() : '';
      })
      .filter(Boolean)
  )]
    .sort()
    .join(',');
}

function memoizeLibraryRequestPromise(category, key, factory) {
  const memoBucket = getMemoBucket(category);

  if (!memoBucket) {
    return factory();
  }

  const existingEntry = memoBucket.get(key) ?? null;
  logLibraryRequestCache(category, key, Boolean(existingEntry));

  if (existingEntry) {
    if (REQUEST_CACHE_DEBUG_CATEGORIES.has(category) && existingEntry.__requestPromiseEntry && existingEntry.settled === false) {
      logger.info('cache-inflight-hit', {
        cacheType: category,
        cacheKey: key,
        hit: true
      });
    }

    return existingEntry.__requestPromiseEntry
      ? existingEntry.promise
      : existingEntry;
  }

  const entry = {
    __requestPromiseEntry: true,
    settled: false,
    promise: null
  };

  entry.promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      entry.settled = true;
    });

  memoBucket.set(key, entry);
  return entry.promise;
}

function memoizeLibraryRequestValue(category, key, factory) {
  const memoBucket = getMemoBucket(category);

  if (!memoBucket) {
    return factory();
  }

  const existingEntry = memoBucket.get(key) ?? null;
  logLibraryRequestCache(category, key, Boolean(existingEntry));

  if (existingEntry) {
    return existingEntry;
  }

  const value = factory();
  memoBucket.set(key, value);
  return value;
}

module.exports = {
  buildNormalizedSetCacheKey,
  getLibraryRequestMemoEntry,
  runWithLibraryRequestContext,
  memoizeLibraryRequestPromise,
  memoizeLibraryRequestValue,
  setLibraryRequestMemoEntry
};
