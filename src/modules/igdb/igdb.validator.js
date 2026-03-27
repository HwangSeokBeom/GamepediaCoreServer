const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const positiveLimitSchema = z.coerce.number().int().min(1).max(30);
const suggestionLimitSchema = z.coerce.number().int().min(1).max(8);
const gameIdSchema = z.coerce.number().int().positive();
const searchKeywordSchema = z.string().trim().min(1).max(100);

const gamesListQuerySchema = z.object({
  limit: positiveLimitSchema.optional()
});

const gameSearchQuerySchema = z.object({
  q: searchKeywordSchema,
  limit: positiveLimitSchema.optional()
});

const gameSuggestionQuerySchema = z.object({
  q: searchKeywordSchema,
  limit: suggestionLimitSchema.optional()
});

const gameDetailParamsSchema = z.object({
  id: gameIdSchema
});

function flattenIgdbIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildIgdbValidationError(error) {
  const details = flattenIgdbIssues(error.issues);
  const issueFields = new Set(error.issues.map((issue) => issue.path[0]));

  if (issueFields.has('q')) {
    return new AppError(400, 'INVALID_SEARCH_QUERY', 'Search query is required and must be between 1 and 100 characters', details);
  }

  if (issueFields.has('id')) {
    return new AppError(400, 'INVALID_GAME_ID', 'Game ID must be a positive integer', details);
  }

  if (issueFields.has('limit')) {
    return new AppError(400, 'INVALID_GAMES_LIMIT', 'Limit must be within the allowed range for this endpoint', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  buildIgdbValidationError,
  gameDetailParamsSchema,
  gameSearchQuerySchema,
  gameSuggestionQuerySchema,
  gamesListQuerySchema
};
