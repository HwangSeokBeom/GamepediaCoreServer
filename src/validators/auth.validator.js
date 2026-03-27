const { z } = require('zod');
const { AppError } = require('../utils/error-response');

const emailSchema = z.string().trim().email().max(320);
const passwordSchema = z.string().min(8).max(72);
const nicknameSchema = z.string().trim().min(2).max(30);
const deviceNameSchema = z.string().trim().min(1).max(100);
const appleIdentityTokenSchema = z.string().trim().min(1);
const googleIdTokenSchema = z.string().trim().min(1);
const passwordResetTokenSchema = z.string().trim().min(1);

const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  nickname: nicknameSchema,
  profileImageUrl: z.string().trim().url().nullable().optional(),
  deviceName: deviceNameSchema.optional()
});

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  deviceName: deviceNameSchema.optional()
});

const forgotPasswordSchema = z.object({
  email: emailSchema
});

const resetPasswordSchema = z.object({
  token: passwordResetTokenSchema,
  newPassword: passwordSchema
});

const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1),
  deviceName: deviceNameSchema.optional()
});

const logoutSchema = z.object({
  refreshToken: z.string().trim().min(1)
});

const appleLoginSchema = z.object({
  identityToken: appleIdentityTokenSchema,
  deviceName: deviceNameSchema.optional()
});

const googleLoginSchema = z.object({
  idToken: googleIdTokenSchema,
  deviceName: deviceNameSchema.optional()
});

function buildAppleLoginValidationError(error) {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));

  console.warn(`[apple-login:validation] issues=${JSON.stringify(details)}`);

  if (error.issues.some((issue) => issue.path[0] === 'identityToken')) {
    console.warn('[apple-login:validation] Validation failed because body.identityToken is missing or empty. Server expects key "identityToken".');
    return new AppError(400, 'APPLE_IDENTITY_TOKEN_REQUIRED', 'Apple identity token is required', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

function buildGoogleLoginValidationError(error) {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));

  if (error.issues.some((issue) => issue.path[0] === 'idToken')) {
    return new AppError(400, 'GOOGLE_ID_TOKEN_REQUIRED', 'Google ID token is required', details);
  }

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
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
};
