const crypto = require('crypto');
const { Prisma, UserStatus } = require('@prisma/client');
const { env } = require('../config/env');
const { prisma } = require('../config/prisma');
const appleAuthService = require('./apple-auth.service');
const googleAuthService = require('./google-auth.service');
const passwordService = require('./password.service');
const passwordResetEmailService = require('./password-reset-email.service');
const tokenService = require('./token.service');
const { buildAccountStatusError, buildTokenVerificationError } = require('../utils/auth-error');
const { AppError } = require('../utils/error-response');
const { mapUserToDto } = require('../modules/user/user.mapper');

const APPLE_AUTH_PROVIDER = 'APPLE';
const GOOGLE_AUTH_PROVIDER = 'GOOGLE';
const FORGOT_PASSWORD_SUCCESS_MESSAGE = 'If an account exists for this email, password reset instructions have been sent.';

function logAppleLoginFailure(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  console.warn(`[apple-login:service] ${message}${suffix}`);
}

function sanitizeUser(user) {
  return mapUserToDto(user);
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function buildSocialNickname(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function buildAppleNickname() {
  return buildSocialNickname('apple');
}

function normalizeNicknameCandidate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().replace(/\s+/g, ' ').slice(0, 30);

  return normalizedValue.length >= 2 ? normalizedValue : null;
}

function buildGoogleNickname({ name, email }) {
  const displayName = normalizeNicknameCandidate(name);

  if (displayName) {
    return displayName;
  }

  if (typeof email === 'string') {
    const localPart = email.split('@')[0]?.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 30);

    if (localPart && localPart.length >= 2) {
      return localPart;
    }
  }

  return buildSocialNickname('google');
}

function buildForgotPasswordResponse() {
  return {
    message: FORGOT_PASSWORD_SUCCESS_MESSAGE
  };
}

function buildPasswordResetExpiresAt() {
  return new Date(Date.now() + env.passwordResetTokenTtlMinutes * 60 * 1000);
}

function generatePasswordResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

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

function isGoogleAuthoritativeEmail({ email, emailVerified, hostedDomain }) {
  if (!emailVerified || typeof email !== 'string') {
    return false;
  }

  if (email.endsWith('@gmail.com')) {
    return true;
  }

  return typeof hostedDomain === 'string' && hostedDomain.length > 0;
}

async function createRefreshTokenRecord(tx, user, deviceName) {
  const tokenPair = tokenService.createTokenPair(user);

  await tx.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: tokenPair.refreshTokenHash,
      deviceName: deviceName ?? null,
      expiresAt: tokenPair.refreshTokenExpiresAt
    }
  });

  return {
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken
  };
}

async function issueSessionForUser(user, deviceName) {
  if (user.status !== UserStatus.ACTIVE) {
    throw buildAccountStatusError(user.status);
  }

  const tokens = await prisma.$transaction((tx) => createRefreshTokenRecord(tx, user, deviceName));

  return {
    user: sanitizeUser(user),
    tokens
  };
}

async function signUp({ email, password, nickname, profileImageUrl, deviceName }) {
  const normalizedEmail = normalizeEmail(email);
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail }
  });

  if (existingUser) {
    throw new AppError(409, 'EMAIL_ALREADY_IN_USE', 'An account with this email already exists');
  }

  const passwordHash = await passwordService.hashPassword(password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        nickname: nickname.trim(),
        profileImageUrl: profileImageUrl ?? null
      }
    });

    const tokens = await createRefreshTokenRecord(tx, user, deviceName);

    return {
      user: sanitizeUser(user),
      tokens
    };
  });

  return result;
}

async function forgotPassword({ email }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      status: true,
      passwordAuthEnabled: true
    }
  });

  if (!user) {
    console.info(`[password-reset:forgot] email=${normalizedEmail} action=ignored reason=account_not_found`);
    return buildForgotPasswordResponse();
  }

  if (user.status !== UserStatus.ACTIVE) {
    console.info(`[password-reset:forgot] userId=${user.id} action=ignored reason=status_${user.status.toLowerCase()}`);
    return buildForgotPasswordResponse();
  }

  if (!user.passwordAuthEnabled) {
    console.info(`[password-reset:forgot] userId=${user.id} action=ignored reason=password_auth_disabled`);
    return buildForgotPasswordResponse();
  }

  const rawToken = generatePasswordResetToken();
  const tokenHash = tokenService.hashToken(rawToken);
  const expiresAt = buildPasswordResetExpiresAt();
  const usedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({
      where: {
        userId: user.id,
        usedAt: null
      },
      data: {
        usedAt
      }
    });

    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt
      }
    });
  });

  try {
    await passwordResetEmailService.sendPasswordResetInstructions({
      email: user.email,
      token: rawToken
    });
  } catch (error) {
    console.error(
      `[password-reset:forgot] userId=${user.id} action=email_failed message=${error?.message ?? 'unknown'}`
    );
  }

  console.info(`[password-reset:forgot] userId=${user.id} action=token_issued expiresAt=${expiresAt.toISOString()}`);

  return buildForgotPasswordResponse();
}

