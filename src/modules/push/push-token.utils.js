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
      prefix: null,
      suffix: null,
      length: 0
    };
  }

  return {
    exists: true,
    prefix: token.slice(0, 4),
    suffix: token.slice(-4),
    length: token.length
  };
}

module.exports = {
  maskPushToken,
  normalizeNullableString
};
