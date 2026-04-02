const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const libraryGameSourceSchema = z.enum(['steam', 'igdb']);
const libraryStatusSchema = z.enum(['playing', 'completed', 'dropped']);
const externalGameIdSchema = z.string().trim().min(1).max(100);
const titleSchema = z.string().trim().min(1).max(200);
const nullableDateSchema = z.union([z.coerce.date(), z.null()]);

const startSteamLinkSchema = z.object({
  redirectUri: z.string().trim().url().max(2048).optional()
}).default({});

const steamLinkCallbackQuerySchema = z.object({
  state: z.string().trim().min(1)
}).passthrough();

const resolveLibraryImageQuerySchema = z.object({
  gameSource: libraryGameSourceSchema,
  externalGameId: z.string().trim().min(1).max(100).optional(),
  igdbCoverUrl: z.string().trim().url().max(2048).optional()
});

const updateLibraryStatusSchema = z.object({
  source: libraryGameSourceSchema,
  externalGameId: externalGameIdSchema,
  title: titleSchema,
  coverUrl: z.string().trim().url().nullable().optional(),
  status: libraryStatusSchema,
  startedAt: nullableDateSchema.optional(),
  completedAt: nullableDateSchema.optional(),
  lastPlayedAt: nullableDateSchema.optional(),
  playtimeMinutes: z.number().int().min(0).nullable().optional()
});

function flattenLibraryIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildLibraryValidationError(error) {
  const issueFields = new Set(error.issues.map((issue) => issue.path[0]));
  const details = flattenLibraryIssues(error.issues);

  if (issueFields.has('source')) {
    return new AppError(400, 'INVALID_LIBRARY_SOURCE', 'source must be either steam or igdb', details);
  }

  if (issueFields.has('status')) {
    return new AppError(400, 'INVALID_LIBRARY_STATUS', 'status must be one of playing, completed, or dropped', details);
  }

  if (issueFields.has('externalGameId')) {
    return new AppError(400, 'INVALID_EXTERNAL_GAME_ID', 'externalGameId is required and must be between 1 and 100 characters', details);
  }

  if (issueFields.has('title')) {
    return new AppError(400, 'INVALID_GAME_TITLE', 'title is required and must be between 1 and 200 characters', details);
  }

  if (issueFields.has('coverUrl')) {
    return new AppError(400, 'INVALID_COVER_URL', 'coverUrl must be a valid URL when provided', details);
  }

  if (issueFields.has('redirectUri')) {
    return new AppError(400, 'INVALID_REDIRECT_URI', 'redirectUri must be a valid absolute URL', details);
  }

  if (issueFields.has('state')) {
    return new AppError(400, 'STEAM_LINK_STATE_REQUIRED', 'state is required', details);
  }

  if (issueFields.has('startedAt') || issueFields.has('completedAt') || issueFields.has('lastPlayedAt')) {
    return new AppError(400, 'INVALID_LIBRARY_DATE', 'Library date fields must be valid ISO-8601 timestamps when provided', details);
  }

  if (issueFields.has('playtimeMinutes')) {
    return new AppError(400, 'INVALID_PLAYTIME_MINUTES', 'playtimeMinutes must be a non-negative integer', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  buildLibraryValidationError,
  resolveLibraryImageQuerySchema,
  startSteamLinkSchema,
  steamLinkCallbackQuerySchema,
  updateLibraryStatusSchema
};
