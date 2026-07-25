const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

const SEARCH_LOG_DIRECTORY = path.join(process.cwd(), 'logs', 'search');
const SEARCH_LOG_FILE_PATH = path.join(SEARCH_LOG_DIRECTORY, 'search-queries.ndjson');

async function appendSearchLog(record) {
  try {
    await fs.mkdir(SEARCH_LOG_DIRECTORY, { recursive: true });
    await fs.appendFile(SEARCH_LOG_FILE_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    logger.warn('search-log-write-failed', {
      message: error?.message ?? 'Search log write failed'
    });
  }
}

function buildSearchLogRecord({
  endpoint,
  originalQuery,
  normalizedQuery,
  compactQuery,
  sourceLanguage = null,
  aliasHits = [],
  generatedCandidates = [],
  candidateQueriesActuallyUsed = [],
  igdbRawCount = 0,
  finalResultCount = 0,
  topResultTitles = [],
  elapsedMs = 0,
  cached = false,
  rerankTopReasons = []
}) {
  const topReasons = Array.isArray(rerankTopReasons) ? rerankTopReasons : [];
  const noResult = finalResultCount === 0;
  const topConfidenceReasons = new Set(
    topReasons.flatMap((item) => Array.isArray(item?.reasons) ? item.reasons : [])
  );
  const lowConfidence = !noResult && !(
    topConfidenceReasons.has('exact_title_match') ||
    topConfidenceReasons.has('compact_exact_match') ||
    topConfidenceReasons.has('alias_boost') ||
    topConfidenceReasons.has('prefix_match')
  );

  return {
    timestamp: new Date().toISOString(),
    endpoint,
    queryHash: crypto.createHash('sha256').update(String(normalizedQuery ?? originalQuery ?? '')).digest('hex'),
    queryLength: typeof originalQuery === 'string' ? originalQuery.length : 0,
    sourceLanguage,
    aliasHitCount: aliasHits.length,
    generatedCandidateCount: generatedCandidates.length,
    usedCandidateCount: candidateQueriesActuallyUsed.length,
    igdbRawCount,
    finalResultCount,
    topResultCount: topResultTitles.length,
    noResult,
    lowConfidence,
    cached,
    elapsedMs,
    rerankReasonCategories: [...topConfidenceReasons]
  };
}

module.exports = {
  appendSearchLog,
  buildSearchLogRecord,
  SEARCH_LOG_FILE_PATH
};
