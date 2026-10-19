const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Organization = require("../models/Organization");
const authGuard = require("../middleware/auth");
const writeAuditLog = require("../middleware/audit");
const { loginLimiter, signupLimiter, joinCodeLimiter, resendVerifyLimiter, tokenLimiter } = require("../middleware/rateLimit");
const { parse, z, requiredStr } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const { normalizeEmail, domainAllowed, newToken, hashToken } = require("../utils/identity");
const { findOrgByCode, codeProblem, reserveSeat, releaseSeat } = require("../utils/joinCodes");
const { sendMail, appUrl } = require("../utils/email");
const { verificationEmail } = require("../utils/emailTemplates");
const { unusablePasswordHash } = require("../utils/setupInvite");
const env = require("../config/env");

const router = express.Router();

// Compared against when the email is unknown so "no such user" and "wrong
// password" cost the same amount of time.
const DUMMY_HASH = bcrypt.hashSync("modelward-dummy-password", 10);

// Signup, login and the one-time-link flows run before any tenant context exists, so every
// User lookup / write below is an explicit, reviewed cross-tenant query (the organization is
// always taken from the user record or the join code, never from the request).
const SYSTEM = { bypassTenant: true };

const VERIFY_HOURS = 168; // 7 days
const VERIFY_MS = VERIFY_HOURS * 60 * 60 * 1000;

function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

const email = z
  .string({ invalid_type_error: "must be a string", required_error: "is required" })
  .trim()
  .toLowerCase()
  .max(254, "must be at most 254 characters")
  .email("must be a valid email address");

const password = z
  .string({ invalid_type_error: "must be a string", required_error: "is required" })
  .min(env.minPasswordLength, `must be at least ${env.minPasswordLength} characters`)
  .max(128, "must be at most 128 characters")
  .refine((pw) => Buffer.byteLength(pw, "utf8") <= 72, "password must be at most 72 bytes");

// z.object strips unknown keys: a `role`, `orgId`, `password` or anything else in the body is
// dropped before the handler sees it. The role comes from the join code, the org from the code's
// owner, and the password is chosen later by whoever owns the mailbox (verify-email), so someone
// who signs up with another person's address can never know the password of that account.
const signupSchema = z.object({
  name: requiredStr(100),
  email,
  joinCode: requiredStr(64),
});

// Token fields are matched by hash only; the format is not validated beyond type and size.
const tokenField = z
  .string({ invalid_type_error: "must be a string", required_error: "is required" })
  .trim()
  .min(1, "is required")
  .max(200, "is too long");

const tokenSchema = z.object({ token: tokenField });
const setupSchema = z.object({ token: tokenField, password });
const verifySchema = z.object({ token: tokenField, password });

