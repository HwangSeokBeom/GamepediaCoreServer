const { ZodError } = require('zod');
const { AppError } = require('../utils/error-response');

function flattenZodIssues(issues) {
  return issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
}

function validate({ body, params, query, errorMapper }) {
  return function validateRequest(req, res, next) {
    try {
      if (body) {
        req.body = body.parse(req.body);
      }

      if (params) {
        req.params = params.parse(req.params);
      }

      if (query) {
        req.query = query.parse(req.query);
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        if (typeof errorMapper === 'function') {
          next(errorMapper(error));
          return;
        }

        next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', flattenZodIssues(error.issues)));
        return;
      }

      next(error);
    }
  };
}

module.exports = { validate };
