const express = require("express");
const User = require("../models/User");
const { ROLES } = User;
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const validId = require("../middleware/validId");
const writeAuditLog = require("../middleware/audit");
const { parse, z, requiredStr } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const { domainAllowed, emailDomain } = require("../utils/identity");
const { releaseSeat } = require("../utils/joinCodes");
const { sendMail, appUrl } = require("../utils/email");
const { approvedEmail, rejectedEmail } = require("../utils/emailTemplates");
const { newSetupToken, unusablePasswordHash, sendSetupInvite } = require("../utils/setupInvite");

const { isAdmin } = roleGuard;

const router = express.Router();
router.param("id", validId);
// Every query below is org-scoped by the tenant plugin (the org comes from authGuard); a user id
// of another organization simply does not exist here and answers 404.
router.use(authGuard, roleGuard(["admin"]));

// Accounts that are not members of the org yet: shown on the Pending tab, never in the user list.
const NOT_MEMBER = ["unverified", "pending"];
const PENDING_CAP = 500;
const isDup = (err) => Boolean(err) && err.code === 11000;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Strict positive-integer parse: "-3", "abc", "1.5", arrays => fallback.
function intParam(v, fallback, max) {
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) return fallback;
  const n = Number(v);
  if (n < 1) return fallback;
  return Math.min(n, max);
}

const listQuery = z.object({
  q: z.string({ invalid_type_error: "must be a string" }).trim().max(100, "must be at most 100 characters").optional(),
  role: z.enum(ROLES, { errorMap: () => ({ message: `must be one of: ${ROLES.join(", ")}` }) }).optional(),
  page: z.any().optional(),
  limit: z.any().optional(),
});

// No password field: the person sets their own through the one-time setup link. Unknown keys
// (password, orgId, status, ...) are ignored; the org is always the caller's.
const createSchema = z.object({
  name: requiredStr(100),
  email: z
    .string({ invalid_type_error: "must be a string", required_error: "is required" })
    .trim()
    .toLowerCase()
    .max(254, "must be at most 254 characters")
    .email("must be a valid email address"),
  role: z.enum(ROLES, { errorMap: () => ({ message: `must be one of: ${ROLES.join(", ")}` }) }),
  allowExternalEmail: z.boolean({ invalid_type_error: "must be true or false" }).optional(),
});

const patchSchema = z
  .object({
    name: requiredStr(100).optional(),
    role: z.enum(ROLES, { errorMap: () => ({ message: `must be one of: ${ROLES.join(", ")}` }) }).optional(),
    isActive: z.boolean({ invalid_type_error: "must be true or false" }).optional(),
  })
  .refine((v) => v.name !== undefined || v.role !== undefined || v.isActive !== undefined, {
    message: "Provide at least one of: name, role, isActive",
  });

router.get("/", async (req, res) => {
  try {
    const query = parse(listQuery, req.query, res);
    if (!query) return;
    const page = intParam(req.query.page, 1, 1000000);
    const limit = intParam(req.query.limit, 25, 100);

    // Members only: accounts still waiting for email verification / approval are not users yet.
    const filter = { status: { $nin: NOT_MEMBER } };
    if (query.role) filter.role = query.role;
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), "i");
      filter.$or = [{ name: rx }, { email: rx }];
    }

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    ]);
    res.json({
      users: users.map((u) => u.toSafeJSON()),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    serverError(res, err, "Failed to list users");
  }
});

// Accounts waiting for approval (they verified their email), newest first.
router.get("/pending", async (req, res) => {
  try {
    const [total, users] = await Promise.all([
      User.countDocuments({ status: "pending" }),
      User.find({ status: "pending" }).sort({ createdAt: -1, _id: -1 }).limit(PENDING_CAP),
    ]);
    res.json({ users: users.map((u) => u.toSafeJSON()), total });
  } catch (err) {
    serverError(res, err, "Failed to list pending users");
  }
});

