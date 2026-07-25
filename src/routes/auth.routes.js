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
const { logSafely } = require('../utils/logger');

function logAppleLoginRequest(req, res, next) {
  const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
  const hasIdentityToken = typeof requestBody.identityToken === 'string' && requestBody.identityToken.trim().length > 0;
  const hasAuthCode = typeof requestBody.authorizationCode === 'string' && requestBody.authorizationCode.trim().length > 0;
  const hasUserIdentifier = typeof requestBody.userIdentifier === 'string' && requestBody.userIdentifier.trim().length > 0;

  logSafely('info', 'apple-login-request', {
    credentialPresent: hasIdentityToken,
    exchangeCredentialPresent: hasAuthCode,
    accountHintPresent: hasUserIdentifier
  });

  if (!hasIdentityToken) {
    logSafely('warn', 'apple-login-request-missing-credential');
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
