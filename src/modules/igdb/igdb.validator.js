const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const positiveLimitSchema = z.coerce.number().int().min(1).max(30);
const suggestionLimitSchema = z.coerce.number().int().min(1).max(8);
const gameIdSchema = z.coerce.number().int().positive();
const searchKeywordSchema = z.string().trim().min(1).max(100);
const libraryGameSourceSchema = z.enum(['steam', 'igdb']);
const externalGameIdSchema = z.string().trim().min(1).max(100);
const igdbGameIdSchema = z.string().trim().regex(/^\d+$/).max(100);
const homePlatformSchema = z.enum(['steam', 'playstation', 'nintendo', 'xbox', 'mobile']);
const homeCategorySchema = z.enum(['action', 'rpg', 'strategy', 'simulation', 'sports', 'adventure', 'indie', 'horror', 'puzzle']);
const homeGameModeSchema = z.enum(['singleplayer', 'multiplayer', 'coop', 'pvp']);

const gamesListQuerySchema = z.object({
  limit: positiveLimitSchema.optional(),
  platform: homePlatformSchema.optional(),
  category: homeCategorySchema.optional(),
  gameMode: homeGameModeSchema.optional()
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

const unifiedGameDetailQuerySchema = z.object({
  gameSource: libraryGameSourceSchema,
  externalGameId: externalGameIdSchema.optional(),
  igdbGameId: igdbGameIdSchema.optional()
}).superRefine((value, ctx) => {
  if (!value.externalGameId && !value.igdbGameId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['externalGameId'],
      message: 'externalGameId or igdbGameId is required'
    });
  }
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

  if (issueFields.has('gameSource')) {
    return new AppError(400, 'INVALID_GAME_SOURCE', 'gameSource must be either steam or igdb', details);
  }

  if (issueFields.has('externalGameId')) {
    return new AppError(400, 'INVALID_EXTERNAL_GAME_ID', 'externalGameId is required and must be between 1 and 100 characters', details);
  }

  if (issueFields.has('igdbGameId')) {
    return new AppError(400, 'INVALID_IGDB_GAME_ID', 'igdbGameId must be a numeric string when provided', details);
  }

  if (issueFields.has('limit')) {
    return new AppError(400, 'INVALID_GAMES_LIMIT', 'Limit must be within the allowed range for this endpoint', details);
  }

  if (issueFields.has('platform')) {
    return new AppError(400, 'INVALID_PLATFORM_FILTER', 'platform must be one of steam, playstation, nintendo, xbox, mobile', details);
  }

  if (issueFields.has('category')) {
    return new AppError(400, 'INVALID_CATEGORY_FILTER', 'category must be one of action, rpg, strategy, simulation, sports, adventure, indie, horror, puzzle', details);
  }

  if (issueFields.has('gameMode')) {
    return new AppError(400, 'INVALID_GAME_MODE_FILTER', 'gameMode must be one of singleplayer, multiplayer, coop, pvp', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  buildIgdbValidationError,
  gameDetailParamsSchema,
  gameSearchQuerySchema,
  gameSuggestionQuerySchema,
  gamesListQuerySchema,
  unifiedGameDetailQuerySchema
};
