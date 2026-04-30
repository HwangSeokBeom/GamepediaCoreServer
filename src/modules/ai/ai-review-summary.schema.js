const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const gameIdParamSchema = z.object({
  gameId: z.string()
    .trim()
    .regex(/^\d+$/)
    .refine((value) => {
      const numericValue = Number(value);
      return Number.isSafeInteger(numericValue) && numericValue > 0;
    }, 'gameId must be a positive safe integer')
});

function flattenAiReviewSummaryIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildAiReviewSummaryValidationError(error) {
  return new AppError(
    400,
    'VALIDATION_FAILED',
    'AI review summary request validation failed',
    flattenAiReviewSummaryIssues(error.issues)
  );
}

module.exports = {
  buildAiReviewSummaryValidationError,
  gameIdParamSchema
};
