function successResponse(data) {
  return {
    success: true,
    data
  };
}

function errorResponse(code, message, details) {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  };
}

module.exports = {
  errorResponse,
  successResponse
};
