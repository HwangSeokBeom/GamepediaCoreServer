const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const reviewController = require('./review.controller');
const {
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
} = require('./review.validator');

const router = express.Router();

router.post('/reviews', authenticateAccessToken, validate({
  body: createReviewSchema,
  errorMapper: buildReviewValidationError
}), reviewController.createReview);

router.get('/games/:gameId/reviews', authenticateAccessToken, validate({
  params: gameReviewsParamsSchema,
  query: reviewListQuerySchema
}), reviewController.getGameReviews);

router.get('/games/:gameId/reviews/preview', authenticateAccessToken, validate({
  params: gameReviewsParamsSchema,
  query: reviewListQuerySchema
}), reviewController.getGameReviewPreview);

router.get('/games/:gameId/reviews/my', authenticateAccessToken, validate({
  params: gameReviewsParamsSchema,
  query: reviewListQuerySchema
}), reviewController.getMyGameReviews);

router.get('/games/:gameId/reviews/my/preview', authenticateAccessToken, validate({
  params: gameReviewsParamsSchema,
  query: reviewListQuerySchema
}), reviewController.getMyGameReviewPreview);

router.get('/reviews/:reviewId', authenticateAccessToken, validate({
  params: reviewIdParamsSchema,
  query: reviewCommentsQuerySchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.getReviewDetail);

router.post('/reviews/:reviewId/like', authenticateAccessToken, validate({
  params: reviewIdParamsSchema,
  errorMapper: buildReviewValidationError
}), reviewController.likeReview);

router.delete('/reviews/:reviewId/like', authenticateAccessToken, validate({
  params: reviewIdParamsSchema,
  errorMapper: buildReviewValidationError
}), reviewController.removeReviewLike);

router.get('/reviews/:reviewId/comments', authenticateAccessToken, validate({
  params: reviewIdParamsSchema,
  query: reviewCommentsQuerySchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.getReviewComments);

router.post('/reviews/:reviewId/comments', authenticateAccessToken, validate({
  params: reviewIdParamsSchema,
  body: createReviewCommentSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.createReviewComment);

router.get('/reviews/:reviewId/comments/:commentId/replies', authenticateAccessToken, validate({
  params: reviewCommentReplyParamsSchema,
  query: reviewCommentsQuerySchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.getReviewCommentReplies);

router.post('/reviews/:reviewId/comments/:commentId/replies', authenticateAccessToken, validate({
  params: reviewCommentReplyParamsSchema,
  body: createReviewCommentSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.createReviewCommentReply);

router.patch('/reviews/:reviewId/comments/:commentId', authenticateAccessToken, validate({
  params: reviewCommentScopedParamsSchema,
  body: updateReviewCommentSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.updateReviewComment);

router.delete('/reviews/:reviewId/comments/:commentId', authenticateAccessToken, validate({
  params: reviewCommentScopedParamsSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.deleteReviewComment);

router.post('/reviews/:reviewId/comments/:commentId/reactions', authenticateAccessToken, validate({
  params: reviewCommentScopedParamsSchema,
  body: reviewCommentReactionSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.reactToReviewComment);

router.delete('/reviews/:reviewId/comments/:commentId/reactions', authenticateAccessToken, validate({
  params: reviewCommentScopedParamsSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.removeReviewCommentReaction);

router.post('/reviews/:reviewId/comments/:commentId/report', authenticateAccessToken, validate({
  params: reviewCommentScopedParamsSchema,
  body: reviewCommentReportSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.reportReviewComment);

router.patch('/reviews/:reviewId', authenticateAccessToken, validate({
  params: reviewIdParamsSchema,
  body: updateReviewSchema,
  errorMapper: buildReviewValidationError
}), reviewController.updateReview);

router.delete('/reviews/:reviewId', authenticateAccessToken, validate({
  params: reviewIdParamsSchema
}), reviewController.deleteReview);

router.patch('/review-comments/:commentId', authenticateAccessToken, validate({
  params: reviewCommentIdParamsSchema,
  body: updateReviewCommentSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.updateReviewComment);

router.delete('/review-comments/:commentId', authenticateAccessToken, validate({
  params: reviewCommentIdParamsSchema
}), reviewController.deleteReviewComment);

router.put('/review-comments/:commentId/reaction', authenticateAccessToken, validate({
  params: reviewCommentIdParamsSchema,
  body: reviewCommentReactionSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.reactToReviewComment);

router.post('/review-comments/:commentId/like', authenticateAccessToken, validate({
  params: reviewCommentIdParamsSchema
}), reviewController.likeReviewComment);

router.delete('/review-comments/:commentId/reaction', authenticateAccessToken, validate({
  params: reviewCommentIdParamsSchema
}), reviewController.removeReviewCommentReaction);

router.delete('/review-comments/:commentId/like', authenticateAccessToken, validate({
  params: reviewCommentIdParamsSchema
}), reviewController.removeReviewCommentReaction);

router.post('/review-comments/:commentId/report', authenticateAccessToken, validate({
  params: reviewCommentIdParamsSchema,
  body: reviewCommentReportSchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.reportReviewComment);

router.get('/users/me/reviews', authenticateAccessToken, validate({
  query: reviewListQuerySchema
}), reviewController.getMyReviews);

router.get('/users/me/review-comments', authenticateAccessToken, validate({
  query: myReviewCommentsQuerySchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.getMyReviewComments);

router.get('/users/me/comments', authenticateAccessToken, validate({
  query: myReviewCommentsQuerySchema,
  errorMapper: buildReviewCommentValidationError
}), reviewController.getMyReviewComments);

router.get('/users/me/reviews/steam-linked', authenticateAccessToken,
  reviewController.getSteamLinkedReviews);

module.exports = router;
