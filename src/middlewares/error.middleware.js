const { Prisma } = require('@prisma/client');
const multer = require('multer');
const { env } = require('../config/env');
const { errorResponse } = require('../utils/api-response');
const { AppError } = require('../utils/error-response');

function notFoundHandler(req, res) {
  res.status(404).json(errorResponse('NOT_FOUND', `Route ${req.method} ${req.originalUrl} was not found`));
}

function isAppleLoginRequest(req) {
  return req.method === 'POST' && (req.originalUrl === '/auth/apple' || req.path === '/auth/apple' || req.path === '/apple');
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    if (isAppleLoginRequest(req)) {
      console.error(
        `[apple-login:error] status=${error.statusCode} code=${error.code} message=${error.message}`
      );
    }

    res.status(error.statusCode).json(errorResponse(error.code, error.message, error.details));
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      if (isAppleLoginRequest(req)) {
        console.error('[apple-login:error] Prisma unique constraint conflict during Apple login');
      }

      res.status(409).json(errorResponse('CONFLICT', 'A record with the same unique value already exists'));
      return;
    }
  }

  if (error instanceof multer.MulterError) {
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
    if (isAppleLoginRequest(req)) {
      console.error(`[apple-login:error] unexpected=${error?.message ?? 'unknown error'}`);
    }

    console.error(error);
  }

  res.status(500).json(errorResponse('INTERNAL_SERVER_ERROR', 'An unexpected error occurred'));
}

module.exports = {
  errorHandler,
  notFoundHandler
};
