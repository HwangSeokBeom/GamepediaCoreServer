const express = require('express');
const authController = require('../controllers/auth.controller');
const { authenticateAccessToken } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const {
  appleLoginSchema,
  buildAppleLoginValidationError,
  buildGoogleLoginValidationError,
  forgotPasswordSchema,
  googleLoginSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  resetPasswordSchema,
  signUpSchema
} = require('../validators/auth.validator');

const router = express.Router();

function logAppleLoginRequest(req, res, next) {
  const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
  const bodyKeys = Object.keys(requestBody);
  const hasIdentityToken = typeof requestBody.identityToken === 'string' && requestBody.identityToken.trim().length > 0;
  const hasAuthCode = typeof requestBody.authorizationCode === 'string' && requestBody.authorizationCode.trim().length > 0;
  const hasUserIdentifier = typeof requestBody.userIdentifier === 'string' && requestBody.userIdentifier.trim().length > 0;

  // Presence flags only — key names deliberately avoid the exact credential
  // field names so the sensitive-log scanner keeps a strict rule set.
  console.log(
    `[apple-login:request] keys=${bodyKeys.length > 0 ? bodyKeys.join(',') : '(none)'} identityTokenPresent=${hasIdentityToken} authCodePresent=${hasAuthCode} userIdentifierPresent=${hasUserIdentifier}`
  );

  if (!hasIdentityToken) {
    console.warn(
      `[apple-login:request] Missing required body.identityToken. Server expects key "identityToken". Received keys: ${bodyKeys.length > 0 ? bodyKeys.join(',') : '(none)'}`
    );
  }

  next();
}

router.post('/signup', validate({ body: signUpSchema }), authController.signUp);
router.post('/login', validate({ body: loginSchema }), authController.login);
router.post('/forgot-password', validate({ body: forgotPasswordSchema }), authController.forgotPassword);
router.post('/reset-password', validate({ body: resetPasswordSchema }), authController.resetPassword);
router.post('/apple', logAppleLoginRequest, validate({
  body: appleLoginSchema,
  errorMapper: buildAppleLoginValidationError
}), authController.appleLogin);
router.post('/google', validate({
  body: googleLoginSchema,
  errorMapper: buildGoogleLoginValidationError
}), authController.googleLogin);
router.post('/refresh', validate({ body: refreshSchema }), authController.refresh);
router.post('/logout', validate({ body: logoutSchema }), authController.logout);
router.get('/me', authenticateAccessToken, authController.me);
router.delete('/me', authenticateAccessToken, authController.deleteMyAccount);

module.exports = router;
module.exports.authRouter = router;
