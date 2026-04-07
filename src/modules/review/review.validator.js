const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const reviewSortSchema = z.enum(['latest', 'newest', 'oldest', 'rating_desc', 'rating_asc', 'rating_high', 'rating_low']);
const gameIdSchema = z.string().trim().min(1).max(100);
const ratingSchema = z.number().min(0.5).max(5).multipleOf(0.5);
const contentSchema = z.string().trim().min(10).max(2000);
const commentContentSchema = z.string().trim().min(1).max(1000);
const commentSortSchema = z.enum(['latest', 'newest', 'oldest']);
const myCommentsSortSchema = z.enum(['newest', 'oldest', 'most_liked']);
const commentReactionTypeSchema = z.enum(['like', 'dislike']);
const commentReportReasonSchema = z.string().trim().min(1).max(50);
const cursorSchema = z.string().uuid();
const pageSchema = z.coerce.number().int().min(1).optional();
const limitSchema = z.coerce.number().int().min(1).max(50).optional();
const optionalUuidBodySchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.string().uuid().optional()
);

const createReviewSchema = z.object({
  gameId: gameIdSchema,
  rating: ratingSchema,
  content: contentSchema,
  containsSpoiler: z.boolean().optional()
});

const updateReviewSchema = z.object({
  rating: ratingSchema.optional(),
  content: contentSchema.optional(),
  containsSpoiler: z.boolean().optional()
}).refine((value) => value.rating !== undefined || value.content !== undefined || value.containsSpoiler !== undefined, {
  message: 'At least one review field must be provided',
  path: ['body']
});

const reviewIdParamsSchema = z.object({
  reviewId: z.string().uuid()
});

const reviewCommentIdParamsSchema = z.object({
  commentId: z.string().uuid()
});

const reviewCommentReplyParamsSchema = z.object({
  reviewId: z.string().uuid(),
  commentId: z.string().uuid()
});

const reviewCommentScopedParamsSchema = z.object({
  reviewId: z.string().uuid(),
  commentId: z.string().uuid()
});

const gameReviewsParamsSchema = z.object({
  gameId: gameIdSchema
});

const reviewListQuerySchema = z.object({
  sort: reviewSortSchema.optional()
});

const createReviewCommentSchema = z.object({
  content: commentContentSchema,
  parentCommentId: optionalUuidBodySchema,
  replyToCommentId: optionalUuidBodySchema
}).refine((value) => !value.replyToCommentId || Boolean(value.parentCommentId), {
  message: 'replyToCommentId requires parentCommentId',
  path: ['replyToCommentId']
});

const updateReviewCommentSchema = z.object({
  content: commentContentSchema
});

const reviewCommentReactionSchema = z.object({
  reactionType: commentReactionTypeSchema
});

const reviewCommentReportSchema = z.object({
  reason: commentReportReasonSchema
});

const reviewCommentsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: limitSchema,
  repliesLimit: z.coerce.number().int().min(1).max(10).optional(),
  sort: commentSortSchema.optional()
});

const myReviewCommentsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  sort: myCommentsSortSchema.optional()
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

  if (issueFields.has('reviewId')) {
    return new AppError(400, 'INVALID_REVIEW_ID', 'reviewId must be a valid UUID', details);
  }

  if (issueFields.has('rating')) {
    return new AppError(400, 'INVALID_RATING', 'Rating must be between 0.5 and 5.0 in 0.5 increments', details);
  }

  if (issueFields.has('sort')) {
    return new AppError(400, 'INVALID_REVIEW_SORT', 'sort must be one of newest, oldest, rating_high, or rating_low', details);
  }

  if (issueFields.has('content')) {
    return new AppError(400, 'INVALID_REVIEW_CONTENT', 'Content must be non-whitespace text within the allowed length', details);
  }

  if (issueFields.has('cursor')) {
    return new AppError(400, 'INVALID_COMMENT_CURSOR', 'cursor must be a valid UUID', details);
  }

  if (issueFields.has('reactionType')) {
    return new AppError(400, 'INVALID_COMMENT_REACTION', 'reactionType must be like or dislike', details);
  }

  if (issueFields.has('reason')) {
    return new AppError(400, 'INVALID_COMMENT_REPORT_REASON', 'reason must be between 1 and 50 characters', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

function buildReviewCommentValidationError(error) {
  const issueFields = new Set(error.issues.map((issue) => issue.path[0]));
  const details = flattenReviewIssues(error.issues);

  if (issueFields.has('reviewId')) {
    return new AppError(400, 'INVALID_REVIEW_ID', 'reviewId must be a valid UUID', details);
  }

  if (issueFields.has('commentId')) {
    return new AppError(400, 'INVALID_COMMENT_ID', 'commentId must be a valid UUID', details);
  }

  if (issueFields.has('parentCommentId')) {
    return new AppError(400, 'INVALID_PARENT_COMMENT_ID', 'parentCommentId must be a valid UUID', details);
  }

  if (issueFields.has('replyToCommentId')) {
    return new AppError(400, 'INVALID_REPLY_TO_COMMENT_ID', 'replyToCommentId must be a valid UUID and can only be used with parentCommentId', details);
  }

  if (issueFields.has('content')) {
    return new AppError(400, 'INVALID_COMMENT_CONTENT', 'Comment content must be non-whitespace text within the allowed length', details);
  }

  if (issueFields.has('sort')) {
    return new AppError(400, 'INVALID_COMMENT_SORT', 'sort must be one of newest or oldest', details);
  }

  if (issueFields.has('cursor')) {
    return new AppError(400, 'INVALID_COMMENT_CURSOR', 'cursor must be a valid UUID', details);
  }

  if (issueFields.has('reactionType')) {
    return new AppError(400, 'INVALID_COMMENT_REACTION', 'reactionType must be like or dislike', details);
  }

  if (issueFields.has('reason')) {
    return new AppError(400, 'INVALID_COMMENT_REPORT_REASON', 'reason must be between 1 and 50 characters', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  buildReviewCommentValidationError,
  buildReviewValidationError,
  createReviewSchema,
  createReviewCommentSchema,
  gameReviewsParamsSchema,
  myReviewCommentsQuerySchema,
  reviewCommentIdParamsSchema,
  reviewCommentReactionSchema,
  reviewCommentReportSchema,
  reviewCommentReplyParamsSchema,
  reviewCommentScopedParamsSchema,
  reviewCommentsQuerySchema,
  reviewIdParamsSchema,
  reviewListQuerySchema,
  updateReviewCommentSchema,
  updateReviewSchema
};
