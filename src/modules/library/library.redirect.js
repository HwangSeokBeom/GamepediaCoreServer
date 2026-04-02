const { env } = require('../../config/env');

const DEFAULT_FAILURE_CODE = 'STEAM_LINK_FAILED';
const DEFAULT_FAILURE_MESSAGE = 'Steam linking could not be completed';
const MAX_REDIRECT_MESSAGE_LENGTH = 120;

function sanitizeRedirectCode(code) {
  if (typeof code !== 'string') {
    return DEFAULT_FAILURE_CODE;
  }

  const normalizedCode = code.trim().toUpperCase();

  return normalizedCode.length > 0 ? normalizedCode : DEFAULT_FAILURE_CODE;
}

function sanitizeRedirectMessage(message) {
  if (typeof message !== 'string') {
    return DEFAULT_FAILURE_MESSAGE;
  }

  const normalizedMessage = message.replace(/\s+/g, ' ').trim();

  if (!normalizedMessage) {
    return DEFAULT_FAILURE_MESSAGE;
  }

  return normalizedMessage.slice(0, MAX_REDIRECT_MESSAGE_LENGTH);
}

function normalizeRedirectBaseUrl(redirectUri) {
  if (typeof redirectUri === 'string' && redirectUri.trim()) {
    return new URL(redirectUri.trim()).toString();
  }

  return env.mobileAppSteamCallbackUrl;
}

function buildSteamCallbackRedirectUrl(redirectUri, params) {
  const url = new URL(normalizeRedirectBaseUrl(redirectUri));

  for (const [key, value] of Object.entries(params)) {
    if (value == null) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function buildSteamLinkSuccessRedirectUrl(redirectUri) {
  return buildSteamCallbackRedirectUrl(redirectUri, {
    status: 'success',
    linked: true
  });
}

function buildSteamLinkFailureRedirectUrl(redirectUri, error) {
  return buildSteamCallbackRedirectUrl(redirectUri, {
    status: 'failed',
    linked: false,
    code: sanitizeRedirectCode(error?.code),
    message: sanitizeRedirectMessage(error?.message)
  });
}

module.exports = {
  buildSteamLinkFailureRedirectUrl,
  buildSteamLinkSuccessRedirectUrl,
  normalizeRedirectBaseUrl
};
