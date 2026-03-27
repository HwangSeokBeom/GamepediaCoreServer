const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { AppError } = require('../utils/error-response');

const GOOGLE_IDENTITY_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_JWKS_TTL_MS = 60 * 60 * 1000;

let googleKeysCache = {
  keys: null,
  expiresAt: 0
};

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
    throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google login is temporarily unavailable');
  }

  if (!response.ok) {
    throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google login is temporarily unavailable');
  }

  let jwks;

  try {
    jwks = await response.json();
  } catch (error) {
    throw new AppError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google login is temporarily unavailable');
  }

  if (!jwks || !Array.isArray(jwks.keys)) {
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
    throw new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
  }

  try {
    return crypto.createPublicKey({
      key: matchedKey,
      format: 'jwk'
    });
  } catch (error) {
    throw new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
  }
}

function mapGoogleTokenVerificationError(error) {
  if (error?.name === 'TokenExpiredError') {
    return new AppError(401, 'GOOGLE_ID_TOKEN_EXPIRED', 'Google ID token has expired');
  }

  return new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
}

async function verifyIdToken(idToken) {
  if (!env.googleClientId) {
    throw new AppError(500, 'GOOGLE_AUTH_NOT_CONFIGURED', 'Google login is not configured');
  }

  const decodedToken = jwt.decode(idToken, { complete: true });

  if (!decodedToken || typeof decodedToken !== 'object' || typeof decodedToken.payload !== 'object') {
    throw new AppError(401, 'GOOGLE_AUTH_INVALID_TOKEN', 'Google ID token is invalid');
  }

  const { header } = decodedToken;

  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
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
