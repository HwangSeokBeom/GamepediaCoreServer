const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');

function decodeExpirationDate(token) {
  const payload = jwt.decode(token);

  if (!payload || typeof payload.exp !== 'number') {
    throw new Error('Token expiration could not be determined');
  }

  return new Date(payload.exp * 1000);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      type: 'access'
    },
    env.jwtAccessSecret,
    {
      expiresIn: env.accessTokenExpiresIn
    }
  );
}

function generateRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      type: 'refresh'
    },
    env.jwtRefreshSecret,
    {
      expiresIn: env.refreshTokenExpiresIn,
      jwtid: crypto.randomUUID()
    }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwtRefreshSecret);
}

function createTokenPair(user) {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  return {
    accessToken,
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    refreshTokenExpiresAt: decodeExpirationDate(refreshToken)
  };
}

module.exports = {
  createTokenPair,
  hashToken,
  verifyAccessToken,
  verifyRefreshToken
};
