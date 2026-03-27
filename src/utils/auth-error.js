const { UserStatus } = require('@prisma/client');
const { AppError } = require('./error-response');

function buildAccountStatusError(status) {
  switch (status) {
    case UserStatus.INACTIVE:
      return new AppError(403, 'ACCOUNT_INACTIVE', 'This account is inactive');
    case UserStatus.SUSPENDED:
      return new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended');
    default:
      return new AppError(403, 'UNAUTHORIZED', 'This account is not available');
  }
}

function buildTokenVerificationError(error) {
  if (error?.name === 'TokenExpiredError') {
    return new AppError(401, 'TOKEN_EXPIRED', 'Token has expired');
  }

  return new AppError(401, 'UNAUTHORIZED', 'Token is invalid');
}

module.exports = {
  buildAccountStatusError,
  buildTokenVerificationError
};
