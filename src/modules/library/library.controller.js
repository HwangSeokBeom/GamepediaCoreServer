const steamService = require('../../services/steam.service');
const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const libraryService = require('./library.service');

function buildRedirectUrl(redirectUri, params) {
  const url = new URL(redirectUri);

  for (const [key, value] of Object.entries(params)) {
    if (value == null) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

const getMyLibrary = asyncHandler(async (req, res) => {
  const result = await libraryService.getMyLibrary({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const startSteamLink = asyncHandler(async (req, res) => {
  const result = await libraryService.startSteamLink({
    userId: req.auth.userId,
    redirectUri: req.body.redirectUri
  });

  res.status(200).json(successResponse(result));
});

const completeSteamLink = async (req, res, next) => {
  let callbackContext = null;

  try {
    callbackContext = steamService.parseSteamLinkState(req.query.state);
  } catch (error) {
    callbackContext = null;
  }

  try {
    const result = await libraryService.completeSteamLink({
      query: req.query,
      callbackContext
    });

    if (result.redirectUri) {
      res.redirect(302, buildRedirectUrl(result.redirectUri, {
        linked: true,
        steamId64: result.steamAccount.steamId64
      }));
      return;
    }

    res.status(200).json(successResponse({
      linked: result.linked,
      steamAccount: result.steamAccount
    }));
  } catch (error) {
    if (callbackContext?.redirectUri) {
      res.redirect(302, buildRedirectUrl(callbackContext.redirectUri, {
        linked: false,
        errorCode: error.code ?? 'STEAM_LINK_FAILED'
      }));
      return;
    }

    next(error);
  }
};

const unlinkSteamAccount = asyncHandler(async (req, res) => {
  const result = await libraryService.unlinkSteamAccount({
    userId: req.auth.userId
  });

  res.status(200).json(successResponse(result));
});

const updateLibraryStatus = asyncHandler(async (req, res) => {
  const result = await libraryService.updateLibraryStatus({
    userId: req.auth.userId,
    ...req.body
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  completeSteamLink,
  getMyLibrary,
  startSteamLink,
  unlinkSteamAccount,
  updateLibraryStatus
};