async function resetPassword({ token, newPassword }) {
  const tokenHash = tokenService.hashToken(token);
  const passwordResetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: {
      user: true
    }
  });

  if (!passwordResetToken) {
    throw new AppError(400, 'PASSWORD_RESET_TOKEN_INVALID', 'Password reset token is invalid');
  }

  if (passwordResetToken.usedAt) {
    throw new AppError(400, 'PASSWORD_RESET_TOKEN_USED', 'Password reset token has already been used');
  }

  if (passwordResetToken.expiresAt <= new Date()) {
    throw new AppError(400, 'PASSWORD_RESET_TOKEN_EXPIRED', 'Password reset token has expired');
  }

  if (!passwordResetToken.user.passwordAuthEnabled) {
    throw new AppError(400, 'PASSWORD_RESET_TOKEN_INVALID', 'Password reset token is invalid');
  }

  if (passwordResetToken.user.status !== UserStatus.ACTIVE) {
    throw buildAccountStatusError(passwordResetToken.user.status);
  }

  const passwordHash = await passwordService.hashPassword(newPassword);
  const usedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const claimedToken = await tx.passwordResetToken.updateMany({
      where: {
        id: passwordResetToken.id,
        usedAt: null
      },
      data: {
        usedAt
      }
    });

    if (claimedToken.count !== 1) {
      throw new AppError(400, 'PASSWORD_RESET_TOKEN_USED', 'Password reset token has already been used');
    }

    await tx.user.update({
      where: { id: passwordResetToken.userId },
      data: {
        passwordHash
      }
    });

    await tx.passwordResetToken.updateMany({
      where: {
        userId: passwordResetToken.userId,
        id: {
          not: passwordResetToken.id
        },
        usedAt: null
      },
      data: {
        usedAt
      }
    });

    await tx.refreshToken.deleteMany({
      where: {
        userId: passwordResetToken.userId
      }
    });
  });

  console.info(`[password-reset:reset] userId=${passwordResetToken.userId} action=completed`);

  return {
    passwordReset: true
  };
}

