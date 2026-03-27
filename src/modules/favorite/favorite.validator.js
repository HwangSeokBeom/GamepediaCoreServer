const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const gameIdSchema = z.string().trim().min(1).max(100);
const favoriteSortSchema = z.enum(['latest', 'oldest']);

const createFavoriteSchema = z.object({
  gameId: gameIdSchema
});

const favoriteParamsSchema = z.object({
  gameId: gameIdSchema
});

const favoriteListQuerySchema = z.object({
  sort: favoriteSortSchema.optional()
});

function flattenFavoriteIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildFavoriteValidationError(error) {
  const issueFields = new Set(error.issues.map((issue) => issue.path[0]));
  const details = flattenFavoriteIssues(error.issues);

  if (issueFields.has('gameId')) {
    return new AppError(400, 'INVALID_GAME_ID', 'Game ID is required and must be between 1 and 100 characters', details);
  }

  if (issueFields.has('sort')) {
    return new AppError(400, 'INVALID_FAVORITE_SORT', 'Sort must be either latest or oldest', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  buildFavoriteValidationError,
  createFavoriteSchema,
  favoriteListQuerySchema,
  favoriteParamsSchema
};
