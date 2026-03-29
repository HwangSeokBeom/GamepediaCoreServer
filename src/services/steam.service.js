const { env } = require('../config/env');
const tokenService = require('./token.service');
const { logger } = require('../utils/logger');
const { AppError } = require('../utils/error-response');

const STEAM_AUTH_PROVIDER = 'STEAM';
const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const STEAM_PLAYER_SUMMARIES_URL = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/';
const STEAM_RECENTLY_PLAYED_URL = 'https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/';
const UPSTREAM_TIMEOUT_MS = 8000;

function parseOptionalUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    return new URL(value.trim()).toString();
  } catch (error) {
    return null;
  }
}

function requireSteamLinkPublicBaseUrl() {
  if (!env.apiPublicBaseUrl) {
    throw new AppError(500, 'STEAM_LINK_NOT_CONFIGURED', 'Steam account linking is not configured');
  }

  return env.apiPublicBaseUrl;
}

function requireSteamApiKey() {
  if (!env.steamApiKey) {
    throw new AppError(500, 'STEAM_API_NOT_CONFIGURED', 'Steam integration is not configured');
  }
}

function buildSteamCallbackUrl() {
  return new URL('/library/steam/callback', requireSteamLinkPublicBaseUrl()).toString();
}

function buildSteamRealm() {
  return new URL(requireSteamLinkPublicBaseUrl()).origin;
}

function buildSteamLogoUrl(appId, logoHash) {
  if (!appId || typeof logoHash !== 'string' || !logoHash.trim()) {
    return null;
  }

  return `https://media.steampowered.com/steamcommunity/public/images/apps/${appId}/${logoHash.trim()}.jpg`;
}

function normalizeSteamId64(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();

  return /^\d{17}$/.test(normalizedValue) ? normalizedValue : null;
}

function parseSteamClaimedId(claimedId) {
  if (typeof claimedId !== 'string') {
    return null;
  }

  const match = claimedId.trim().match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/i);

  return match ? match[1] : null;
}

function parseSteamLinkState(stateToken) {
  let payload;

  try {
    payload = tokenService.verifySteamLinkStateToken(stateToken);
  } catch (error) {
    throw new AppError(400, 'STEAM_LINK_STATE_INVALID', 'Steam link session is invalid or expired');
  }

  if (
    !payload ||
    payload.type !== 'steam_link' ||
    typeof payload.sub !== 'string'
  ) {
    throw new AppError(400, 'STEAM_LINK_STATE_INVALID', 'Steam link session is invalid or expired');
  }

  return {
    userId: payload.sub,
    redirectUri: parseOptionalUrl(payload.redirectUri),
    expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null
  };
}

function buildSteamLinkUrl({ userId, redirectUri }) {
  const { stateToken, expiresAt } = tokenService.createSteamLinkStateToken({
    userId,
    redirectUri: parseOptionalUrl(redirectUri)
  });
  const authUrl = new URL(STEAM_OPENID_URL);
  const callbackUrl = new URL(buildSteamCallbackUrl());

  callbackUrl.searchParams.set('state', stateToken);

  authUrl.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
  authUrl.searchParams.set('openid.mode', 'checkid_setup');
  authUrl.searchParams.set('openid.return_to', callbackUrl.toString());
  authUrl.searchParams.set('openid.realm', buildSteamRealm());
  authUrl.searchParams.set('openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select');
  authUrl.searchParams.set('openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select');

  return {
    authUrl: authUrl.toString(),
    expiresAt
  };
}

function buildOpenIdVerificationParams(query) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) {
    if (key === 'state' || !key.startsWith('openid.')) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          params.append(key, item);
        }
      }

      continue;
    }

    if (typeof value === 'string') {
      params.append(key, value);
    }
  }

  params.set('openid.mode', 'check_authentication');

  return params;
}

async function verifySteamOpenIdCallback(query) {
  const verificationParams = buildOpenIdVerificationParams(query);

  if (!verificationParams.get('openid.claimed_id') || !verificationParams.get('openid.sig')) {
    throw new AppError(400, 'STEAM_LINK_INVALID_CALLBACK', 'Steam callback payload is invalid');
  }

  let response;

  try {
    response = await fetch(STEAM_OPENID_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: verificationParams.toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    logger.error('Steam OpenID verification request failed', { error });
    throw new AppError(502, 'STEAM_LINK_UPSTREAM_ERROR', 'Steam is temporarily unavailable');
  }

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error('Steam OpenID verification returned a non-OK response', {
      status: response.status,
      body: upstreamBody.slice(0, 300)
    });
    throw new AppError(502, 'STEAM_LINK_UPSTREAM_ERROR', 'Steam is temporarily unavailable');
  }

  const verificationBody = await response.text();

  if (!verificationBody.includes('is_valid:true')) {
    throw new AppError(401, 'STEAM_LINK_VERIFICATION_FAILED', 'Steam account verification failed');
  }

  const steamId64 = parseSteamClaimedId(query?.['openid.claimed_id'] ?? query?.['openid.identity']);

  if (!steamId64) {
    throw new AppError(400, 'STEAM_LINK_INVALID_CALLBACK', 'Steam callback payload is invalid');
  }

  return {
    steamId64
  };
}