async function appleLogin({ identityToken, deviceName }) {
  let appleIdentity;

  try {
    appleIdentity = await appleAuthService.verifyIdentityToken(identityToken);
  } catch (error) {
    logAppleLoginFailure('Identity token verification failed before user lookup', {
      code: error?.code ?? 'UNKNOWN_ERROR',
      message: error?.message ?? 'unknown'
    });
    throw error;
  }

  const linkedSocialAccount = await prisma.socialAccount.findUnique({
    where: {
      provider_providerSubject: {
        provider: APPLE_AUTH_PROVIDER,
        providerSubject: appleIdentity.subject
      }
    },
    include: {
      user: true
    }
  });

  if (linkedSocialAccount) {
    return issueSessionForUser(linkedSocialAccount.user, deviceName);
  }

  if (!appleIdentity.email) {
    logAppleLoginFailure('Verified Apple token did not include an email for first-time sign in', {
      subject: appleIdentity.subject
    });
    throw new AppError(400, 'APPLE_EMAIL_REQUIRED', 'Apple account email is required for first-time sign in');
  }

  if (!appleIdentity.emailVerified) {
    logAppleLoginFailure('Verified Apple token email is not marked as verified', {
      subject: appleIdentity.subject,
      email: appleIdentity.email
    });
    throw new AppError(401, 'APPLE_EMAIL_NOT_VERIFIED', 'Apple account email is not verified');
  }

  const passwordHash = await passwordService.hashPassword(crypto.randomUUID());

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingLinkedAccount = await tx.socialAccount.findUnique({
        where: {
          provider_providerSubject: {
            provider: APPLE_AUTH_PROVIDER,
            providerSubject: appleIdentity.subject
          }
        },
        include: {
          user: true
        }
      });

      if (existingLinkedAccount) {
        if (existingLinkedAccount.user.status !== UserStatus.ACTIVE) {
          logAppleLoginFailure('Existing Apple-linked user is not active', {
            userId: existingLinkedAccount.user.id,
            status: existingLinkedAccount.user.status
          });
          throw buildAccountStatusError(existingLinkedAccount.user.status);
        }

        const tokens = await createRefreshTokenRecord(tx, existingLinkedAccount.user, deviceName);

        return {
          user: sanitizeUser(existingLinkedAccount.user),
          tokens
        };
      }

      let user = await tx.user.findUnique({
        where: { email: appleIdentity.email }
      });

      if (user && user.status !== UserStatus.ACTIVE) {
        logAppleLoginFailure('Email-matched user for Apple login is not active', {
          userId: user.id,
          status: user.status
        });
        throw buildAccountStatusError(user.status);
      }

      if (!user) {
        user = await tx.user.create({
          data: {
            email: appleIdentity.email,
            passwordHash,
            passwordAuthEnabled: false,
            nickname: buildAppleNickname(),
            profileImageUrl: null
          }
        });
      }

      await tx.socialAccount.create({
        data: {
          userId: user.id,
          provider: APPLE_AUTH_PROVIDER,
          providerSubject: appleIdentity.subject
        }
      });

      const tokens = await createRefreshTokenRecord(tx, user, deviceName);

      return {
        user: sanitizeUser(user),
        tokens
      };
    });

    return result;
  } catch (error) {
    if (error instanceof AppError) {
      logAppleLoginFailure('Apple login aborted with application error', {
        code: error.code,
        message: error.message
      });
      throw error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const concurrentLinkedAccount = await prisma.socialAccount.findUnique({
        where: {
          provider_providerSubject: {
            provider: APPLE_AUTH_PROVIDER,
            providerSubject: appleIdentity.subject
          }
        },
        include: {
          user: true
        }
      });

      if (concurrentLinkedAccount) {
        return issueSessionForUser(concurrentLinkedAccount.user, deviceName);
      }

      logAppleLoginFailure('Apple login hit a social account unique constraint conflict', {
        subject: appleIdentity.subject
      });
      throw new AppError(409, 'SOCIAL_ACCOUNT_CONFLICT', 'This account is already linked to another sign-in method');
    }

    logAppleLoginFailure('Apple login failed with an unexpected error', {
      message: error?.message ?? 'unknown'
    });
    throw error;
  }
}

async function googleLogin({ idToken, deviceName }) {
  const googleIdentity = await googleAuthService.verifyIdToken(idToken);

  const linkedSocialAccount = await prisma.socialAccount.findUnique({
    where: {
      provider_providerSubject: {
        provider: GOOGLE_AUTH_PROVIDER,
        providerSubject: googleIdentity.subject
      }
    },
    include: {
      user: true
    }
  });

  if (linkedSocialAccount) {
    return issueSessionForUser(linkedSocialAccount.user, deviceName);
  }

  if (!googleIdentity.email) {
    throw new AppError(400, 'GOOGLE_EMAIL_REQUIRED', 'Google account email is required for sign in');
  }

  if (!googleIdentity.emailVerified) {
    throw new AppError(401, 'GOOGLE_EMAIL_NOT_VERIFIED', 'Google account email is not verified');
  }

  const passwordHash = await passwordService.hashPassword(crypto.randomUUID());

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingLinkedAccount = await tx.socialAccount.findUnique({
        where: {
          provider_providerSubject: {
            provider: GOOGLE_AUTH_PROVIDER,
            providerSubject: googleIdentity.subject
          }
        },
        include: {
          user: true
        }
      });

      if (existingLinkedAccount) {
        if (existingLinkedAccount.user.status !== UserStatus.ACTIVE) {
          throw buildAccountStatusError(existingLinkedAccount.user.status);
        }

        const tokens = await createRefreshTokenRecord(tx, existingLinkedAccount.user, deviceName);

        return {
          user: sanitizeUser(existingLinkedAccount.user),
          tokens
        };
      }

      let user = await tx.user.findUnique({
        where: { email: googleIdentity.email }
      });

      if (user && user.status !== UserStatus.ACTIVE) {
        throw buildAccountStatusError(user.status);
      }

      if (user && !isGoogleAuthoritativeEmail(googleIdentity)) {
        throw new AppError(409, 'GOOGLE_ACCOUNT_LINK_CONFLICT', 'This Google account cannot be linked automatically to the existing email account');
      }

      if (!user) {
        user = await tx.user.create({
          data: {
            email: googleIdentity.email,
            passwordHash,
            passwordAuthEnabled: false,
            nickname: buildGoogleNickname(googleIdentity),
            profileImageUrl: parseOptionalUrl(googleIdentity.pictureUrl)
          }
        });
      }

      await tx.socialAccount.create({
        data: {
          userId: user.id,
          provider: GOOGLE_AUTH_PROVIDER,
          providerSubject: googleIdentity.subject
        }
      });

      const tokens = await createRefreshTokenRecord(tx, user, deviceName);

      return {
        user: sanitizeUser(user),
        tokens
      };
    });

    return result;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const concurrentLinkedAccount = await prisma.socialAccount.findUnique({
        where: {
          provider_providerSubject: {
            provider: GOOGLE_AUTH_PROVIDER,
            providerSubject: googleIdentity.subject
          }
        },
        include: {
          user: true
        }
      });

      if (concurrentLinkedAccount) {
        return issueSessionForUser(concurrentLinkedAccount.user, deviceName);
      }

      throw new AppError(409, 'SOCIAL_ACCOUNT_CONFLICT', 'This account is already linked to another sign-in method');
    }

    throw error;
  }
}

