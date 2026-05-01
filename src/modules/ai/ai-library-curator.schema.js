const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const SUPPORTED_LIBRARY_CURATOR_MODES = [
  'overview',
  'today',
  'rediscover',
  'short_session',
  'review_insight'
];
const SUPPORTED_LIBRARY_CURATOR_LOCALES = ['ko', 'en', 'ja', 'zh-Hans'];
const SUPPORTED_LIBRARY_CURATOR_SCOPES = ['owned', 'favorites', 'reviewed', 'mixed'];

function normalizeLocale(value) {
  return SUPPORTED_LIBRARY_CURATOR_LOCALES.includes(value) ? value : 'ko';
}

function normalizeExcludedGameIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .map((gameId) => (typeof gameId === 'string' ? gameId.trim() : String(gameId ?? '').trim()))
    .filter(Boolean))]
    .slice(0, 200);
}

const libraryCuratorRequestSchema = z.object({
  query: z.string().trim().max(300).optional(),
  mode: z.enum(SUPPORTED_LIBRARY_CURATOR_MODES).optional().default('overview'),
  limit: z.number().int().min(1).max(10).optional().default(5),
  locale: z.preprocess((value) => normalizeLocale(value), z.enum(SUPPORTED_LIBRARY_CURATOR_LOCALES)).optional().default('ko'),
  candidateScope: z.enum(SUPPORTED_LIBRARY_CURATOR_SCOPES).optional().default('mixed'),
  excludedGameIds: z.preprocess(normalizeExcludedGameIds, z.array(z.string()).max(200)).optional().default([])
}).strict();

function flattenLibraryCuratorIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildLibraryCuratorValidationError(error) {
  return new AppError(
    400,
    'VALIDATION_FAILED',
    'AI library curator request validation failed',
    flattenLibraryCuratorIssues(error.issues)
  );
}

module.exports = {
  SUPPORTED_LIBRARY_CURATOR_LOCALES,
  SUPPORTED_LIBRARY_CURATOR_MODES,
  SUPPORTED_LIBRARY_CURATOR_SCOPES,
  buildLibraryCuratorValidationError,
  libraryCuratorRequestSchema,
  normalizeExcludedGameIds,
  normalizeLocale
};
