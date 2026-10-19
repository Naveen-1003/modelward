const multer = require("multer");
const env = require("../config/env");

// Unknown /api routes -> JSON, not Express' default HTML page.
function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

// Central error handler: anything that escaped a route's own try/catch.
// Never leaks internals in production.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `File too large (limit ${env.maxUploadMb} MB)` });
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: `Unexpected file field '${err.field}'` });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  // body-parser: malformed JSON / payload too large
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
  if (err.name === "TenantContextError") return res.status(400).json({ error: err.message, code: err.code || "ORG_REQUIRED" });
  if (err.status && err.status >= 400 && err.status < 500 && err.expose !== false) {
    return res.status(err.status).json({ error: err.message || "Bad request" });
  }
  if (err.message === "CORS_NOT_ALLOWED") return res.status(403).json({ error: "Origin not allowed" });

  console.error("[unhandled]", err);
  const body = { error: "Unexpected server error" };
  if (!env.isProd && err.message) body.details = err.message;
  res.status(500).json(body);
}

module.exports = { notFound, errorHandler };
