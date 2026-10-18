const jwt = require("jsonwebtoken");
const User = require("../models/User");
const env = require("../config/env");

// Errors that mean "this token is no good" (=> 401). Anything else -- a database
// outage, a bug -- is NOT the client's fault and must not look like a logout.
const TOKEN_ERRORS = new Set(["JsonWebTokenError", "TokenExpiredError", "NotBeforeError", "CastError"]);

// Verifies the JWT and attaches the full user document to req.user.
// A deactivated or deleted user gets 401 so the client logs out immediately;
// infrastructure failures get 503 so the client keeps its session and retries.
async function authGuard(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing or malformed Authorization header" });

    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: "User no longer exists" });
    if (user.isActive === false) return res.status(401).json({ error: "Account is deactivated" });

    req.user = user;
    next();
  } catch (err) {
    if (err && TOKEN_ERRORS.has(err.name)) return res.status(401).json({ error: "Invalid or expired token" });
    console.error("[auth] authGuard failed unexpectedly:", err && err.message);
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
}

module.exports = authGuard;
