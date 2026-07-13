function normalizeNullableString(value, maxLength = 200) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  return trimmedValue.slice(0, maxLength);
}

function maskPushToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return {
      exists: false,
      length: 0
    };
  }

  return {
    exists: true,
    length: token.length
  };
}

function hashPushToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = {
  hashPushToken,
  maskPushToken,
  normalizeNullableString
};
const crypto = require('node:crypto');
