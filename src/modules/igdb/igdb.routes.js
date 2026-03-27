const express = require('express');
const { validate } = require('../../middlewares/validate.middleware');
const igdbController = require('./igdb.controller');
const {
  buildIgdbValidationError,
  gameDetailParamsSchema,
  gameSearchQuerySchema,
  gameSuggestionQuerySchema,
  gamesListQuerySchema
} = require('./igdb.validator');

const router = express.Router();

router.get('/games/highlights', validate({
  query: gamesListQuerySchema,
  errorMapper: buildIgdbValidationError
}), igdbController.getHighlights);

router.get('/games/popular', validate({
  query: gamesListQuerySchema,
  errorMapper: buildIgdbValidationError
}), igdbController.getPopularGames);

router.get('/games/recommended', validate({
  query: gamesListQuerySchema,
  errorMapper: buildIgdbValidationError
}), igdbController.getRecommendedGames);

router.get('/games/search', validate({
  query: gameSearchQuerySchema,
  errorMapper: buildIgdbValidationError
}), igdbController.searchGames);

router.get('/games/suggestions', validate({
  query: gameSuggestionQuerySchema,
  errorMapper: buildIgdbValidationError
}), igdbController.getGameSuggestions);

router.get('/games/:id', validate({
  params: gameDetailParamsSchema,
  errorMapper: buildIgdbValidationError
}), igdbController.getGameDetail);

module.exports = router;
