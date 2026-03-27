const reviewService = require('./review.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');

const createReview = asyncHandler(async (req, res) => {
  const result = await reviewService.createReview({
    userId: req.auth.userId,
    ...req.body
  });

  res.status(201).json(successResponse(result));
});

const getGameReviews = asyncHandler(async (req, res) => {
  const result = await reviewService.getGameReviews({
    currentUserId: req.auth.userId,
    gameId: req.params.gameId,
    sort: req.query.sort
  });

  res.status(200).json(successResponse(result));
});

const updateReview = asyncHandler(async (req, res) => {
  const result = await reviewService.updateReview({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId,
    ...req.body
  });

  res.status(200).json(successResponse(result));
});

const deleteReview = asyncHandler(async (req, res) => {
  const result = await reviewService.deleteReview({
    currentUserId: req.auth.userId,
    reviewId: req.params.reviewId
  });

  res.status(200).json(successResponse(result));
});

const getMyReviews = asyncHandler(async (req, res) => {
  const result = await reviewService.getMyReviews({
    currentUserId: req.auth.userId,
    sort: req.query.sort
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  createReview,
  deleteReview,
  getGameReviews,
  getMyReviews,
  updateReview
};
