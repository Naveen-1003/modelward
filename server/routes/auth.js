const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const authGuard = require("../middleware/auth");
const writeAuditLog = require("../middleware/audit");
const { loginLimiter, signupLimiter } = require("../middleware/rateLimit");
const { parse, z, requiredStr } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const env = require("../config/env");

const router = express.Router();

// Compared against when the email is unknown so "no such user" and "wrong
// password" cost the same amount of time.
const DUMMY_HASH = bcrypt.hashSync("modelward-dummy-password", 10);

function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

// Equal-length digests make timingSafeEqual usable on arbitrary-length input.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const email = z
  .string({ invalid_type_error: "must be a string", required_error: "is required" })
  .trim()
  .toLowerCase()
  .max(254, "must be at most 254 characters")
  .email("must be a valid email address");

const signupSchema = z.object({
  name: requiredStr(100),
  email,
  password: z
    .string({ invalid_type_error: "must be a string", required_error: "is required" })
    .min(env.minPasswordLength, `must be at least ${env.minPasswordLength} characters`)
    .max(128, "must be at most 128 characters")
    .refine((pw) => Buffer.byteLength(pw, "utf8") <= 72, "password must be at most 72 bytes"),
  role: z.enum(["admin", "ml_engineer", "compliance_officer"], {
    errorMap: () => ({ message: "must be one of: admin, ml_engineer, compliance_officer" }),
  }),
  inviteCode: z.string({ invalid_type_error: "must be a string" }).max(200, "is too long").nullish(),
});

// Login is deliberately lenient on format (a malformed email just fails to match)
// but strict on type, so operator objects never reach the query.
const loginSchema = z.object({
  email: z
    .string({ invalid_type_error: "must be a string", required_error: "is required" })
    .trim()
    .toLowerCase()
    .min(1, "is required")
    .max(254, "must be at most 254 characters"),
  password: z
    .string({ invalid_type_error: "must be a string", required_error: "is required" })
    .min(1, "is required")
    .max(128, "must be at most 128 characters"),
});

// Attempted emails are attacker-controlled: strip control chars, cap length.
const sanitizeForLog = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100);

const INVITE_CODES = {
  admin: () => env.adminInviteCode,
  compliance_officer: () => env.complianceInviteCode,
};

router.post("/signup", signupLimiter, async (req, res) => {
  try {
    const data = parse(signupSchema, req.body, res);
    if (!data) return;

    // Privileged roles can't be self-selected: they need the server's invite code.
    if (INVITE_CODES[data.role]) {
      const expected = INVITE_CODES[data.role]();
      if (!expected) return res.status(403).json({ error: "Signup for this role is disabled" });
      if (!data.inviteCode || !safeEqual(data.inviteCode, expected)) {
        // Never log the submitted code itself, only who tried for which role.
        console.warn(`[auth] rejected signup invite code: role=${data.role} ip=${req.ip} ${data.inviteCode ? "wrong code" : "missing code"}`);
        return res.status(403).json({ error: "Invalid invite code" });
      }
    }

    if (await User.exists({ email: data.email })) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    let user;
    try {
      user = await User.create({ name: data.name, email: data.email, passwordHash, role: data.role });
    } catch (err) {
      if (err && err.code === 11000) return res.status(409).json({ error: "An account with that email already exists" });
      throw err;
    }

    await writeAuditLog({
      actor: user,
      action: "signup",
      targetType: "User",
      targetId: user._id,
      details: `Signed up as ${user.role}`,
    });

    res.status(201).json({ token: signToken(user), user: user.toSafeJSON() });
  } catch (err) {
    serverError(res, err, "Signup failed");
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const data = parse(loginSchema, req.body, res);
    if (!data) return;

    const user = await User.findOne({ email: data.email });
    const match = await bcrypt.compare(data.password, user ? user.passwordHash : DUMMY_HASH);

    if (!user || !match) {
      await writeAuditLog({
        actor: null,
        action: "login_failed",
        targetType: "User",
        targetId: user ? user._id : undefined,
        details: `Failed login for ${sanitizeForLog(data.email)}`,
      });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Checked after the password so wrong-password callers can't probe for
    // deactivated accounts.
    if (user.isActive === false) {
      await writeAuditLog({
        actor: null,
        action: "login_failed",
        targetType: "User",
        targetId: user._id,
        details: `Login blocked (deactivated account) for ${sanitizeForLog(data.email)}`,
      });
      return res.status(403).json({ error: "Account is deactivated" });
    }

    await writeAuditLog({ actor: user, action: "login", targetType: "User", targetId: user._id, details: "Signed in" });
    res.json({ token: signToken(user), user: user.toSafeJSON() });
  } catch (err) {
    serverError(res, err, "Login failed");
  }
});

router.get("/me", authGuard, (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

module.exports = router;
