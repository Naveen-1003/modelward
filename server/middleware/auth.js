const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Organization = require("../models/Organization");
const env = require("../config/env");
const writeAuditLog = require("./audit");
const { runWithOrg } = require("../utils/tenant");

// Errors that mean "this token is no good" (=> 401). Anything else -- a database
// outage, a bug -- is NOT the client's fault and must not look like a logout.
const TOKEN_ERRORS = new Set(["JsonWebTokenError", "TokenExpiredError", "NotBeforeError", "CastError"]);

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const ORG_ACCESS_WINDOW_MS = 60 * 60 * 1000;

// Super admin -> the last organization they were audited as entering: { orgId, at }.
// In-process on purpose (an extra entry after a restart or on another instance is harmless):
// it keeps a dashboard that polls from filling the audit log with org_access rows.
const lastOrgAccess = new Map();

function resetOrgAccessThrottle() {
  lastOrgAccess.clear();
}

// One org_access audit entry whenever a super admin touches an organization, unless the last
// audited access of this admin was this same organization less than an hour ago.
async function auditOrgAccess(user, org) {
  const key = String(user._id);
  const prev = lastOrgAccess.get(key);
  const now = Date.now();
  if (prev && prev.orgId === String(org._id) && now - prev.at < ORG_ACCESS_WINDOW_MS) return;
  // Claimed before the await so concurrent requests of one admin write a single entry.
  lastOrgAccess.set(key, { orgId: String(org._id), at: now });
  await writeAuditLog({
    actor: user,
    action: "org_access",
    targetType: "Organization",
    targetId: org._id,
    details: `Super admin accessed organization "${org.name}"`,
    orgId: org._id,
  });
}

// Verifies the JWT and attaches req.user (full document), req.org (Organization document) and
// req.orgId (ObjectId, or null for a super admin who has not selected an organization), then
// runs the rest of the chain inside runWithOrg(orgId) so every tenant-scoped query is filtered.
//
// The organization always comes from the user record (never from the token or the body). The one
// exception is a super_admin, who may select any organization with the X-Org-Id header; the id
// is validated against the Organization collection.
//
// A deactivated / not-yet-active / suspended-org user gets 401 so the client logs out at once;
// infrastructure failures get 503 so the client keeps its session and retries.
//   guard(req,res,next)           additionally answers 400 ORG_REQUIRED to a super admin with no org
//   guard.platform(req,res,next)  lets that super admin through (platform routes: /auth/me, /orgs, /audit-log)
function makeGuard({ platform }) {
  return async function authGuard(req, res, next) {
    let orgId = null;
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Missing or malformed Authorization header" });

      const payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
      // The user is not yet known, so the lookup cannot be scoped: explicit, reviewed bypass.
      const user = await User.findById(payload.sub).setOptions({ bypassTenant: true });
      if (!user) return res.status(401).json({ error: "User no longer exists" });
      if (user.isActive === false) return res.status(401).json({ error: "Account is deactivated" });
      if (user.status !== undefined && user.status !== null && user.status !== "active") {
        return res.status(401).json({ error: "Account is not active" });
      }

      let org = null;
      if (user.role === "super_admin") {
        const raw = req.headers["x-org-id"];
        if (raw !== undefined && String(raw).trim() !== "") {
          const id = String(raw).trim();
          org = OBJECT_ID.test(id) ? await Organization.findById(id) : null;
          if (!org) return res.status(400).json({ error: "Unknown organization", code: "ORG_REQUIRED" });
        }
      } else {
        org = user.orgId ? await Organization.findById(user.orgId) : null;
        if (!org || org.status !== "active") return res.status(401).json({ error: "Organization is suspended" });
      }

      if (!org && !platform) {
        return res.status(400).json({ error: "Select an organization first", code: "ORG_REQUIRED" });
      }
      if (org && user.role === "super_admin") await auditOrgAccess(user, org);

      req.user = user;
      req.org = org;
      req.orgId = org ? org._id : null;
      orgId = req.orgId;
    } catch (err) {
      if (err && TOKEN_ERRORS.has(err.name)) return res.status(401).json({ error: "Invalid or expired token" });
      console.error("[auth] authGuard failed unexpectedly:", err && err.message);
      return res.status(503).json({ error: "Service temporarily unavailable" });
    }
    return runWithOrg(orgId, next);
  };
}

const authGuard = makeGuard({ platform: false });
authGuard.platform = makeGuard({ platform: true });
authGuard.resetOrgAccessThrottle = resetOrgAccessThrottle;
authGuard.lastOrgAccess = lastOrgAccess; // exposed for tests (age an entry instead of waiting an hour)

module.exports = authGuard;