// Resend is deliberately lenient on format (it always answers 200) but strict on type.
const resendSchema = z.object({
  email: z
    .string({ invalid_type_error: "must be a string", required_error: "is required" })
    .trim()
    .toLowerCase()
    .min(1, "is required")
    .max(254, "must be at most 254 characters"),
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

// The one answer for every join-code / domain / expiry / seat / suspension failure.
const JOIN_DENIED = "Invalid code or email not eligible";
const LINK_INVALID = "This verification link is invalid or has expired";
const SETUP_INVALID = "This setup link is invalid or has expired";

// Never lets a seat bookkeeping hiccup mask the real outcome.
async function safeRelease(orgId, kind, gen) {
  try {
    await releaseSeat(orgId, kind, gen);
  } catch (err) {
    console.error("[auth] could not release a join-code seat:", err && err.message);
  }
}

// Light copy of a user for audit entries (name/role/_id/orgId are all writeAuditLog reads).
const auditActor = (u) => ({ name: u.name, role: u.role, _id: u._id, orgId: u.orgId || null });

// --- signup ---------------------------------------------------------------------------

// Answered before the limiters so a disabled deployment does not burn anybody's budget.
function signupEnabled(req, res, next) {
  if (!env.signupEnabled) {
    return res.status(503).json({ error: "Self-registration is currently unavailable", code: "SIGNUP_DISABLED" });
  }
  return next();
}

// Audits the failure (reason + IP for the operator, never the submitted code) and answers with
// the single generic 403. The audit write never throws and its outcome never reaches the caller.
async function denyJoin(req, res, reason, orgId, attemptedEmail) {
  await writeAuditLog({
    actor: null,
    action: "join_code_failed",
    targetType: "System",
    details: `Signup rejected (${reason}) ip=${req.ip} email=${sanitizeForLog(attemptedEmail)}`,
    orgId: orgId || null,
  });
  return res.status(403).json({ error: JOIN_DENIED });
}

router.post("/signup", signupEnabled, signupLimiter, joinCodeLimiter, async (req, res) => {
  let seat = null; // { orgId, kind, gen } while a reserved seat has no account behind it
  try {
    const data = parse(signupSchema, req.body, res);
    if (!data) return;

    const found = await findOrgByCode(data.joinCode);
    if (!found) return await denyJoin(req, res, "unknown_code", null, data.email);
    const { org, kind } = found;

    const emailKey = normalizeEmail(data.email);
    const sameAccount = { $or: [{ emailKey }, { email: data.email }] };

    let problem = codeProblem(org, kind);
    if (problem === "full") {
      // The last seat may be held by this very person's earlier, still unverified signup (lost
      // mail, expired link): it is replaced below, which frees the seat first.
      const holder = await User.exists({
        ...sameAccount,
        status: "unverified",
        orgId: org._id,
        seatKind: kind,
        seatGen: org.codes[kind].gen,
      }).setOptions(SYSTEM);
      if (holder) problem = null;
    }
    if (problem) return await denyJoin(req, res, problem, org._id, data.email);

    // Exact domain comparison (utils/identity.js): no suffix matching, no subdomains unless listed.
    if (!domainAllowed(org, data.email)) return await denyJoin(req, res, "domain_not_allowed", org._id, data.email);

    // Nobody knows this password: the real one is set when the mailbox owner verifies the address.
    const passwordHash = await unusablePasswordHash();
    const { token, hash } = newToken();

    // One person, one account. An abandoned (unverified) signup is replaced; anything else blocks.
    const existing = await User.find(sameAccount).setOptions(SYSTEM).limit(5);
    if (existing.some((u) => u.status !== "unverified")) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }
    for (const old of existing) {
      // Conditioned on still being unverified: a verification that just went through wins.
      const gone = await User.findOneAndDelete({ _id: old._id, status: "unverified" }).setOptions(SYSTEM);
      if (!gone) return res.status(409).json({ error: "An account with that email already exists" });
      await safeRelease(gone.orgId, gone.seatKind, gone.seatGen);
    }

    // Atomic: re-checks code value, org status, expiry and the seat limit in the update itself.
    const reserved = await reserveSeat(org, kind);
    if (!reserved) return await denyJoin(req, res, "code_unavailable", org._id, data.email);
    seat = { orgId: org._id, kind, gen: reserved.codes[kind].gen };

    let user;
    try {
      user = await User.create({
        name: data.name,
        email: data.email,
        passwordHash,
        role: kind, // decided by the code, never by the request
        orgId: org._id,
        status: "unverified",
        seatKind: kind,
        seatGen: seat.gen,
        verifyTokenHash: hash,
        verifyExpiresAt: new Date(Date.now() + VERIFY_MS),
      });
    } catch (err) {
      // Any create failure (duplicate-key race included) gives the seat back.
      const s = seat;
      seat = null;
      await safeRelease(s.orgId, s.kind, s.gen);
      if (err && err.code === 11000) return res.status(409).json({ error: "An account with that email already exists" });
      throw err;
    }
    seat = null; // the account owns it now

    await writeAuditLog({
      actor: auditActor(user),
      action: "signup",
      targetType: "User",
      targetId: user._id,
      details: `Signed up as ${user.role}${existing.length ? " (replaced an unverified signup)" : ""}`,
      orgId: org._id,
    });

    // The account exists whatever happens to the mail: a failure only changes the message.
    const link = appUrl("/verify-email", { token });
    let emailSent = false;
    try {
      const mail = verificationEmail({ name: user.name, orgName: org.name, link, hours: VERIFY_HOURS });
      emailSent = (await sendMail({ to: user.email, ...mail })).ok === true;
    } catch {
      emailSent = false;
    }

    const body = {
      message: emailSent
        ? "Check your email for a verification link to finish creating your account."
        : 'Your account was created, but the verification email could not be sent. Use "Resend" to get a new link.',
      status: "unverified",
      emailSent,
    };
    // Development convenience only; never in production and never with a real mail provider.
    if (!env.isProd && env.emailProvider === "console") body.devVerifyUrl = link;
    return res.status(201).json(body);
  } catch (err) {
    if (seat) await safeRelease(seat.orgId, seat.kind, seat.gen);
    return serverError(res, err, "Signup failed");
  }
});

// --- email verification -----------------------------------------------------------------

// The unverified user behind a verification token, or null (bad / expired / used link).
function findUnverified(hash) {
  return User.findOne({ verifyTokenHash: hash, status: "unverified", verifyExpiresAt: { $gt: new Date() } }).setOptions(SYSTEM);
}

// Who is verifying (no state change), so the page can show it before asking for a password.
router.post("/verify-email/check", tokenLimiter, async (req, res) => {
  try {
    const data = parse(tokenSchema, req.body, res);
    if (!data) return;
    const user = await findUnverified(hashToken(data.token));
    if (!user || !user.orgId) return res.status(400).json({ error: LINK_INVALID });
    const org = await Organization.findById(user.orgId);
    return res.json({ valid: true, name: user.name, email: user.email, orgName: org ? org.name : null });
  } catch (err) {
    return serverError(res, err, "Could not check the link");
  }
});

router.post("/verify-email", tokenLimiter, async (req, res) => {
  try {
    const data = parse(verifySchema, req.body, res); // a weak password is rejected without using up the link
    if (!data) return;
    const hash = hashToken(data.token);
    const invalid = () => res.status(400).json({ error: LINK_INVALID });

    const candidate = await findUnverified(hash);
    if (!candidate || !candidate.orgId) return invalid();
    const org = await Organization.findById(candidate.orgId);

    // Decided now, from the organization's current rules: a code or domain change since signup counts.
    const auto = Boolean(org && org.status === "active" && org.autoApprove && org.domainRuleEnabled && domainAllowed(org, candidate.email));
    const status = auto ? "active" : "pending";
    const passwordHash = await bcrypt.hash(data.password, 10);

    // One atomic transition, conditioned on everything we checked: two clicks (or a click racing
    // the 7-day expiry, a resend or a replacement signup) can never both succeed. The password is
    // written in the same update, so only the owner of the mailbox ever sets it. No login token is
    // issued here, even for an auto-approved account: the person signs in normally afterwards.
    const user = await User.findOneAndUpdate(
      { _id: candidate._id, status: "unverified", verifyTokenHash: hash, verifyExpiresAt: { $gt: new Date() } },
      { $set: { status, passwordHash }, $unset: { verifyTokenHash: 1, verifyExpiresAt: 1 } },
      { new: true }
    ).setOptions(SYSTEM);
    if (!user) return invalid();

    await writeAuditLog({
      actor: auditActor(user),
      action: "email_verified",
      targetType: "User",
      targetId: user._id,
      details: `Verified email ${sanitizeForLog(user.email)}`,
      orgId: user.orgId,
    });
    if (auto) {
      await writeAuditLog({
        actor: auditActor(user),
        action: "user_approve",
        targetType: "User",
        targetId: user._id,
        details: "auto-approved",
        orgId: user.orgId,
      });
    }

    return res.json({
      status,
      message: auto
        ? "Email verified. You can sign in now."
        : "Email verified. Your account is now waiting for approval from your organization's admin.",
    });
  } catch (err) {
    return serverError(res, err, "Verification failed");
  }
});

const RESEND_ANSWER = "If that address is waiting for verification, a new link has been sent";

router.post("/resend-verification", resendVerifyLimiter, async (req, res) => {
  try {
    const data = parse(resendSchema, req.body, res);
    if (!data) return;

    const emailKey = normalizeEmail(data.email);
    const user = await User.findOne({ $or: [{ emailKey }, { email: data.email }], status: "unverified" }).setOptions(SYSTEM);
    // An expired link cannot be revived (the expiry is not extended); that person signs up again.
    if (user && user.verifyExpiresAt && user.verifyExpiresAt > new Date() && user.orgId) {
      const { token, hash } = newToken();
      const updated = await User.findOneAndUpdate(
        { _id: user._id, status: "unverified", verifyExpiresAt: { $gt: new Date() } },
        { $set: { verifyTokenHash: hash } },
        { new: true }
      ).setOptions(SYSTEM);
      if (updated) {
        const org = await Organization.findById(updated.orgId);
        const hours = Math.max(1, Math.round((updated.verifyExpiresAt.getTime() - Date.now()) / 3600000));
        const mail = verificationEmail({ name: updated.name, orgName: org ? org.name : "", link: appUrl("/verify-email", { token }), hours });
        // Not awaited: the answer must take the same time whether or not an account is waiting
        // (otherwise the response time would tell who has an unverified signup).
        sendMail({ to: updated.email, ...mail }).catch(() => {});
      }
    }
    return res.json({ message: RESEND_ANSWER });
  } catch (err) {
    return serverError(res, err, "Could not send the verification email");
  }
});

// --- password setup for admin-created accounts -------------------------------------------

// The invited user behind a setup token, plus why they still may not sign in (deactivated /
// organization suspended), reusing the very rule the login uses. null user = bad / expired / used link.
async function findInvitee(token) {
  const hash = hashToken(token);
  const user = await User.findOne({ setupTokenHash: hash, status: "invited", setupExpiresAt: { $gt: new Date() } }).setOptions(SYSTEM);
  if (!user) return { hash, user: null };
  const org = user.orgId ? await Organization.findById(user.orgId) : null;
  // Judged as if the account were active: "invited" itself is what this link is about to fix.
  const problem = User.authProblem({ isActive: user.isActive, status: "active", role: user.role }, org);
  return { hash, user, org, problem };
}

router.post("/setup-password/check", tokenLimiter, async (req, res) => {
  try {
    const data = parse(tokenSchema, req.body, res);
    if (!data) return;
    const { user, org, problem } = await findInvitee(data.token);
    if (!user) return res.status(400).json({ error: SETUP_INVALID });
    if (problem) return res.status(403).json({ error: problem.message, code: problem.code });
    return res.json({ valid: true, name: user.name, email: user.email, orgName: org ? org.name : null });
  } catch (err) {
    return serverError(res, err, "Could not check the link");
  }
});

router.post("/setup-password", tokenLimiter, async (req, res) => {
  try {
    const data = parse(setupSchema, req.body, res); // a weak password is rejected without using up the link
    if (!data) return;
    const { hash, user: invitee, org, problem } = await findInvitee(data.token);
    if (!invitee) return res.status(400).json({ error: SETUP_INVALID });
    if (problem) return res.status(403).json({ error: problem.message, code: problem.code });

    const passwordHash = await bcrypt.hash(data.password, 10);
    // invited -> active exactly once, conditioned on the same hash, expiry and a live account.
    const user = await User.findOneAndUpdate(
      { _id: invitee._id, status: "invited", setupTokenHash: hash, setupExpiresAt: { $gt: new Date() }, isActive: { $ne: false } },
      { $set: { passwordHash, status: "active" }, $unset: { setupTokenHash: 1, setupExpiresAt: 1 } },
      { new: true }
    ).setOptions(SYSTEM);
    if (!user) return res.status(400).json({ error: SETUP_INVALID });

    await writeAuditLog({
      actor: auditActor(user),
      action: "password_setup",
      targetType: "User",
      targetId: user._id,
      details: "Password set from a setup link",
      orgId: user.orgId,
    });
    return res.json({ token: signToken(user), user: user.toSafeJSON({ orgName: org ? org.name : null }) });
  } catch (err) {
    return serverError(res, err, "Could not set the password");
  }
});

// --- login --------------------------------------------------------------------------------

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const data = parse(loginSchema, req.body, res);
    if (!data) return;

    // "+tag" and case variants are one account (emailKey). An exact stored address wins if two
    // legacy rows ever share a key.
    const candidates = await User.find({ $or: [{ emailKey: normalizeEmail(data.email) }, { email: data.email }] }).setOptions(SYSTEM).limit(2);
    const user = candidates.find((u) => u.email === data.email) || candidates[0] || null;
    const match = await bcrypt.compare(data.password, user ? user.passwordHash : DUMMY_HASH);

    if (!user || !match) {
      await writeAuditLog({
        actor: null,
        action: "login_failed",
        targetType: "User",
        targetId: user ? user._id : undefined,
        details: `Failed login for ${sanitizeForLog(data.email)}`,
        orgId: user ? user.orgId || null : null,
      });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Checked after the password so wrong-password callers can't probe for
    // deactivated / unverified / pending accounts or suspended organizations.
    const org = user.role === "super_admin" || !user.orgId ? null : await Organization.findById(user.orgId);
    const problem = User.authProblem(user, org);
    if (problem) {
      await writeAuditLog({
        actor: null,
        action: "login_failed",
        targetType: "User",
        targetId: user._id,
        details: `Login blocked (${problem.code}) for ${sanitizeForLog(data.email)}`,
        orgId: user.orgId || null,
      });
      return res.status(403).json({ error: problem.message, code: problem.code });
    }

    await writeAuditLog({ actor: user, action: "login", targetType: "User", targetId: user._id, details: "Signed in", orgId: user.orgId || null });
    res.json({ token: signToken(user), user: user.toSafeJSON({ orgName: org ? org.name : null }) });
  } catch (err) {
    serverError(res, err, "Login failed");
  }
});

// Platform guard: a super admin with no organization selected still gets their own profile.
router.get("/me", authGuard.platform, (req, res) => {
  // orgName is the user's OWN organization (req.org is the selected one for a super admin).
  const orgName = req.user.role === "super_admin" ? null : req.org ? req.org.name : null;
  res.json({ user: req.user.toSafeJSON({ orgName }) });
});

module.exports = router;
