const { env } = require('../config/env');

const BATCH_TRANSLATION_PATH = '/translations/batch';
const BATCH_TRANSLATION_TIMEOUT_MS = 8000;
const DEFAULT_TARGET_LANGUAGE = 'ko';
const DEFAULT_SOURCE_LANGUAGE = 'en';

/**
 * Translates the text fields of mapped search-result game objects
 * (name, summary) from English to the target language using
 * the translation proxy's batch endpoint.
 *
 * Design:
 *  - Collects unique non-empty strings, deduplicates before calling the proxy.
 *  - Falls back to original English text on any failure.
 *  - Preserves originals in `originalName` / `originalSummary`.
 */

async function translateSearchResults(games, { targetLanguage } = {}) {
  const target = targetLanguage ?? DEFAULT_TARGET_LANGUAGE;

  if (!Array.isArray(games) || games.length === 0) {
    return games;
  }

  if (!env.translationProxyBaseUrl) {
    console.warn('[result-translation] skipped reason=no_proxy_url');
    return games;
  }

  // Skip if target language is English — nothing to translate.
  if (target === DEFAULT_SOURCE_LANGUAGE) {
    return games;
  }

  // --- Collect unique texts to translate ---
  const nameSet = new Map();   // text -> [indices]
  const summarySet = new Map();

  for (let i = 0; i < games.length; i++) {
    const game = games[i];

    if (typeof game.name === 'string' && game.name.trim()) {
      const key = game.name.trim();
      if (!nameSet.has(key)) {
        nameSet.set(key, []);
      }
      nameSet.get(key).push(i);
    }

    if (typeof game.summary === 'string' && game.summary.trim()) {
      const key = game.summary.trim();
      if (!summarySet.has(key)) {
        summarySet.set(key, []);
      }
      summarySet.get(key).push(i);
    }
  }

  const uniqueNames = [...nameSet.keys()];
  const uniqueSummaries = [...summarySet.keys()];

  // --- Batch translate in parallel ---
  const [translatedNames, translatedSummaries] = await Promise.all([
    batchTranslate(uniqueNames, target, 'name'),
    batchTranslate(uniqueSummaries, target, 'summary')
  ]);

  // --- Build lookup maps ---
  const nameTranslationMap = buildTranslationMap(uniqueNames, translatedNames);
  const summaryTranslationMap = buildTranslationMap(uniqueSummaries, translatedSummaries);

  // --- Apply translations ---
  let translatedFieldCount = 0;
  let totalTranslatableFields = 0;

  const translatedGames = games.map((game) => {
    const originalName = game.name;
    const originalSummary = game.summary;
    const result = { ...game };

    // Name translation
    if (originalName && originalName.trim()) {
      totalTranslatableFields++;
      if (nameTranslationMap.has(originalName.trim())) {
        const translated = nameTranslationMap.get(originalName.trim());
        if (translated && translated !== originalName.trim()) {
          result.name = translated;
          result.originalName = originalName;
          translatedFieldCount++;
        }
      }
    }

    // Summary translation
    if (originalSummary && originalSummary.trim()) {
      totalTranslatableFields++;
      if (summaryTranslationMap.has(originalSummary.trim())) {
        const translated = summaryTranslationMap.get(originalSummary.trim());
        if (translated && translated !== originalSummary.trim()) {
          result.summary = translated;
          result.originalSummary = originalSummary;
          translatedFieldCount++;
        }
      }
    }

    return result;
  });

  const fallbackCount = totalTranslatableFields - translatedFieldCount;

  console.info(
    `[result-translation] done targetLanguage=${target} games=${games.length} translatedFields=${translatedFieldCount} fallbacks=${fallbackCount}`
  );

  return translatedGames;
}

async function batchTranslate(texts, targetLanguage, fieldName) {
  if (texts.length === 0) {
    return [];
  }

  const baseUrl = env.translationProxyBaseUrl.replace(/\/$/, '');

  let response;

  try {
    response = await fetch(`${baseUrl}${BATCH_TRANSLATION_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        texts,
        sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
        targetLanguage,
        fieldName
      }),
      signal: AbortSignal.timeout(BATCH_TRANSLATION_TIMEOUT_MS)
    });
  } catch (error) {
    console.warn(
      `[result-translation] batch_failed field=${fieldName} count=${texts.length} message=${error?.message ?? 'unknown'}`
    );
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.warn(
      `[result-translation] batch_upstream_error field=${fieldName} status=${response.status} body=${body.slice(0, 200)}`
    );
    return null;
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    console.warn(`[result-translation] batch_invalid_json field=${fieldName}`);
    return null;
  }

  if (!Array.isArray(payload?.translations)) {
    console.warn(`[result-translation] batch_unexpected_shape field=${fieldName}`);
    return null;
  }

  return payload.translations;
}

function buildTranslationMap(originals, translated) {
  const map = new Map();

  if (!Array.isArray(translated) || translated.length !== originals.length) {
    // Translation failed or mismatched — return empty map (fallback to originals).
    return map;
  }

  for (let i = 0; i < originals.length; i++) {
    const result = typeof translated[i] === 'string' ? translated[i].trim() : '';
    if (result) {
      map.set(originals[i], result);
    }
  }

  return map;
}

module.exports = {
  translateSearchResults
};
