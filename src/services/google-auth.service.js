const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');
const { AppError } = require('../utils/error-response');

const GOOGLE_IDENTITY_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_JWKS_TTL_MS = 60 * 60 * 1000;

let googleKeysCache = {
  keys: null,
  expiresAt: 0
};

function logGoogleTokenDebug(level, message, details) {
  logger[level](`[google-login:token] ${message}`, details);
}

function parseBooleanClaim(value) {
  return value === true || value === 'true';
}

function parseMaxAge(cacheControlHeader) {
  const matchedValue = cacheControlHeader?.match(/max-age=(\d+)/);

  if (!matchedValue) {
    return GOOGLE_JWKS_TTL_MS;
  }

  return Number(matchedValue[1]) * 1000;
}

async function fetchGooglePublicKeys(forceRefresh = false) {
  if (!forceRefresh && googleKeysCache.keys && googleKeysCache.expiresAt > Date.now()) {
    return googleKeysCache.keys;
  }

  let response;

  try {
    response = await fetch(GOOGLE_JWKS_URL, {
      signal: AbortSignal.timeout(5000)
    });
  } catch (error) {
    logGoogleTokenDebug('error', 'Failed to fetch Google public keys', {
      reason: error?.message ?? 'unknown'
    });
    throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google login is temporarily unavailable');
  }

  if (!response.ok) {
    logGoogleTokenDebug('error', 'Google public keys endpoint returned a non-OK response', {
      status: response.status
    });
    throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google login is temporarily unavailable');
  }

  let jwks;

  try {
    jwks = await response.json();
  } catch (error) {
    logGoogleTokenDebug('error', 'Failed to parse Google public keys response as JSON');
    throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google login is temporarily unavailable');
  }

  if (!jwks || !Array.isArray(jwks.keys)) {
    logGoogleTokenDebug('error', 'Google public keys response did not contain a valid keys array');
    throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google login is temporarily unavailable');
  }

  googleKeysCache = {
    keys: jwks.keys,
    expiresAt: Date.now() + parseMaxAge(response.headers.get('cache-control'))
  };

  return googleKeysCache.keys;
}

function findGoogleKey(keys, header) {
  return keys.find((key) => (
    key.kid === header.kid &&
    key.kty === 'RSA' &&
    (key.use === undefined || key.use === 'sig')
  ));
}

async function getGooglePublicKey(header) {
  const keys = await fetchGooglePublicKeys();
  let matchedKey = findGoogleKey(keys, header);

  if (!matchedKey) {
    const refreshedKeys = await fetchGooglePublicKeys(true);
    matchedKey = findGoogleKey(refreshedKeys, header);
  }

  if (!matchedKey) {
    logGoogleTokenDebug('warn', 'No Google public key matched the token header', {
      kid: header.kid,
      alg: header.alg
    });
    throw new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
  }

  try {
    return crypto.createPublicKey({
      key: matchedKey,
      format: 'jwk'
    });
  } catch (error) {
    logGoogleTokenDebug('warn', 'Failed to construct Google public key from JWK', {
      kid: header.kid
    });
    throw new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
  }
}

function mapGoogleTokenVerificationError(error) {
  if (error?.name === 'TokenExpiredError') {
    logGoogleTokenDebug('warn', 'Google ID token has expired');
    return new AppError(401, 'GOOGLE_ID_TOKEN_EXPIRED', 'Google ID token has expired');
  }

  logGoogleTokenDebug('warn', 'Google ID token verification failed', {
    name: error?.name ?? 'UnknownError',
    message: error?.message ?? 'unknown'
  });
  return new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
}

async function verifyIdToken(idToken) {
  if (!env.googleClientId) {
    logGoogleTokenDebug('error', 'GOOGLE_CLIENT_ID is not configured');
    throw new AppError(500, 'GOOGLE_AUTH_NOT_CONFIGURED', 'Google login is not configured');
  }

  const decodedToken = jwt.decode(idToken, { complete: true });

  if (!decodedToken || typeof decodedToken !== 'object' || typeof decodedToken.payload !== 'object') {
    logGoogleTokenDebug('warn', 'Google ID token could not be decoded into a valid JWT payload');
    throw new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
  }

  const { header } = decodedToken;

  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
    logGoogleTokenDebug('warn', 'Google ID token header is invalid', {
      alg: header?.alg ?? null,
      kid: header?.kid ?? null
    });
    throw new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
  }

  const publicKey = await getGooglePublicKey(header);
  let payload;

  try {
    payload = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      issuer: GOOGLE_IDENTITY_ISSUERS,
      audience: env.googleClientId,
      clockTolerance: 5
    });
  } catch (error) {
    throw mapGoogleTokenVerificationError(error);
  }

  if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string' || !payload.sub.trim()) {
    logGoogleTokenDebug('warn', 'Google ID token payload is missing a valid sub claim');
    throw new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
  }

  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null,
    emailVerified: parseBooleanClaim(payload.email_verified),
    hostedDomain: typeof payload.hd === 'string' ? payload.hd.trim() : null,
    name: typeof payload.name === 'string' ? payload.name.trim() : null,
    pictureUrl: typeof payload.picture === 'string' ? payload.picture.trim() : null
  };
}

module.exports = {
  verifyIdToken
};
