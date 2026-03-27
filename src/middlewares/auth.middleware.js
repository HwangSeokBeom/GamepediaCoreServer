const { UserStatus } = require('@prisma/client');
const { prisma } = require('../config/prisma');
const tokenService = require('../services/token.service');
const { buildAccountStatusError, buildTokenVerificationError } = require('../utils/auth-error');
const { AppError } = require('../utils/error-response');
const { asyncHandler } = require('../utils/async-handler');

const authenticateAccessToken = asyncHandler(async (req, res, next) => {
  const authorizationHeader = req.headers.authorization;

  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'A valid bearer access token is required');
  }

  const accessToken = authorizationHeader.slice('Bearer '.length).trim();
  let payload;

  try {
    payload = tokenService.verifyAccessToken(accessToken);
  } catch (error) {
    throw buildTokenVerificationError(error);
  }

  if (payload.type !== 'access' || typeof payload.sub !== 'string') {
    throw new AppError(401, 'UNAUTHORIZED', 'Access token is invalid');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      status: true
    }
  });

  if (!user) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'User account could not be found');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw buildAccountStatusError(user.status);
  }

  req.auth = {
    userId: user.id,
    email: user.email,
    status: user.status
  };

  next();
});

module.exports = {
  authenticateAccessToken
};