async function fetchSteamJson(endpointUrl) {
  let response;

  try {
    response = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    logger.error('Steam Web API request failed', {
      endpointUrl,
      error
    });
    throw new AppError(502, 'STEAM_UPSTREAM_ERROR', 'Steam is temporarily unavailable');
  }

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error('Steam Web API returned a non-OK response', {
      endpointUrl,
      status: response.status,
      body: upstreamBody.slice(0, 300)
    });
    throw new AppError(502, 'STEAM_UPSTREAM_ERROR', 'Steam is temporarily unavailable');
  }

  try {
    return await response.json();
  } catch (error) {
    logger.error('Steam Web API returned invalid JSON', {
      endpointUrl,
      error
    });
    throw new AppError(502, 'STEAM_UPSTREAM_ERROR', 'Steam is temporarily unavailable');
  }
}

async function fetchPlayerSummary({ steamId64 }) {
  requireSteamApiKey();

  const normalizedSteamId64 = normalizeSteamId64(steamId64);

  if (!normalizedSteamId64) {
    throw new AppError(400, 'STEAM_ID_INVALID', 'Steam account identifier is invalid');
  }

  const endpointUrl = new URL(STEAM_PLAYER_SUMMARIES_URL);

  endpointUrl.searchParams.set('key', env.steamApiKey);
  endpointUrl.searchParams.set('steamids', normalizedSteamId64);

  const payload = await fetchSteamJson(endpointUrl.toString());
  const player = payload?.response?.players?.[0];

  if (!player) {
    throw new AppError(404, 'STEAM_PROFILE_NOT_FOUND', 'Steam profile could not be found');
  }

  return {
    steamId64: normalizedSteamId64,
    personaName: typeof player.personaname === 'string' ? player.personaname.trim() : null,
    profileUrl: parseOptionalUrl(player.profileurl),
    avatarUrl: parseOptionalUrl(player.avatarfull) ?? parseOptionalUrl(player.avatarmedium) ?? parseOptionalUrl(player.avatar)
  };
}

async function fetchPlayerSummarySafe({ steamId64 }) {
  try {
    return await fetchPlayerSummary({ steamId64 });
  } catch (error) {
    logger.warn('Steam profile refresh skipped', {
      steamId64,
      code: error?.code,
      message: error?.message
    });
    return {
      steamId64: normalizeSteamId64(steamId64),
      personaName: null,
      profileUrl: null,
      avatarUrl: null
    };
  }
}

function buildPlaytimeText(playtimeMinutes) {
  const normalizedValue = Number.isInteger(playtimeMinutes) && playtimeMinutes >= 0 ? playtimeMinutes : 0;
  return `최근 2주 ${normalizedValue}분`;
}

async function fetchRecentlyPlayedGames({ steamId64 }) {
  requireSteamApiKey();

  const normalizedSteamId64 = normalizeSteamId64(steamId64);

  if (!normalizedSteamId64) {
    throw new AppError(400, 'STEAM_ID_INVALID', 'Steam account identifier is invalid');
  }

  const endpointUrl = new URL(STEAM_RECENTLY_PLAYED_URL);

  endpointUrl.searchParams.set('key', env.steamApiKey);
  endpointUrl.searchParams.set('steamid', normalizedSteamId64);
  endpointUrl.searchParams.set('format', 'json');

  const payload = await fetchSteamJson(endpointUrl.toString());
  const games = Array.isArray(payload?.response?.games) ? payload.response.games : [];

  return {
    games: games
      .slice()
      .sort((left, right) => (right?.playtime_2weeks ?? 0) - (left?.playtime_2weeks ?? 0))
      .map((game) => ({
        source: 'steam',
        externalGameId: String(game.appid),
        title: typeof game.name === 'string' ? game.name.trim() : null,
        coverUrl: buildSteamLogoUrl(game.appid, game.img_logo_url),
        platform: 'Steam',
        playtimeText: buildPlaytimeText(game.playtime_2weeks),
        lastPlayedAt: null,
        playtimeMinutes: Number.isInteger(game.playtime_2weeks) ? game.playtime_2weeks : null
      }))
  };
}

module.exports = {
  STEAM_AUTH_PROVIDER,
  buildSteamLinkUrl,
  fetchPlayerSummary,
  fetchPlayerSummarySafe,
  fetchRecentlyPlayedGames,
  parseSteamLinkState,
  verifySteamOpenIdCallback
};
