const { env } = require('../config/env');
const tokenService = require('./token.service');
const { logger } = require('../utils/logger');
const { AppError } = require('../utils/error-response');

const STEAM_AUTH_PROVIDER = 'STEAM';
const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const STEAM_STORE_APP_DETAILS_URL = 'https://store.steampowered.com/api/appdetails';
const STEAM_APP_REVIEWS_URL = 'https://store.steampowered.com/appreviews';
const STEAM_FRIEND_LIST_PATH = '/ISteamUser/GetFriendList/v0001/';
const STEAM_PLAYER_SUMMARIES_PATH = '/ISteamUser/GetPlayerSummaries/v0002/';
const STEAM_RECENTLY_PLAYED_PATH = '/IPlayerService/GetRecentlyPlayedGames/v0001/';
const STEAM_OWNED_GAMES_PATH = '/IPlayerService/GetOwnedGames/v0001/';
const UPSTREAM_TIMEOUT_MS = 8000;
const STEAM_PLAYER_SUMMARIES_BATCH_SIZE = 100;

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

function isSteamSyncConfigured() {
  return Boolean(env.steamApiKey);
}

function buildSteamCallbackUrl() {
  return new URL('/library/steam/callback', requireSteamLinkPublicBaseUrl()).toString();
}

function buildSteamWebApiUrl(path) {
  return new URL(path, env.steamWebApiBaseUrl).toString();
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

function uniqueStringValues(values) {
  return [...new Set(
    (values ?? [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  )];
}

function chunkValues(values, chunkSize) {
  const chunks = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function normalizeSteamId64(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();

  if (/^\d{17}$/.test(normalizedValue)) {
    return normalizedValue;
  }

  return parseSteamClaimedId(normalizedValue);
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

async function fetchSteamStoreJson(endpointUrl) {
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
    logger.error('Steam Store API request failed', {
      endpointUrl,
      error
    });
    throw new AppError(502, 'STEAM_STORE_UPSTREAM_ERROR', 'Steam Store is temporarily unavailable');
  }

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error('Steam Store API returned a non-OK response', {
      endpointUrl,
      status: response.status,
      body: upstreamBody.slice(0, 300)
    });
    throw new AppError(502, 'STEAM_STORE_UPSTREAM_ERROR', 'Steam Store is temporarily unavailable');
  }

  try {
    return await response.json();
  } catch (error) {
    logger.error('Steam Store API returned invalid JSON', {
      endpointUrl,
      error
    });
    throw new AppError(502, 'STEAM_STORE_UPSTREAM_ERROR', 'Steam Store is temporarily unavailable');
  }
}

async function fetchPlayerSummary({ steamId64 }) {
  requireSteamApiKey();

  const normalizedSteamId64 = normalizeSteamId64(steamId64);

  if (!normalizedSteamId64) {
    throw new AppError(400, 'STEAM_ID_INVALID', 'Steam account identifier is invalid');
  }

  const endpointUrl = new URL(buildSteamWebApiUrl(STEAM_PLAYER_SUMMARIES_PATH));

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

async function fetchPlayerSummaries({ steamIds64 }) {
  requireSteamApiKey();

  const normalizedSteamIds = uniqueStringValues(steamIds64)
    .map(normalizeSteamId64)
    .filter(Boolean);

  if (normalizedSteamIds.length === 0) {
    return {
      players: [],
      missingSteamIds: []
    };
  }

  const players = [];

  for (const steamIdBatch of chunkValues(normalizedSteamIds, STEAM_PLAYER_SUMMARIES_BATCH_SIZE)) {
    const endpointUrl = new URL(buildSteamWebApiUrl(STEAM_PLAYER_SUMMARIES_PATH));

    endpointUrl.searchParams.set('key', env.steamApiKey);
    endpointUrl.searchParams.set('steamids', steamIdBatch.join(','));

    const payload = await fetchSteamJson(endpointUrl.toString());
    const batchPlayers = Array.isArray(payload?.response?.players)
      ? payload.response.players
      : [];

    for (const player of batchPlayers) {
      const steamId64 = normalizeSteamId64(player?.steamid);

      if (!steamId64) {
        continue;
      }

      players.push({
        steamId64,
        personaName: typeof player.personaname === 'string' ? player.personaname.trim() : null,
        profileUrl: parseOptionalUrl(player.profileurl),
        avatarUrl: parseOptionalUrl(player.avatarfull) ?? parseOptionalUrl(player.avatarmedium) ?? parseOptionalUrl(player.avatar)
      });
    }
  }

  const foundSteamIds = new Set(players.map((player) => player.steamId64));

  return {
    players,
    missingSteamIds: normalizedSteamIds.filter((steamId) => !foundSteamIds.has(steamId))
  };
}

async function fetchPlayerSummarySafe({ steamId64 }) {
  if (!env.steamApiKey) {
    logger.warn('Steam profile enrichment skipped', {
      steamId64,
      code: 'STEAM_API_NOT_CONFIGURED',
      message: 'Steam integration is not configured'
    });

    return {
      steamId64: normalizeSteamId64(steamId64),
      personaName: null,
      profileUrl: null,
      avatarUrl: null
    };
  }

  try {
    const profile = await fetchPlayerSummary({ steamId64 });

    logger.info('Steam profile enrichment completed', {
      steamId64,
      steamWebApiBaseUrl: env.steamWebApiBaseUrl,
      hasPersonaName: Boolean(profile.personaName),
      hasAvatarUrl: Boolean(profile.avatarUrl),
      hasProfileUrl: Boolean(profile.profileUrl)
    });

    return profile;
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

function normalizeOptionalPlaytimeMinutes(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeSteamLastPlayedAt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function mapSteamRecentlyPlayedGame(game) {
  if (!Number.isInteger(game?.appid) || game.appid <= 0) {
    logger.warn('Steam game missing appid', {
      game
    });
    return null;
  }

  const externalGameId = String(game.appid).trim();

  if (!externalGameId) {
    logger.warn('Steam game missing externalGameId', {
      game
    });
    return null;
  }

  const mappedGame = {
    gameSource: 'STEAM',
    externalGameId,
    gameName: typeof game.name === 'string' ? game.name.trim() : null,
    playtimeMinutes: normalizeOptionalPlaytimeMinutes(game.playtime_forever),
    recentPlaytimeMinutes: normalizeOptionalPlaytimeMinutes(game.playtime_2weeks),
    lastPlayedAt: normalizeSteamLastPlayedAt(game.last_played)
  };

  return {
    source: 'steam',
    externalGameId: mappedGame.externalGameId,
    title: mappedGame.gameName,
    coverUrl: buildSteamLogoUrl(game.appid, game.img_logo_url),
    platform: 'Steam',
    playtimeText: buildPlaytimeText(mappedGame.recentPlaytimeMinutes),
    lastPlayedAt: mappedGame.lastPlayedAt,
    playtimeMinutes: mappedGame.playtimeMinutes,
    recentPlaytimeMinutes: mappedGame.recentPlaytimeMinutes
  };
}

function mapSteamOwnedGame(game) {
  if (!Number.isInteger(game?.appid) || game.appid <= 0) {
    logger.warn('Steam owned game missing appid', {
      game
    });
    return null;
  }

  const externalGameId = String(game.appid).trim();

  if (!externalGameId) {
    logger.warn('Steam owned game missing externalGameId', {
      game
    });
    return null;
  }

  const gameName = typeof game.name === 'string' ? game.name.trim() : null;

  if (!gameName) {
    logger.warn('Steam owned game missing name', {
      appid: game.appid
    });
    return null;
  }

  return {
    gameSource: 'STEAM',
    externalGameId,
    gameName,
    playtimeMinutes: normalizeOptionalPlaytimeMinutes(game.playtime_forever),
    recentPlaytimeMinutes: null,
    coverUrl: null
  };
}

async function fetchSteamStoreGenres({ appId }) {
  const normalizedAppId = typeof appId === 'string'
    ? appId.trim()
    : String(appId ?? '').trim();

  if (!/^\d+$/.test(normalizedAppId)) {
    throw new AppError(400, 'STEAM_APP_ID_INVALID', 'Steam app identifier is invalid');
  }

  const endpointUrl = new URL(STEAM_STORE_APP_DETAILS_URL);

  endpointUrl.searchParams.set('appids', normalizedAppId);
  endpointUrl.searchParams.set('l', 'english');
  endpointUrl.searchParams.set('filters', 'genres,categories');

  const payload = await fetchSteamStoreJson(endpointUrl.toString());
  const appPayload = payload?.[normalizedAppId];
  const appData = appPayload?.success ? appPayload.data : null;

  const genreLabels = Array.isArray(appData?.genres)
    ? appData.genres.map((genre) => genre?.description)
    : [];
  const categoryLabels = Array.isArray(appData?.categories)
    ? appData.categories.map((category) => category?.description)
    : [];

  return {
    appId: normalizedAppId,
    tags: uniqueStringValues([...genreLabels, ...categoryLabels])
  };
}

async function fetchAppReviewSummary({ appId }) {
  const normalizedAppId = typeof appId === 'string'
    ? appId.trim()
    : String(appId ?? '').trim();

  if (!/^\d+$/.test(normalizedAppId)) {
    throw new AppError(400, 'STEAM_APP_ID_INVALID', 'Steam app identifier is invalid');
  }

  const endpointUrl = `${STEAM_APP_REVIEWS_URL}/${normalizedAppId}?json=1&language=all&purchase_type=all&num_per_page=0`;
  const payload = await fetchSteamStoreJson(endpointUrl);

  if (!payload?.success || !payload?.query_summary) {
    return null;
  }

  const summary = payload.query_summary;

  return {
    reviewScore: summary.review_score ?? 0,
    reviewScoreDesc: typeof summary.review_score_desc === 'string' ? summary.review_score_desc : null,
    totalPositive: summary.total_positive ?? 0,
    totalNegative: summary.total_negative ?? 0,
    totalReviews: summary.total_reviews ?? 0
  };
}

async function fetchAppReviewSummarySafe({ appId }) {
  try {
    return await fetchAppReviewSummary({ appId });
  } catch (error) {
    logger.warn('Steam app review summary fetch skipped', {
      appId,
      code: error?.code,
      message: error?.message
    });
    return null;
  }
}

async function fetchFriendList({ steamId64 }) {
  requireSteamApiKey();

  const normalizedSteamId64 = normalizeSteamId64(steamId64);

  if (!normalizedSteamId64) {
    throw new AppError(400, 'STEAM_ID_INVALID', 'Steam account identifier is invalid');
  }

  const endpointUrl = new URL(buildSteamWebApiUrl(STEAM_FRIEND_LIST_PATH));

  endpointUrl.searchParams.set('key', env.steamApiKey);
  endpointUrl.searchParams.set('steamid', normalizedSteamId64);
  endpointUrl.searchParams.set('relationship', 'friend');

  const payload = await fetchSteamJson(endpointUrl.toString());
  const hasFriendsArray = Array.isArray(payload?.friendslist?.friends);
  const friends = hasFriendsArray ? payload.friendslist.friends : [];

  if (!hasFriendsArray) {
    logger.warn('Steam friend list returned no accessible friend data', {
      steamId64: normalizedSteamId64,
      code: 'STEAM_FRIENDS_UNAVAILABLE'
    });
  }

  return {
    steamIds: uniqueStringValues(friends.map((friend) => friend?.steamid)),
    syncWarningCode: hasFriendsArray ? null : 'STEAM_FRIENDS_UNAVAILABLE'
  };
}

const recentlyPlayedInFlightCache = new Map();
const RECENTLY_PLAYED_CACHE_TTL_MS = 30000;

async function fetchRecentlyPlayedGames({ steamId64 }) {
  requireSteamApiKey();

  const normalizedSteamId64 = normalizeSteamId64(steamId64);

  if (!normalizedSteamId64) {
    throw new AppError(400, 'STEAM_ID_INVALID', 'Steam account identifier is invalid');
  }

  if (recentlyPlayedInFlightCache.has(normalizedSteamId64)) {
    return recentlyPlayedInFlightCache.get(normalizedSteamId64);
  }

  const fetchPromise = (async () => {
    const endpointUrl = new URL(buildSteamWebApiUrl(STEAM_RECENTLY_PLAYED_PATH));

    endpointUrl.searchParams.set('key', env.steamApiKey);
    endpointUrl.searchParams.set('steamid', normalizedSteamId64);
    endpointUrl.searchParams.set('format', 'json');

    const payload = await fetchSteamJson(endpointUrl.toString());
    const hasGamesArray = Array.isArray(payload?.response?.games);
    const games = hasGamesArray ? payload.response.games : [];

    if (!hasGamesArray) {
      logger.debug('steam-friend-skip', {
        steamId64: normalizedSteamId64,
        reason: 'private_profile',
        code: 'STEAM_RECENTLY_PLAYED_UNAVAILABLE'
      });
    }

    return {
      games: games
        .slice()
        .sort((left, right) => (right?.playtime_2weeks ?? 0) - (left?.playtime_2weeks ?? 0))
        .map((game) => {
          logger.info('[SteamAPI Raw]', {
            steamId: normalizedSteamId64,
            appid: Number.isInteger(game?.appid) ? game.appid : null,
            playtime_2weeks: normalizeOptionalPlaytimeMinutes(game?.playtime_2weeks),
            playtime_forever: normalizeOptionalPlaytimeMinutes(game?.playtime_forever),
            last_played: normalizeSteamLastPlayedAt(game?.last_played)
          });

          return mapSteamRecentlyPlayedGame(game);
        })
        .filter(Boolean),
      syncWarningCode: hasGamesArray ? null : 'STEAM_RECENTLY_PLAYED_UNAVAILABLE'
    };
  })();

  recentlyPlayedInFlightCache.set(normalizedSteamId64, fetchPromise);

  try {
    const result = await fetchPromise;
    setTimeout(() => recentlyPlayedInFlightCache.delete(normalizedSteamId64), RECENTLY_PLAYED_CACHE_TTL_MS);
    return result;
  } catch (error) {
    recentlyPlayedInFlightCache.delete(normalizedSteamId64);
    throw error;
  }
}

async function fetchOwnedGames({ steamId64 }) {
  requireSteamApiKey();

  const normalizedSteamId64 = normalizeSteamId64(steamId64);

  if (!normalizedSteamId64) {
    throw new AppError(400, 'STEAM_ID_INVALID', 'Steam account identifier is invalid');
  }

  const endpointUrl = new URL(buildSteamWebApiUrl(STEAM_OWNED_GAMES_PATH));

  endpointUrl.searchParams.set('key', env.steamApiKey);
  endpointUrl.searchParams.set('steamid', normalizedSteamId64);
  endpointUrl.searchParams.set('include_appinfo', '1');
  endpointUrl.searchParams.set('include_played_free_games', '1');
  endpointUrl.searchParams.set('format', 'json');

  const payload = await fetchSteamJson(endpointUrl.toString());
  const hasGamesArray = Array.isArray(payload?.response?.games);
  const rawGames = hasGamesArray ? payload.response.games : [];
  const games = rawGames
    .map(mapSteamOwnedGame)
    .filter(Boolean);

  if (!hasGamesArray || rawGames.length === 0) {
    logger.debug('steam-friend-skip', {
      steamId64: normalizedSteamId64,
      reason: 'private_profile',
      code: 'STEAM_OWNED_GAMES_UNAVAILABLE'
    });
  }

  return {
    games,
    rawCount: rawGames.length,
    skippedCount: rawGames.length - games.length,
    syncWarningCode: hasGamesArray ? null : 'STEAM_OWNED_GAMES_UNAVAILABLE'
  };
}

module.exports = {
  STEAM_AUTH_PROVIDER,
  buildSteamLinkUrl,
  fetchAppReviewSummary,
  fetchAppReviewSummarySafe,
  fetchFriendList,
  fetchSteamStoreGenres,
  fetchOwnedGames,
  fetchPlayerSummary,
  fetchPlayerSummaries,
  fetchPlayerSummarySafe,
  fetchRecentlyPlayedGames,
  isSteamSyncConfigured,
  normalizeSteamId64,
  parseSteamLinkState,
  verifySteamOpenIdCallback
};
