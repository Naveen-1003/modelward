// Express app WITHOUT listening or connecting to Mongo, so tests (supertest) can
// import it. server.js is the process entry point.
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");
const env = require("./config/env");
const mongoose = require("mongoose");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { apiLimiter } = require("./middleware/rateLimit");

const app = express();

app.disable("x-powered-by");
if (env.trustProxy !== false) app.set("trust proxy", env.trustProxy);

app.use(helmet());
if (env.nodeEnv !== "test") app.use(morgan(env.isProd ? "combined" : "dev"));

// CORS: explicit allow-list. In dev with no list, any localhost origin is accepted.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl, server-to-server, same-origin
      // Compare in canonical form (scheme/host case, trailing slash, default port).
      const normalized = env.normalizeOrigin(origin);
      if (normalized && env.clientOrigins.includes(normalized)) return cb(null, true);
      if (!env.isProd && env.clientOrigins.length === 0 && LOCAL_ORIGIN.test(origin)) return cb(null, true);
      return cb(new Error("CORS_NOT_ALLOWED"));
    },
  })
);

app.use(express.json({ limit: "100kb" }));
app.use(mongoSanitize()); // strips $-prefixed / dotted keys from body, query, params

// Liveness + readiness. Render's health check should hit this.
app.get("/health", (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ ok: dbUp, service: "modelward-server", db: dbUp ? "up" : "down" });
});

// API responses carry per-user data and tokens: never let a browser or proxy cache them.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use("/api", apiLimiter);

app.use("/api/config", require("./routes/config"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/orgs", require("./routes/orgs"));
app.use("/api/users", require("./routes/users"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/models", require("./routes/models"));
app.use("/api/trash", require("./routes/trash"));
app.use("/api/stats", require("./routes/stats"));
app.use("/api/audit-log", require("./routes/audit"));
// versions.js and comments.js define full paths (/models/:modelId/versions, /versions/:id/...)
app.use("/api", require("./routes/versions"));
app.use("/api", require("./routes/comments"));

app.use("/api", notFound);
app.use(errorHandler);

module.exports = app;