async function login({ email, password, deviceName }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail }
  });

  if (!user) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw buildAccountStatusError(user.status);
  }

  const passwordMatches = await passwordService.comparePassword(password, user.passwordHash);

  if (!passwordMatches) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  const tokens = await prisma.$transaction((tx) => createRefreshTokenRecord(tx, user, deviceName));

  return {
    user: sanitizeUser(user),
    tokens
  };
}

async function refresh({ refreshToken, deviceName }) {
  let payload;

  try {
    payload = tokenService.verifyRefreshToken(refreshToken);
  } catch (error) {
    throw buildTokenVerificationError(error);
  }

  if (payload.type !== 'refresh' || typeof payload.sub !== 'string') {
    throw new AppError(401, 'UNAUTHORIZED', 'Refresh token is invalid');
  }

  const tokenHash = tokenService.hashToken(refreshToken);
  const existingToken = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true }
  });

  if (!existingToken) {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true }
    });

    if (!user) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'User account could not be found');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw buildAccountStatusError(user.status);
    }

    throw new AppError(401, 'TOKEN_REVOKED', 'Refresh token has been revoked or is no longer valid');
  }

  if (existingToken.userId !== payload.sub) {
    throw new AppError(401, 'UNAUTHORIZED', 'Refresh token is invalid');
  }

  if (existingToken.revokedAt) {
    throw new AppError(401, 'TOKEN_REVOKED', 'Refresh token has already been revoked');
  }

  if (existingToken.expiresAt <= new Date()) {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token has expired');
  }

  if (existingToken.user.status !== UserStatus.ACTIVE) {
    throw buildAccountStatusError(existingToken.user.status);
  }

  const rotatedSession = await prisma.$transaction(async (tx) => {
    await tx.refreshToken.update({
      where: { id: existingToken.id },
      data: { revokedAt: new Date() }
    });

    const tokens = await createRefreshTokenRecord(tx, existingToken.user, deviceName ?? existingToken.deviceName);

    return {
      user: sanitizeUser(existingToken.user),
      tokens
    };
  });

  return rotatedSession;
}

async function logout({ refreshToken }) {
  const tokenHash = tokenService.hashToken(refreshToken);

  await prisma.refreshToken.updateMany({
    where: {
      tokenHash,
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  });

  return {
    loggedOut: true
  };
}

async function getCurrentUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (!user) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'User account could not be found');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw buildAccountStatusError(user.status);
  }

  return sanitizeUser(user);
}

async function deleteCurrentUser(userId) {
  const deletedAt = new Date();

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'User account could not be found');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw buildAccountStatusError(user.status);
    }

    await tx.refreshToken.deleteMany({
      where: { userId: user.id }
    });

    await tx.user.delete({
      where: { id: user.id }
    });

    return {
      deleted: true,
      deletedAt
    };
  });
}

module.exports = {
  appleLogin,
  deleteCurrentUser,
  forgotPassword,
  getCurrentUser,
  googleLogin,
  login,
  logout,
  refresh,
  resetPassword,
  signUp
};
