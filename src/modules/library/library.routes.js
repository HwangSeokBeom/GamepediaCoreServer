const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const libraryController = require('./library.controller');
const {
  buildLibraryValidationError,
  resolveLibraryImageQuerySchema,
  startSteamLinkSchema,
  updateLibraryStatusSchema
} = require('./library.validator');

const router = express.Router();

router.get('/users/me/library', authenticateAccessToken, libraryController.getMyLibrary);
router.get('/users/me/library/owned', authenticateAccessToken, libraryController.getMyOwnedLibrary);
router.get('/users/me/library/playing', authenticateAccessToken, libraryController.getMyPlayingLibrary);
router.get('/users/me/library/recently-played', authenticateAccessToken, libraryController.getMyRecentlyPlayedLibrary);
router.get('/users/me/library/liked', authenticateAccessToken, libraryController.getMyLikedLibrary);
router.get('/users/me/library/reviews', authenticateAccessToken, libraryController.getMyReviewedLibrary);
router.get('/users/me/library/recommendations/friends', authenticateAccessToken, libraryController.getMySteamFriendRecommendations);
router.get('/users/me/library/recommendations/playtime-based', authenticateAccessToken, libraryController.getMyPlaytimeBasedRecommendations);
router.get('/users/me/recommendations/playtime-based', authenticateAccessToken, libraryController.getMyPlaytimeBasedRecommendations);
router.get('/users/me/recommendations/steam-friends', authenticateAccessToken, libraryController.getMySteamFriendRecommendations);

router.get('/library/images/resolve', validate({
  query: resolveLibraryImageQuerySchema,
  errorMapper: buildLibraryValidationError
}), libraryController.resolveGameImage);

router.post('/users/me/library/status', authenticateAccessToken, validate({
  body: updateLibraryStatusSchema,
  errorMapper: buildLibraryValidationError
}), libraryController.updateLibraryStatus);

router.post('/users/me/library/steam/link', authenticateAccessToken, validate({
  body: startSteamLinkSchema,
  errorMapper: buildLibraryValidationError
}), libraryController.startSteamLink);

router.post('/users/me/library/steam/sync-owned', authenticateAccessToken, libraryController.syncOwnedSteamGames);

router.delete('/users/me/library/steam/link', authenticateAccessToken, libraryController.unlinkSteamAccount);

router.get('/library/steam/callback', libraryController.completeSteamLink);

module.exports = router;
