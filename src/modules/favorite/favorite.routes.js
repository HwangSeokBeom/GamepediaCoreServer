const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const favoriteController = require('./favorite.controller');
const {
  buildFavoriteValidationError,
  createFavoriteSchema,
  favoriteListQuerySchema,
  favoriteParamsSchema
} = require('./favorite.validator');

const router = express.Router();

router.post('/favorites', authenticateAccessToken, validate({
  body: createFavoriteSchema,
  errorMapper: buildFavoriteValidationError
}), favoriteController.addFavorite);

router.delete('/favorites/:gameId', authenticateAccessToken, validate({
  params: favoriteParamsSchema,
  errorMapper: buildFavoriteValidationError
}), favoriteController.removeFavorite);

router.get('/users/me/favorites', authenticateAccessToken, validate({
  query: favoriteListQuerySchema,
  errorMapper: buildFavoriteValidationError
}), favoriteController.getMyFavorites);

router.get('/games/:gameId/favorite-status', authenticateAccessToken, validate({
  params: favoriteParamsSchema,
  errorMapper: buildFavoriteValidationError
}), favoriteController.getFavoriteStatus);

module.exports = router;