// Best-effort notices, sent one after another in the background: they never delay or fail the
// request (sendMail itself never throws).
function notifyLater(mails) {
  if (!mails.length) return;
  (async () => {
    for (const mail of mails) await sendMail(mail);
  })().catch(() => {});
}
const approvedMail = (user, orgName) => ({ to: user.email, ...approvedEmail({ name: user.name, orgName, link: appUrl("/login") }) });

// pending -> active, conditioned on the status IN the update so two admins (or a double click)
// cannot both approve. Returns the approved user or null.
const approveOne = (id) => User.findOneAndUpdate({ _id: id, status: "pending" }, { $set: { status: "active" } }, { new: true });

// Why a transition on a pending user did not happen: not in this org (404) or not pending (409).
async function notPending(req, res) {
  const exists = await User.exists({ _id: req.params.id });
  if (!exists) return res.status(404).json({ error: "User not found" });
  return res.status(409).json({ error: "This account is not awaiting approval" });
}

router.post("/pending/approve-all", async (req, res) => {
  try {
    const waiting = await User.find({ status: "pending" }).sort({ createdAt: 1, _id: 1 }).limit(PENDING_CAP).select("_id");
    const mails = [];
    let approved = 0;
    for (const { _id } of waiting) {
      const user = await approveOne(_id);
      if (!user) continue; // approved or rejected by someone else meanwhile
      approved += 1;
      await writeAuditLog({
        actor: req.user,
        action: "user_approve",
        targetType: "User",
        targetId: user._id,
        details: `Approved ${user.email} (approve all)`,
      });
      mails.push(approvedMail(user, req.org.name));
    }
    notifyLater(mails);
    res.json({ approved });
  } catch (err) {
    serverError(res, err, "Failed to approve pending users");
  }
});

// Add user: the admin vouches for the person, so there is no approval step. The account is
// created without a usable password ("invited"); the person sets their own through a one-time link.
router.post("/", async (req, res) => {
  try {
    const data = parse(createSchema, req.body, res);
    if (!data) return;

    // The domain rule applies unless the admin explicitly overrides it (written to the audit log).
    let external = false;
    if (!domainAllowed(req.org, data.email)) {
      if (data.allowExternalEmail !== true) {
        const message = `the domain "${emailDomain(data.email)}" is not allowed for this organization; tick "allow external email" to add this person anyway`;
        return res.status(400).json({ error: `email: ${message}`, code: "EMAIL_DOMAIN_NOT_ALLOWED", fields: { email: message } });
      }
      external = true;
    }

    const setup = newSetupToken();
    const passwordHash = await unusablePasswordHash();
    let user;
    try {
      // Email uniqueness is global (unique indexes on email and emailKey), across organizations.
      user = await User.create({
        name: data.name,
        email: data.email,
        passwordHash,
        role: data.role,
        status: "invited",
        orgId: req.orgId,
        setupTokenHash: setup.hash,
        setupExpiresAt: setup.expiresAt,
      });
    } catch (err) {
      if (isDup(err)) return res.status(409).json({ error: "An account with that email already exists" });
      throw err;
    }

    await writeAuditLog({
      actor: req.user,
      action: "create_user",
      targetType: "User",
      targetId: user._id,
      details:
        `Created user ${user.email} with role ${user.role} (invited, setup link)` +
        (external ? `; external email override: domain "${emailDomain(user.email)}" is not in the organization's allowed domains` : ""),
    });
    const { emailSent, setupLink } = await sendSetupInvite({ user, orgName: req.org.name, token: setup.token });
    res.status(201).json({ user: user.toSafeJSON(), setupLink, emailSent });
  } catch (err) {
    serverError(res, err, "Failed to create user");
  }
});

router.post("/:id/approve", async (req, res) => {
  try {
    const user = await approveOne(req.params.id);
    if (!user) return await notPending(req, res);
    await writeAuditLog({ actor: req.user, action: "user_approve", targetType: "User", targetId: user._id, details: `Approved ${user.email}` });
    notifyLater([approvedMail(user, req.org.name)]);
    res.json({ user: user.toSafeJSON() });
  } catch (err) {
    serverError(res, err, "Failed to approve user");
  }
});

