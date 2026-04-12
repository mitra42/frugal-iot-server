/**
 * API Error Handling
 * Implements standardized error responses per API.md Section 3.5
 */

/**
 * Standard error codes and their HTTP status codes
 * Organized per API.md Section 3.5
 */
const ERROR_CODES = {
  // 400 Bad Request
  invalid_request: { status: 400, message: 'The request is malformed, missing required fields, or contains invalid values' },

  // 401 Unauthorized
  not_authenticated: { status: 401, message: 'No valid authentication credential was provided' },

  // 403 Forbidden
  not_allowed: { status: 403, message: 'The authenticated platform does not have permission to perform this action' },

  // 404 Not Found
  device_not_found: { status: 404, message: 'The specified device does not exist on this platform' },
  user_not_found: { status: 404, message: 'The specified user does not exist on this platform' },

  // 409 Conflict
  already_exists: { status: 409, message: 'The resource being created already exists' },

  // 422 Unprocessable Entity
  invalid_value: { status: 422, message: 'The request is well-formed but a field value fails validation' },
  field_read_only: { status: 422, message: 'The targeted field exists in the Device Schema but is not writable' },

  // 503 Service Unavailable
  device_unavailable: { status: 503, message: 'The target device is offline or unreachable' },

  // 500 Internal Server Error
  server_error: { status: 500, message: 'An unexpected error occurred on the receiving platform' }
};

/**
 * APIError - Custom error class for API responses
 * @class
 */
class APIError extends Error {
  constructor(errorCode, customMessage = null) {
    const errorDef = ERROR_CODES[errorCode];
    if (!errorDef) {
      throw new Error(`Unknown error code: ${errorCode}`);
    }

    super(customMessage || errorDef.message);
    this.code = errorCode;
    this.status = errorDef.status;
    this.message = customMessage || errorDef.message;
  }

  /**
   * Convert error to API response format
   * @returns {Object} JSON response body
   */
  toJSON() {
    return {
      error: this.code,
      message: this.message
    };
  }
}

/**
 * Express middleware for API error handling
 * Should be added as the last middleware in the app
 * @param {Error} err
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
function apiErrorHandler(err, req, res, next) {
  // If it's an APIError, use the defined status and format
  if (err instanceof APIError) {
    return res.status(err.status).json(err.toJSON());
  }

  // Log unexpected errors
  console.error('Unexpected error:', err);

  // Return generic server error
  const serverError = new APIError('server_error', 'An unexpected error occurred');
  res.status(serverError.status).json(serverError.toJSON());
}

/**
 * Middleware to authenticate platform via token
 * Checks for token in cookies or headers per API.md Section 3.4
 * @param {string} cookieName - Name of the cookie to check
 * @returns {Function} Express middleware
 */
function platformAuthMiddleware(cookieName = 'frugal-iot-token') {
  return (req, res, next) => {
    // Check for token in cookies first
    let token = req.cookies?.[cookieName];

    // Check Authorization header as fallback (Bearer token)
    if (!token && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      throw new APIError('not_authenticated', `Missing authentication token in cookie '${cookieName}' or Authorization header`);
    }

    // Store token in request for later verification
    req.platformToken = token;
    req.cookieName = cookieName;
    next();
  };
}

/**
 * Helper to create successful response per API.md format
 * @param {Object} data - Response data
 * @returns {Object} Formatted response
 */
function createSuccessResponse(data) {
  return {
    status: data.status || 'ok',
    ...data
  };
}

export {
  APIError,
  ERROR_CODES,
  apiErrorHandler,
  platformAuthMiddleware,
  createSuccessResponse
};

