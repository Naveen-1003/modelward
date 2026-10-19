// Platform owner (role super_admin, no organization). Never created by signup: it comes from
// the environment (SUPER_ADMIN_EMAIL [+ SUPER_ADMIN_PASSWORD, SUPER_ADMIN_NAME]) at startup
// (migrations/index.js) or from `npm run seed:superadmin`.
//
//   - an existing account with that email (matched by emailKey, so "+tag" variants count) is
//     promoted: role super_admin, orgId null, status active, isActive true;
//   - otherwise it is created when a password is configured (and meets the signup policy);
//   - otherwise a warning is logged and nothing happens;
//   - it NEVER demotes anyone and is idempotent (a second call changes nothing).
//
// Works through the raw collection (legacy rows still lack emailKey/status when this runs, before
// the backfills) and runSystem for the single create.
const bcrypt = require("bcryptjs");
const env = require("../config/env");
const User = require("../models/User");
const writeAuditLog = require("../middleware/audit");
const { runSystem } = require("./tenant");
const { normalizeEmail } = require("./identity");
const { releaseSeat } = require("./joinCodes");

const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything after 72 bytes

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  if (process.env.NODE_ENV !== "test") console.warn(`[super-admin] ${message}`);
}

function passwordProblem(password) {
  if (typeof password !== "string" || password === "") return "no password configured";
  if (password.length < env.minPasswordLength) return `password is shorter than ${env.minPasswordLength} characters`;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return `password is longer than ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

// Exact address first, then by emailKey, then (legacy rows have no emailKey yet) by normalizing
// the addresses of the not-yet-keyed users.
async function findByEmail(email) {
  const users = User.collection;
  const key = normalizeEmail(email);
  const found = (await users.findOne({ email })) || (await users.findOne({ emailKey: key }));
  if (found) return found;
  for await (const u of users.find({ emailKey: { $exists: false } }, { projection: { email: 1 } })) {
    if (normalizeEmail(u.email) === key) return users.findOne({ _id: u._id });
  }
  return null;
}

async function audit(action, user, details) {
  // Platform-level entry (orgId null). Never throws.
  await writeAuditLog({
    actor: { name: "system", role: "none" },
    action,
    targetType: "User",
    targetId: user._id,
    details,
    orgId: null,
  });
}

// Returns { action: "none"|"unchanged"|"promoted"|"created"|"skipped", message }.
// `opts` defaults to the environment: { email, password, name }.
async function ensureSuperAdminDetailed(opts = {}) {
  const email = String(opts.email !== undefined ? opts.email : env.superAdminEmail || "").trim().toLowerCase();
  const password = opts.password !== undefined ? opts.password : env.superAdminPassword;
  const name = String(opts.name !== undefined ? opts.name : env.superAdminName || "Platform Admin").trim() || "Platform Admin";

  if (!email) {
    warnOnce("no-email", "SUPER_ADMIN_EMAIL is not set: no platform admin is configured (organizations cannot be managed until one exists)");
    return { action: "none", message: "SUPER_ADMIN_EMAIL is not set" };
  }

  const existing = await findByEmail(email);
  if (existing) {
    const ok = existing.role === "super_admin" && existing.orgId == null && existing.status === "active" && existing.isActive === true;
    if (ok) return { action: "unchanged", message: `super admin ${existing.email} already configured` };
    const wasRole = existing.role;
    const $set = { role: "super_admin", orgId: null, status: "active", isActive: true, seatKind: null, seatGen: null };
    // An account that never got to choose a password (signup link not clicked, setup link not used) has
    // an unusable one: promoting it as it is would create a platform owner nobody can sign in as, and
    // would leave its one-time link secrets lying around. The operator's configured password becomes
    // its password (or, with none configured, nothing is promoted).
    if (existing.status === "unverified" || existing.status === "invited") {
      const problem = passwordProblem(password);
      if (problem) {
        const message = `${existing.email} exists but never set a password and cannot be promoted: ${problem}`;
        warnOnce(`never-set:${email}:${problem}`, message);
        return { action: "skipped", message };
      }
      $set.passwordHash = await bcrypt.hash(password, 10);
    }
    await User.collection.updateOne(
      { _id: existing._id },
      { $set, $unset: { verifyTokenHash: 1, verifyExpiresAt: 1, setupTokenHash: 1, setupExpiresAt: 1 } }
    );
    if (existing.orgId && existing.seatKind) {
      try {
        await releaseSeat(existing.orgId, existing.seatKind, existing.seatGen);
      } catch {
        /* the seat count is bookkeeping; never block the promotion on it */
      }
    }
    const message = `promoted ${existing.email} to super_admin${wasRole === "super_admin" ? " (repaired flags)" : ` (was ${wasRole})`}`;
    console.log(`[super-admin] ${message}`);
    await audit("update_user", existing, `Platform owner configured from environment: ${message}`);
    return { action: "promoted", message };
  }

  const problem = passwordProblem(password);
  if (problem) {
    const message = `no account for SUPER_ADMIN_EMAIL (${email}) and it cannot be created: ${problem}`;
    warnOnce(`skip:${email}:${problem}`, message);
    return { action: "skipped", message };
  }

  let created;
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    created = await runSystem(() =>
      User.create({ name, email, passwordHash, role: "super_admin", orgId: null, status: "active", isActive: true })
    );
  } catch (err) {
    if (err && err.code === 11000) {
      // another instance created it between our lookup and insert
      return { action: "unchanged", message: `super admin ${email} already configured` };
    }
    throw err;
  }
  const message = `created super_admin ${email}`;
  console.log(`[super-admin] ${message}`);
  await audit("create_user", created, "Platform owner created from environment");
  return { action: "created", message };
}

// Short description of what changed (for the migration summary), or null when nothing did.
async function ensureSuperAdmin(opts) {
  const r = await ensureSuperAdminDetailed(opts);
  return r.action === "promoted" || r.action === "created" ? r.message : null;
}

module.exports = { ensureSuperAdmin, ensureSuperAdminDetailed, passwordProblem, MAX_PASSWORD_BYTES };
