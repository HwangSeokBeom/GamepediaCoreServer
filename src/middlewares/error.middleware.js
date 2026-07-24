const { Prisma } = require('@prisma/client');
const multer = require('multer');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');
const { errorResponse } = require('../utils/api-response');
const { AppError } = require('../utils/error-response');

const DEFAULT_ERROR_MESSAGES = {
  UNAUTHORIZED: '인증이 필요합니다.',
  FORBIDDEN: '접근 권한이 없습니다.',
  NOT_FOUND: '요청한 리소스를 찾을 수 없습니다.',
  VALIDATION_FAILED: '요청 형식이 올바르지 않습니다.',
  INTERNAL_SERVER_ERROR: '서버 오류가 발생했습니다.'
};
const UNSAFE_MESSAGE_PATTERNS = [
  /Route\s+\w+/i,
  /was not found/i,
  /PrismaClientKnownRequestError/i,
  /\bInvalid\b/,
  /\bstack\b/i,
  /Unhandled request error/i,
  /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bWHERE\b/i,
  /\/Users\/|\/var\/|\/app\/|[A-Z]:\\/i,
  /access token|refresh token|authorization/i
];
function sanitizeRequestPath(originalUrl) {
  if (typeof originalUrl !== 'string') {
    return '';
  }

  try {
    const url = new URL(originalUrl, 'http://gamepedia.local');
    return url.pathname;
  } catch (error) {
    return originalUrl.split('?')[0].split('#')[0];
  }
}

function getPublicErrorMessage(code, message) {
  const normalizedMessage = typeof message === 'string' ? message : '';

  if (!normalizedMessage || UNSAFE_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalizedMessage))) {
    return DEFAULT_ERROR_MESSAGES[code] ?? DEFAULT_ERROR_MESSAGES.INTERNAL_SERVER_ERROR;
  }

  return normalizedMessage;
}

function sanitizeErrorDetails(details) {
  if (!details) {
    return details;
  }

  if (Array.isArray(details)) {
    return details.map((detail) => sanitizeErrorDetails(detail));
  }

  if (typeof details !== 'object') {
    return typeof details === 'string'
      ? getPublicErrorMessage('VALIDATION_FAILED', details)
      : details;
  }

  return Object.fromEntries(Object.entries(details).map(([key, value]) => {
    if (key === 'message' && typeof value === 'string') {
      return [key, getPublicErrorMessage('VALIDATION_FAILED', value)];
    }

    return [key, sanitizeErrorDetails(value)];
  }));
}

function notFoundHandler(req, res) {
  logger.warn('Request route not found', {
    ...buildRequestMeta(req),
    statusCode: 404,
    code: 'NOT_FOUND'
  });

  res.status(404).json(errorResponse('NOT_FOUND', DEFAULT_ERROR_MESSAGES.NOT_FOUND));
}

function isAppleLoginRequest(req) {
  return req.method === 'POST' && (req.originalUrl === '/auth/apple' || req.path === '/auth/apple' || req.path === '/apple');
}

function buildRequestMeta(req) {
  return {
    method: req.method,
    path: sanitizeRequestPath(req.originalUrl),
    ip: req.ip,
    remoteAddress: req.socket?.remoteAddress ?? null
  };
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    const appleLoginRequest = isAppleLoginRequest(req);
    logger[error.statusCode >= 500 ? 'error' : 'warn']('Request failed', {
      ...buildRequestMeta(req),
      statusCode: error.statusCode,
      code: error.code,
      details: appleLoginRequest ? undefined : error.details,
      context: appleLoginRequest ? 'apple-login' : undefined
    });

    const sanitizedDetails = sanitizeErrorDetails(error.details);
    const publicExtra = error.code === 'AI_LIBRARY_CURATOR_DAILY_LIMIT_EXCEEDED' &&
      sanitizedDetails &&
      typeof sanitizedDetails === 'object' &&
      !Array.isArray(sanitizedDetails)
      ? sanitizedDetails
      : undefined;

    res.status(error.statusCode).json(errorResponse(
      error.code,
      getPublicErrorMessage(error.code, error.message),
      publicExtra ? undefined : sanitizedDetails,
      publicExtra
    ));
    return;
  }

  if (error instanceof SyntaxError && error.type === 'entity.parse.failed') {
    logger.warn('Request failed due to malformed JSON body', buildRequestMeta(req));
    res.status(400).json(errorResponse('VALIDATION_FAILED', DEFAULT_ERROR_MESSAGES.VALIDATION_FAILED));
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      logger.warn('Request failed due to Prisma unique constraint', {
        ...buildRequestMeta(req),
        code: error.code,
        context: isAppleLoginRequest(req) ? 'apple-login' : undefined
      });

      res.status(409).json(errorResponse('CONFLICT', 'A record with the same unique value already exists'));
      return;
    }
  }

  if (error instanceof multer.MulterError) {
    logger.warn('Request failed due to upload error', {
      ...buildRequestMeta(req),
      code: error.code
    });

    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json(errorResponse('PROFILE_IMAGE_FILE_TOO_LARGE', 'Profile image file is too large'));
      return;
    }

    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json(errorResponse('PROFILE_IMAGE_INVALID_UPLOAD', 'Profile image upload payload is invalid'));
      return;
    }

    res.status(400).json(errorResponse('PROFILE_IMAGE_UPLOAD_FAILED', 'Profile image upload failed'));
    return;
  }

  if (env.nodeEnv !== 'test') {
    logger.error('Unhandled request error', {
      ...buildRequestMeta(req),
      context: isAppleLoginRequest(req) ? 'apple-login' : undefined,
      error
    });
  }

  res.status(500).json(errorResponse('INTERNAL_SERVER_ERROR', 'An unexpected error occurred'));
}

module.exports = {
  errorHandler,
  notFoundHandler,
  sanitizeRequestPath
};
