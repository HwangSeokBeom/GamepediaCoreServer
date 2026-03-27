const { z } = require('zod');
const { AppError } = require('../../utils/error-response');

const nicknameSchema = z.string().trim().min(2).max(30);

const updateCurrentUserProfileSchema = z.object({
  nickname: nicknameSchema
});

function buildUserValidationError(error) {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));

  console.warn(`[profile:validation] issues=${JSON.stringify(details)}`);

  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

module.exports = {
  buildUserValidationError,
  updateCurrentUserProfileSchema
};
