const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');

const LIBRE_TRANSLATE_PATH = '/translate';
const DEFAULT_SOURCE_LANGUAGE = 'ko';
const DEFAULT_TARGET_LANGUAGE = 'en';

async function translateSearchQuery(text, { sourceLanguage, targetLanguage } = {}) {
  const normalizedText = typeof text === 'string' ? text.trim() : '';

  if (!normalizedText) {
    return normalizedText;
  }

  if (!env.libreTranslateUrl) {
    logger.warn('LibreTranslate request skipped because URL is not configured');
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
    logger.warn('LibreTranslate request failed', { error });
    return normalizedText;
  }

  if (!response.ok) {
    const upstreamBody = await response.text().catch(() => '');
    logger.warn('LibreTranslate upstream returned a non-OK response', {
      status: response.status,
      body: upstreamBody.slice(0, 200)
    });
    return normalizedText;
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    logger.warn('LibreTranslate returned invalid JSON', { error });
    return normalizedText;
  }

  const translatedText =
    typeof payload?.translatedText === 'string'
      ? payload.translatedText.trim()
      : '';

  if (!translatedText) {
    logger.warn('LibreTranslate returned an unexpected response shape');
    return normalizedText;
  }

  return translatedText;
}

module.exports = {
  translateSearchQuery
};
