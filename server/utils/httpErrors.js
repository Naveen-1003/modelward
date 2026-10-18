const env = require("../config/env");

// Use in every route's catch block. Logs the real error server-side and returns
// a generic message to the client; the raw error text is only exposed outside production.
function serverError(res, err, publicMessage = "Something went wrong") {
  console.error(`[error] ${publicMessage}:`, err);
  const body = { error: publicMessage };
  if (!env.isProd && err && err.message) body.details = err.message;
  return res.status(500).json(body);
}

// Small helper for routes that need to bail out with a specific status.
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

module.exports = { serverError, HttpError };
