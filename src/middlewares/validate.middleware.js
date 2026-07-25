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
        const parsedQuery = query.parse(req.query);

        // Express exposes req.query through a getter in current releases.
        // Define the validated value on this request so transforms cannot be
        // silently discarded by an assignment to the getter-only property.
        Object.defineProperty(req, 'query', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: parsedQuery
        });
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
