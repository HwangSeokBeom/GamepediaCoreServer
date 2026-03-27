const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const reviewController = require('./review.controller');
const {
  buildReviewValidationError,
  createReviewSchema,
  gameReviewsParamsSchema,
  reviewIdParamsSchema,
  reviewListQuerySchema,
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

router.patch('/reviews/:reviewId', authenticateAccessToken, validate({
  params: reviewIdParamsSchema,
  body: updateReviewSchema,
  errorMapper: buildReviewValidationError
}), reviewController.updateReview);

router.delete('/reviews/:reviewId', authenticateAccessToken, validate({
  params: reviewIdParamsSchema
}), reviewController.deleteReview);

router.get('/users/me/reviews', authenticateAccessToken, validate({
  query: reviewListQuerySchema
}), reviewController.getMyReviews);

module.exports = router;
