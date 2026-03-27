const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { AppError } = require('../utils/error-response');

const APPLE_IDENTITY_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_JWKS_TTL_MS = 60 * 60 * 1000;

let appleKeysCache = {
  keys: null,
  expiresAt: 0
};

function logAppleTokenDebug(level, message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  console[level](`[apple-login:token] ${message}${suffix}`);
}

function parseEmailVerifiedClaim(value) {
  return value === true || value === 'true';
}

function parseMaxAge(cacheControlHeader) {
  const matchedValue = cacheControlHeader?.match(/max-age=(\d+)/);

  if (!matchedValue) {
    return APPLE_JWKS_TTL_MS;
  }

  return Number(matchedValue[1]) * 1000;
}

async function fetchApplePublicKeys(forceRefresh = false) {
  if (!forceRefresh && appleKeysCache.keys && appleKeysCache.expiresAt > Date.now()) {
    return appleKeysCache.keys;
  }

  let response;

  try {
    response = await fetch(APPLE_JWKS_URL, {
      signal: AbortSignal.timeout(5000)
    });
  } catch (error) {
    logAppleTokenDebug('error', 'Failed to fetch Apple public keys', {
      reason: error?.message ?? 'unknown'
    });
    throw new AppError(503, 'APPLE_AUTH_UNAVAILABLE', 'Apple login is temporarily unavailable');
  }

  if (!response.ok) {
    logAppleTokenDebug('error', 'Apple public keys endpoint returned a non-OK response', {
      status: response.status
    });
    throw new AppError(503, 'APPLE_AUTH_UNAVAILABLE', 'Apple login is temporarily unavailable');
  }

  let jwks;

  try {
    jwks = await response.json();
  } catch (error) {
    logAppleTokenDebug('error', 'Failed to parse Apple public keys response as JSON');
    throw new AppError(503, 'APPLE_AUTH_UNAVAILABLE', 'Apple login is temporarily unavailable');
  }

  if (!jwks || !Array.isArray(jwks.keys)) {
    logAppleTokenDebug('error', 'Apple public keys response did not contain a valid keys array');
    throw new AppError(503, 'APPLE_AUTH_UNAVAILABLE', 'Apple login is temporarily unavailable');
  }

  appleKeysCache = {
    keys: jwks.keys,
    expiresAt: Date.now() + parseMaxAge(response.headers.get('cache-control'))
  };

  return appleKeysCache.keys;
}

async function getApplePublicKey(header) {
  const keys = await fetchApplePublicKeys();
  let matchedKey = keys.find((key) => (
    key.kid === header.kid &&
    key.alg === 'RS256' &&
    key.kty === 'RSA' &&
    key.use === 'sig'
  ));

  if (!matchedKey) {
    const refreshedKeys = await fetchApplePublicKeys(true);
    matchedKey = refreshedKeys.find((key) => (
      key.kid === header.kid &&
      key.alg === 'RS256' &&
      key.kty === 'RSA' &&
      key.use === 'sig'
    ));
  }

  if (!matchedKey) {
    logAppleTokenDebug('warn', 'No Apple public key matched the token header', {
      kid: header.kid,
      alg: header.alg
    });
    throw new AppError(401, 'APPLE_AUTH_INVALID_TOKEN', 'Apple identity token is invalid');
  }

  try {
    return crypto.createPublicKey({
      key: matchedKey,
      format: 'jwk'
    });
  } catch (error) {
    logAppleTokenDebug('warn', 'Failed to construct Apple public key from JWK', {
      kid: header.kid
    });
    throw new AppError(401, 'APPLE_AUTH_INVALID_TOKEN', 'Apple identity token is invalid');
  }
}

function mapAppleTokenVerificationError(error) {
  if (error?.name === 'TokenExpiredError') {
    logAppleTokenDebug('warn', 'Apple identity token has expired');
    return new AppError(401, 'APPLE_IDENTITY_TOKEN_EXPIRED', 'Apple identity token has expired');
  }

  logAppleTokenDebug('warn', 'Apple identity token verification failed', {
    name: error?.name ?? 'UnknownError',
    message: error?.message ?? 'unknown'
  });
  return new AppError(401, 'APPLE_AUTH_INVALID_TOKEN', 'Apple identity token is invalid');
}

async function verifyIdentityToken(identityToken) {
  if (!env.appleClientId) {
    logAppleTokenDebug('error', 'APPLE_CLIENT_ID is not configured');
    throw new AppError(500, 'APPLE_AUTH_NOT_CONFIGURED', 'Apple login is not configured');
  }

  const decodedToken = jwt.decode(identityToken, { complete: true });

  if (!decodedToken || typeof decodedToken !== 'object' || typeof decodedToken.payload !== 'object') {
    logAppleTokenDebug('warn', 'Apple identity token could not be decoded into a valid JWT payload');
    throw new AppError(401, 'APPLE_AUTH_INVALID_TOKEN', 'Apple identity token is invalid');
  }

  const { header } = decodedToken;

  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
    logAppleTokenDebug('warn', 'Apple identity token header is invalid', {
      alg: header?.alg ?? null,
      kid: header?.kid ?? null
    });
    throw new AppError(401, 'APPLE_AUTH_INVALID_TOKEN', 'Apple identity token is invalid');
  }

  const publicKey = await getApplePublicKey(header);
  let payload;

  try {
    payload = jwt.verify(identityToken, publicKey, {
      algorithms: ['RS256'],
      issuer: APPLE_IDENTITY_ISSUER,
      audience: env.appleClientId,
      clockTolerance: 5
    });
  } catch (error) {
    throw mapAppleTokenVerificationError(error);
  }

  if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string' || !payload.sub.trim()) {
    logAppleTokenDebug('warn', 'Apple identity token payload is missing a valid sub claim');
    throw new AppError(401, 'APPLE_AUTH_INVALID_TOKEN', 'Apple identity token is invalid');
  }

  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null,
    emailVerified: parseEmailVerifiedClaim(payload.email_verified)
  };
}

module.exports = {
  verifyIdentityToken
};
