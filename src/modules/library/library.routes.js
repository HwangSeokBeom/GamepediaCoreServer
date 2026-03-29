const express = require('express');
const { authenticateAccessToken } = require('../../middlewares/auth.middleware');
const { validate } = require('../../middlewares/validate.middleware');
const libraryController = require('./library.controller');
const {
  buildLibraryValidationError,
  startSteamLinkSchema,
  steamLinkCallbackQuerySchema,
  updateLibraryStatusSchema
} = require('./library.validator');

const router = express.Router();

router.get('/users/me/library', authenticateAccessToken, libraryController.getMyLibrary);

router.post('/users/me/library/status', authenticateAccessToken, validate({
  body: updateLibraryStatusSchema,
  errorMapper: buildLibraryValidationError
}), libraryController.updateLibraryStatus);

router.post('/users/me/library/steam/link', authenticateAccessToken, validate({
  body: startSteamLinkSchema,
  errorMapper: buildLibraryValidationError
}), libraryController.startSteamLink);

router.delete('/users/me/library/steam/link', authenticateAccessToken, libraryController.unlinkSteamAccount);

router.get('/library/steam/callback', validate({
  query: steamLinkCallbackQuerySchema,
  errorMapper: buildLibraryValidationError
}), libraryController.completeSteamLink);

module.exports = router;
