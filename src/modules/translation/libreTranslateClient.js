const { env } = require('../../config/env');

const LIBRE_TRANSLATE_PATH = '/translate';
const DEFAULT_SOURCE_LANGUAGE = 'ko';
const DEFAULT_TARGET_LANGUAGE = 'en';

async function translateSearchQuery(text, { sourceLanguage, targetLanguage } = {}) {
  const normalizedText = typeof text === 'string' ? text.trim() : '';

  if (!normalizedText) {
    return normalizedText;
  }

  if (!env.libreTranslateUrl) {
    console.warn('[libretranslate] skipped reason=no_url');
    return normalizedText;
  }

  let response;

  try {
    response = await fetch(`${env.libreTranslateUrl.replace(/\/$/, '')}${LIBRE_TRANSLATE_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q: normalizedText,
        source: sourceLanguage ?? DEFAULT_SOURCE_LANGUAGE,
        target: targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
        format: 'text'
      }),
      signal: AbortSignal.timeout(env.libreTranslateTimeoutMs)
    });
  } catch (error) {
    console.warn(`[libretranslate] request_failed message=${error?.message ?? 'unknown'}`);
    return normalizedText;
  }

  if (!response.ok) {
    const upstreamBody = await response.text().catch(() => '');
    console.warn(
      `[libretranslate] upstream_error status=${response.status} body=${upstreamBody.slice(0, 200)}`
    );
    return normalizedText;
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    console.warn('[libretranslate] invalid_json');
    return normalizedText;
  }

  const translatedText =
    typeof payload?.translatedText === 'string'
      ? payload.translatedText.trim()
      : '';

  if (!translatedText) {
    console.warn('[libretranslate] unexpected_response_shape');
    return normalizedText;
  }

  return translatedText;
}

module.exports = {
  translateSearchQuery
};
