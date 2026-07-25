const { successResponse } = require('../../utils/api-response');
const { asyncHandler } = require('../../utils/async-handler');
const pushService = require('./push.service');
const pushTokenService = require('./push-token.service');

const registerMyPushToken = asyncHandler(async (req, res) => {
  await pushTokenService.registerPushToken({
    userId: req.auth.userId,
    token: req.body.token,
    platform: req.body.platform,
    deviceId: req.body.deviceId,
    appVersion: req.body.appVersion,
    buildNumber: req.body.buildNumber,
    environment: req.body.environment
  });

  res.status(200).json(successResponse({
    registered: true
  }));
});

const deleteMyPushToken = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const result = await pushTokenService.deletePushToken({
    userId: req.auth.userId,
    deviceId: body.deviceId,
    token: body.token
  });

  res.status(200).json(successResponse(result));
});

const sendMyTestPush = asyncHandler(async (req, res) => {
  const result = await pushService.sendTestPushNotification({
    userId: req.auth.userId,
    title: req.body.title,
    body: req.body.body,
    route: req.body.route
  });

  res.status(200).json(successResponse(result));
});

module.exports = {
  deleteMyPushToken,
  registerMyPushToken,
  sendMyTestPush
};
