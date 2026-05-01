const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const trimmedTextSchema = z.string().trim();

const aiSearchAssistRequestSchema = z.object({
  query: trimmedTextSchema.min(2).max(200),
  platforms: z.array(trimmedTextSchema.min(1).max(80)).max(10).optional().default([]),
  genres: z.array(trimmedTextSchema.min(1).max(80)).max(10).optional().default([]),
  limit: z.number().int().positive().max(100).optional().default(10)
}).strict();

function flattenAiSearchIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildAiSearchValidationError(error) {
  return new AppError(400, 'VALIDATION_FAILED', 'AI search assist request validation failed', flattenAiSearchIssues(error.issues));
}

module.exports = {
  aiSearchAssistRequestSchema,
  buildAiSearchValidationError
};
