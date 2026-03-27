const favoriteService = require('./favorite.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');

const addFavorite = asyncHandler(async (req, res) => {
  const result = await favoriteService.addFavorite({
    userId: req.auth.userId,
    gameId: req.body.gameId
  });

  res.status(200).json(successResponse(result));
});

const removeFavorite = asyncHandler(async (req, res) => {
  const result = await favoriteService.removeFavorite({
    userId: req.auth.userId,
    gameId: req.params.gameId
  });

  res.status(200).json(successResponse(result));
});

const getMyFavorites = asyncHandler(async (req, res) => {
  const result = await favoriteService.getMyFavorites({
    currentUserId: req.auth.userId,
    sort: req.query.sort
  });

  res.status(200).json(successResponse(result));
});

const getFavoriteStatus = asyncHandler(async (req, res) => {
  const result = await favoriteService.getFavoriteStatus({
    userId: req.auth.userId,
    gameId: req.params.gameId
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  addFavorite,
  getFavoriteStatus,
  getMyFavorites,
  removeFavorite
};
