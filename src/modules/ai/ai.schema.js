const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const trimmedTextSchema = z.string().trim();

const aiGameRecommendationRequestSchema = z.object({
  query: trimmedTextSchema.min(2).max(300),
  platforms: z.array(trimmedTextSchema.min(1).max(80)).max(10).optional().default([]),
  preferredGenres: z.array(trimmedTextSchema.min(1).max(80)).max(10).optional().default([]),
  excludedGameIds: z.array(z.union([
    z.string().trim().regex(/^\d+$/),
    z.number().int().positive()
  ])).max(200).optional().default([]),
  limit: z.number().int().positive().max(100).optional().default(10)
}).strict();

function flattenAiIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildAiValidationError(error) {
  return new AppError(400, 'VALIDATION_FAILED', 'AI recommendation request validation failed', flattenAiIssues(error.issues));
}

module.exports = {
  aiGameRecommendationRequestSchema,
  buildAiValidationError
};
