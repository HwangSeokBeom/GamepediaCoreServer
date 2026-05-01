function successResponse(data) {
  return {
    success: true,
    data
  };
}

function errorResponse(code, message, details, extra = undefined) {
  return {
    success: false,
    error: {
      code,
      message,
      ...(extra && typeof extra === 'object' ? extra : {}),
      ...(details ? { details } : {})
    }
  };
}

module.exports = {
  errorResponse,
  successResponse
};
