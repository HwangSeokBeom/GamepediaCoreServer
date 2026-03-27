const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const reviewSortSchema = z.enum(['latest', 'oldest', 'rating_desc', 'rating_asc']);
const gameIdSchema = z.string().trim().min(1).max(100);
const ratingSchema = z.number().min(0.5).max(5).multipleOf(0.5);
const contentSchema = z.string().trim().min(10).max(2000);

const createReviewSchema = z.object({
  gameId: gameIdSchema,
  rating: ratingSchema,
  content: contentSchema
});

const updateReviewSchema = z.object({
  rating: ratingSchema.optional(),
  content: contentSchema.optional()
}).refine((value) => value.rating !== undefined || value.content !== undefined, {
  message: 'At least one review field must be provided',
  path: ['body']
});

const reviewIdParamsSchema = z.object({
  reviewId: z.string().uuid()
});

const gameReviewsParamsSchema = z.object({
  gameId: gameIdSchema
});

const reviewListQuerySchema = z.object({
  sort: reviewSortSchema.optional()
});

function flattenReviewIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function buildReviewValidationError(error) {
  const issueFields = new Set(error.issues.map((issue) => issue.path[0]));
  const details = flattenReviewIssues(error.issues);

  if (issueFields.has('rating')) {
    return new AppError(400, 'INVALID_RATING', 'Rating must be between 0.5 and 5.0 in 0.5 increments', details);
  }

  if (issueFields.has('content')) {
    return new AppError(400, 'INVALID_REVIEW_CONTENT', 'Review content must be between 10 and 2000 non-whitespace characters', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  buildReviewValidationError,
  createReviewSchema,
  gameReviewsParamsSchema,
  reviewIdParamsSchema,
  reviewListQuerySchema,
  updateReviewSchema
};
