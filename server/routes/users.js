const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { ROLES } = User;
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const validId = require("../middleware/validId");
const writeAuditLog = require("../middleware/audit");
const { parse, z, requiredStr } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const env = require("../config/env");

const router = express.Router();
router.param("id", validId);
router.use(authGuard, roleGuard(["admin"]));

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

const createSchema = z.object({
  name: requiredStr(100),
  email: z
    .string({ invalid_type_error: "must be a string", required_error: "is required" })
    .trim()
    .toLowerCase()
    .max(254, "must be at most 254 characters")
    .email("must be a valid email address"),
  password: z
    .string({ invalid_type_error: "must be a string", required_error: "is required" })
    .min(env.minPasswordLength, `must be at least ${env.minPasswordLength} characters`)
    .max(128, "must be at most 128 characters")
    // bcrypt silently ignores everything after byte 72
    .refine((pw) => Buffer.byteLength(pw, "utf8") <= 72, "password must be at most 72 bytes"),
  role: z.enum(ROLES, { errorMap: () => ({ message: `must be one of: ${ROLES.join(", ")}` }) }),
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

    const filter = {};
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

// Admin-created accounts need no invite code: the admin is the authority.
router.post("/", async (req, res) => {
  try {
    const data = parse(createSchema, req.body, res);
    if (!data) return;

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
      actor: req.user,
      action: "create_user",
      targetType: "User",
      targetId: user._id,
      details: `Created user ${user.email} with role ${user.role}`,
    });
    res.status(201).json({ user: user.toSafeJSON() });
  } catch (err) {
    serverError(res, err, "Failed to create user");
  }
});

// --- last-admin protection ------------------------------------------------------
// Two admins demoting each other at the same instant must not leave zero admins.
// Layer 1: an in-process async mutex serializes every PATCH that touches
// role/isActive. Layer 2 (covers other server instances, where the mutex is
// useless): after writing, re-count active admins; if none remain, revert this
// change and answer 409. If two instances both see zero they both revert, which
// errs on the safe side (admins stay).
let patchLock = Promise.resolve();
function withUserLock(fn) {
  const run = patchLock.then(fn, fn);
  patchLock = run.catch(() => {}); // a failing task must not wedge the queue
  return run;
}

const activeAdmins = () => User.countDocuments({ role: "admin", isActive: { $ne: false } });

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
  // The actor may have been demoted while this request waited for the lock.
  const actor = await User.findById(req.user._id).select("role isActive");
  if (!actor || actor.isActive === false) return { status: 401, body: { error: "Account is deactivated" } };
  if (actor.role !== "admin") return { status: 403, body: { error: `Role '${actor.role}' is not permitted to perform this action` } };

  const target = await User.findById(req.params.id);
  if (!target) return { status: 404, body: { error: "User not found" } };

  const isSelf = String(target._id) === String(req.user._id);
  const changesRole = data.role !== undefined && data.role !== target.role;
  const deactivates = data.isActive === false && target.isActive !== false;

  if (isSelf && changesRole) return { status: 400, body: { error: "You cannot change your own role" } };
  if (isSelf && data.isActive === false) return { status: 400, body: { error: "You cannot deactivate your own account" } };

  // Never leave the system without an active admin.
  const losesAdmin = target.role === "admin" && target.isActive !== false && ((changesRole && data.role !== "admin") || deactivates);
  if (losesAdmin) {
    const others = await User.countDocuments({ role: "admin", isActive: { $ne: false }, _id: { $ne: target._id } });
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

module.exports = router;