// Rejecting deletes the pending account (it never became a member) and gives its join-code seat back.
router.post("/:id/reject", async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ _id: req.params.id, status: "pending" });
    if (!user) return await notPending(req, res);
    try {
      await releaseSeat(user.orgId, user.seatKind, user.seatGen);
    } catch (err) {
      console.error(`[users] could not release the seat of rejected user ${user._id}:`, err && err.message);
    }
    await writeAuditLog({ actor: req.user, action: "user_reject", targetType: "User", targetId: user._id, details: `Rejected ${user.email}` });
    notifyLater([{ to: user.email, ...rejectedEmail({ name: user.name, orgName: req.org.name }) }]);
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err, "Failed to reject user");
  }
});

// A fresh 72 h setup link for an account that has not set its password yet (the old link stops working).
router.post("/:id/setup-link", async (req, res) => {
  try {
    const setup = newSetupToken();
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, status: "invited" },
      { $set: { setupTokenHash: setup.hash, setupExpiresAt: setup.expiresAt } },
      { new: true }
    );
    if (!user) {
      const exists = await User.exists({ _id: req.params.id });
      if (!exists) return res.status(404).json({ error: "User not found" });
      return res.status(409).json({ error: "This account has already set its password" });
    }
    await writeAuditLog({ actor: req.user, action: "setup_link_issued", targetType: "User", targetId: user._id, details: `Issued a new setup link for ${user.email}` });
    const { emailSent, setupLink } = await sendSetupInvite({ user, orgName: req.org.name, token: setup.token });
    res.json({ setupLink, emailSent });
  } catch (err) {
    serverError(res, err, "Failed to issue a setup link");
  }
});

// --- last-admin protection ------------------------------------------------------
// Two admins demoting each other at the same instant must not leave zero admins.
// Layer 1: an in-process async mutex serializes every PATCH that touches
// role/isActive. Layer 2 (covers other server instances, where the mutex is
// useless): after writing, re-count active admins; if none remain, revert this
// change and answer 409. If two instances both see zero they both revert, which
// errs on the safe side (admins stay).
// The counts are per organization: the tenant plugin scopes them to the request's org.
let patchLock = Promise.resolve();
function withUserLock(fn) {
  const run = patchLock.then(fn, fn);
  patchLock = run.catch(() => {}); // a failing task must not wedge the queue
  return run;
}

// Admins that can actually act: not deactivated, and past the invitation (an "invited" admin has
// not set a password yet).
const ACTIVE_ADMIN = { role: "admin", isActive: { $ne: false }, status: { $nin: ["invited", ...NOT_MEMBER] } };
const isActiveAdmin = (u) => u.role === "admin" && u.isActive !== false && (!u.status || u.status === "active");
const activeAdmins = () => User.countDocuments(ACTIVE_ADMIN);

router.patch("/:id", async (req, res) => {
  try {
    const data = parse(patchSchema, req.body, res);
    if (!data) return;
    // Only privilege-affecting edits need the lock; a rename can run freely.
    const critical = data.role !== undefined || data.isActive !== undefined;
    const outcome = critical ? await withUserLock(() => applyPatch(req, data)) : await applyPatch(req, data);
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    serverError(res, err, "Failed to update user");
  }
});

