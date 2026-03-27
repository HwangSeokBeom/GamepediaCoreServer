const { Prisma } = require('@prisma/client');
const multer = require('multer');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');
const { errorResponse } = require('../utils/api-response');
const { AppError } = require('../utils/error-response');

function notFoundHandler(req, res) {
  res.status(404).json(errorResponse('NOT_FOUND', `Route ${req.method} ${req.originalUrl} was not found`));
}

function isAppleLoginRequest(req) {
  return req.method === 'POST' && (req.originalUrl === '/auth/apple' || req.path === '/auth/apple' || req.path === '/apple');
}

function buildRequestMeta(req) {
  return {
    method: req.method,
    path: req.originalUrl,
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
    logger[error.statusCode >= 500 ? 'error' : 'warn']('Request failed', {
      ...buildRequestMeta(req),
      statusCode: error.statusCode,
      code: error.code,
      details: error.details,
      context: isAppleLoginRequest(req) ? 'apple-login' : undefined
    });

    res.status(error.statusCode).json(errorResponse(error.code, error.message, error.details));
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
  notFoundHandler
};