async function applyPatch(req, data) {
  // The actor may have been demoted while this request waited for the lock. (A super admin has no
  // organization of its own, so this lookup cannot be org-scoped: reviewed bypass.)
  const actor = await User.findById(req.user._id).select("role isActive").setOptions({ bypassTenant: true });
  if (!actor || actor.isActive === false) return { status: 401, body: { error: "Account is deactivated" } };
  if (!isAdmin(actor)) return { status: 403, body: { error: `Role '${actor.role}' is not permitted to perform this action` } };

  // Members only: accounts waiting for verification / approval are handled on the Pending tab.
  const target = await User.findOne({ _id: req.params.id, status: { $nin: NOT_MEMBER } });
  if (!target) return { status: 404, body: { error: "User not found" } };

  const isSelf = String(target._id) === String(req.user._id);
  const changesRole = data.role !== undefined && data.role !== target.role;
  const deactivates = data.isActive === false && target.isActive !== false;

  if (isSelf && changesRole) return { status: 400, body: { error: "You cannot change your own role" } };
  if (isSelf && data.isActive === false) return { status: 400, body: { error: "You cannot deactivate your own account" } };

  // Never leave an organization without an active admin.
  const losesAdmin = isActiveAdmin(target) && ((changesRole && data.role !== "admin") || deactivates);
  if (losesAdmin) {
    const others = await User.countDocuments({ ...ACTIVE_ADMIN, _id: { $ne: target._id } });
    if (others === 0) return { status: 400, body: { error: "Cannot demote or deactivate the last active admin" } };
  }

  const before = { role: target.role, isActive: target.isActive };
  const changes = [];
  if (data.name !== undefined && data.name !== target.name) {
    changes.push(`name "${target.name}" -> "${data.name}"`);
    target.name = data.name;
  }
  if (changesRole) {
    changes.push(`role ${target.role} -> ${data.role}`);
    target.role = data.role;
  }
  if (data.isActive !== undefined && data.isActive !== (target.isActive !== false)) {
    changes.push(`isActive ${target.isActive !== false} -> ${data.isActive}`);
    target.isActive = data.isActive;
  }

  if (changes.length) {
    await target.save();
    if (losesAdmin && (await activeAdmins()) === 0) {
      // Lost a race (possibly against another instance): undo and refuse.
      await User.updateOne({ _id: target._id }, { $set: { role: before.role, isActive: before.isActive !== false } });
      return { status: 409, body: { error: "Cannot demote or deactivate the last active admin (concurrent change); nothing was changed" } };
    }
    await writeAuditLog({
      actor: req.user,
      action: "update_user",
      targetType: "User",
      targetId: target._id,
      details: `Updated ${target.email}: ${changes.join("; ")}`,
    });
  }
  return { status: 200, body: { user: target.toSafeJSON() } };
}

// Permanently removes a member's account (name, email, password hash) and gives their join-code
// seat back. Records they authored (models, versions, comments) belong to the organization and
// stay, without a name; audit entries keep their own snapshot of who acted. Same last-admin and
// self-protection rules as deactivating.
router.delete("/:id", async (req, res) => {
  try {
    const outcome = await withUserLock(() => applyDelete(req));
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    serverError(res, err, "Failed to delete user");
  }
});

async function applyDelete(req) {
  const actor = await User.findById(req.user._id).select("role isActive").setOptions({ bypassTenant: true });
  if (!actor || actor.isActive === false) return { status: 401, body: { error: "Account is deactivated" } };
  if (!isAdmin(actor)) return { status: 403, body: { error: `Role '${actor.role}' is not permitted to perform this action` } };

  const target = await User.findOne({ _id: req.params.id, status: { $nin: NOT_MEMBER } });
  if (!target) return { status: 404, body: { error: "User not found" } };
  if (String(target._id) === String(req.user._id)) return { status: 400, body: { error: "You cannot delete your own account" } };
  if (isActiveAdmin(target) && (await User.countDocuments({ ...ACTIVE_ADMIN, _id: { $ne: target._id } })) === 0) {
    return { status: 400, body: { error: "Cannot delete the last active admin" } };
  }

  const removed = await User.findOneAndDelete({ _id: target._id, status: { $nin: NOT_MEMBER } });
  if (!removed) return { status: 404, body: { error: "User not found" } };
  try {
    await releaseSeat(removed.orgId, removed.seatKind, removed.seatGen);
  } catch (err) {
    console.error(`[users] could not release the seat of deleted user ${removed._id}:`, err && err.message);
  }
  await writeAuditLog({
    actor: req.user,
    action: "user_delete",
    targetType: "User",
    targetId: removed._id,
    details: `Deleted ${removed.email} (${removed.role})`,
  });
  return { status: 200, body: { ok: true } };
}

module.exports = router;
