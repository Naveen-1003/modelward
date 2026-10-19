const express = require("express");
const Organization = require("../models/Organization");
const User = require("../models/User");
const Model = require("../models/Model");
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const validId = require("../middleware/validId");
const writeAuditLog = require("../middleware/audit");
const { parse, z, str, requiredStr } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const { runSystem } = require("../utils/tenant");
const { normalizeEmail, normalizeDomain, FREE_MAIL_DOMAINS } = require("../utils/identity");
const { KINDS, newCodes, newCodeEntry, formatCode } = require("../utils/joinCodes");
const { newSetupToken, unusablePasswordHash, sendSetupInvite } = require("../utils/setupInvite");

const router = express.Router();

// Platform routes: a super admin without a selected organization is fine. A plain org admin is
// NOT: roleGuard(["super_admin"]) only lets super_admin through (it never treats admin as one).
const platformOnly = [authGuard.platform, roleGuard(["super_admin"])];
// Org-scoped routes: always act on req.orgId (the caller's own org, or the one a super admin
// selected). An organization id from the client is never used on these.
const orgAdmin = [authGuard, roleGuard(["admin"])];

const validIdParam = (req, res, next) => validId(req, res, next, req.params.id);
const KIND_LABEL = { ml_engineer: "ML engineer", compliance_officer: "compliance officer" };
function checkKind(req, res, next) {
  if (!KINDS.includes(req.params.kind)) return res.status(400).json({ error: `Unknown code type; use one of: ${KINDS.join(", ")}` });
  next();
}

const MAX_DOMAINS = 20;

// --- validation ----------------------------------------------------------------------------
const emailField = z
  .string({ invalid_type_error: "must be a string", required_error: "is required" })
  .trim()
  .toLowerCase()
  .max(254, "must be at most 254 characters")
  .email("must be a valid email address");

const domainList = z
  .array(z.string({ invalid_type_error: "each domain must be text" }), { invalid_type_error: "must be a list of domains" })
  .max(MAX_DOMAINS, `at most ${MAX_DOMAINS} domains`)
  .transform((list, ctx) => {
    const out = [];
    for (const raw of list) {
      const d = normalizeDomain(raw);
      if (!d) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${String(raw).slice(0, 60)}" is not a valid domain (e.g. acme.com)` });
        return z.NEVER;
      }
      if (!out.includes(d)) out.push(d);
    }
    return out;
  });

const createSchema = z.object({
  name: requiredStr(120),
  address: str(300).optional(),
  adminEmail: emailField,
  adminName: str(100).optional(),
  allowedDomains: domainList.optional(),
  domainRuleEnabled: z.boolean({ invalid_type_error: "must be true or false" }).optional(),
});

const patchOrgSchema = z
  .object({
    name: requiredStr(120).optional(),
    address: str(300).optional(),
    allowedDomains: domainList.optional(),
    domainRuleEnabled: z.boolean({ invalid_type_error: "must be true or false" }).optional(),
    status: z.enum(["active", "suspended"], { errorMap: () => ({ message: "must be one of: active, suspended" }) }).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Provide at least one of: name, address, allowedDomains, domainRuleEnabled, status",
  });

const autoApproveSchema = z
  .object({ autoApprove: z.boolean({ invalid_type_error: "must be true or false", required_error: "is required" }) })
  .strict();

const expiresAtField = z
  .string({ invalid_type_error: "must be an ISO date or null" })
  .max(40, "is too long")
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v == null) return v; // undefined = unchanged, null = no expiry
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v) || Number.isNaN(Date.parse(v))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an ISO date (for example 2026-12-31) or null" });
      return z.NEVER;
    }
    const d = new Date(v);
    if (d.getTime() <= Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be in the future" });
      return z.NEVER;
    }
    return d;
  });

const codeSchema = z
  .object({
    expiresAt: expiresAtField,
    seatLimit: z
      .number({ invalid_type_error: "must be a whole number or null" })
      .int("must be a whole number")
      .min(1, "must be at least 1")
      .max(100000, "must be at most 100000")
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => v.expiresAt !== undefined || v.seatLimit !== undefined, { message: "Provide expiresAt and/or seatLimit" });

const fieldError = (res, field, message) => res.status(400).json({ error: `${field}: ${message}`, fields: { [field]: message } });

// The domain rule's consistency: with the rule ON there must be at least one domain and none of
// them a free-mail provider (anybody can own an address there). null = fine.
function domainProblem(domains, ruleEnabled) {
  if (!ruleEnabled) return null;
  if (!domains.length) return "add at least one allowed email domain, or turn the domain rule off";
  const free = domains.filter((d) => FREE_MAIL_DOMAINS.has(d));
  if (free.length) {
    return `${free.join(", ")} ${free.length === 1 ? "is a free email provider" : "are free email providers"} and cannot be an allowed domain while the domain rule is on; to admit people with personal addresses, turn the domain rule off (email verification and manual approval stay mandatory)`;
  }
  return null;
}

// --- views ---------------------------------------------------------------------------------
const codeView = (c) => ({
  value: formatCode(c.value),
  expiresAt: c.expiresAt || null,
  seatLimit: c.seatLimit == null ? null : c.seatLimit,
  used: c.used || 0,
});

function orgView(org, counts) {
  const out = {
    id: org._id,
    name: org.name,
    address: org.address || "",
    contactEmail: org.contactEmail || "",
    allowedDomains: org.allowedDomains || [],
    domainRuleEnabled: org.domainRuleEnabled !== false,
    autoApprove: Boolean(org.autoApprove),
    status: org.status,
    createdAt: org.createdAt,
    codes: { ml_engineer: codeView(org.codes.ml_engineer), compliance_officer: codeView(org.codes.compliance_officer) },
  };
  if (counts) out.counts = counts;
  return out;
}

const isDup = (err) => Boolean(err) && err.code === 11000;
const dupOnName = (err) => isDup(err) && Boolean((err.keyPattern && err.keyPattern.name) || /\bname_1\b/.test(String(err.message)));
const nameTaken = (name, exceptId) => {
  const filter = exceptId ? { name, _id: { $ne: exceptId } } : { name };
  return Organization.exists(filter).collation({ locale: "en", strength: 2 });
};
const fmtDate = (d) => (d ? new Date(d).toISOString() : "none");
const fmtLimit = (n) => (n == null ? "none" : String(n));

// --- platform: list / create / edit organizations (super admin) -----------------------------
router.get("/", ...platformOnly, async (req, res) => {
  try {
    // Counts are cross-tenant by nature (this is the platform view): explicit, reviewed bypass.
    // users = every account of the org except the ones that never became members
    // (unverified / pending); models = the non-archived ones.
    const [orgs, userCounts, modelCounts] = await Promise.all([
      Organization.find().sort({ createdAt: -1, _id: -1 }).limit(1000),
      User.aggregate([
        { $match: { orgId: { $ne: null }, status: { $nin: ["unverified", "pending"] } } },
        { $group: { _id: "$orgId", n: { $sum: 1 } } },
      ]).option({ bypassTenant: true }),
      Model.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: "$orgId", n: { $sum: 1 } } },
      ]).option({ bypassTenant: true }),
    ]);
    const users = new Map(userCounts.map((r) => [String(r._id), r.n]));
    const models = new Map(modelCounts.map((r) => [String(r._id), r.n]));
    res.json({
      orgs: orgs.map((o) => orgView(o, { users: users.get(String(o._id)) || 0, models: models.get(String(o._id)) || 0 })),
    });
  } catch (err) {
    serverError(res, err, "Failed to list organizations");
  }
});

router.post("/", ...platformOnly, async (req, res) => {
  try {
    const data = parse(createSchema, req.body, res);
    if (!data) return;
    const domains = data.allowedDomains || [];
    const ruleEnabled = data.domainRuleEnabled !== false;
    const problem = domainProblem(domains, ruleEnabled);
    if (problem) return fieldError(res, "allowedDomains", problem);

    if (await nameTaken(data.name)) return res.status(409).json({ error: "An organization with that name already exists" });
    const emailKey = normalizeEmail(data.adminEmail);
    const emailTaken = await User.exists({ $or: [{ emailKey }, { email: data.adminEmail }] }).setOptions({ bypassTenant: true });
    if (emailTaken) return res.status(409).json({ error: "An account with that email already exists" });

    let org;
    try {
      org = await Organization.create({
        name: data.name,
        address: data.address || "",
        contactEmail: data.adminEmail,
        allowedDomains: domains,
        domainRuleEnabled: ruleEnabled,
        autoApprove: false,
        codes: newCodes(),
        createdBy: req.user._id,
      });
    } catch (err) {
      if (dupOnName(err)) return res.status(409).json({ error: "An organization with that name already exists" });
      throw err;
    }

    // From here on any failure removes the organization again: no org without its first admin.
    let admin;
    let setup;
    try {
      setup = newSetupToken();
      const adminName = (data.adminName || `${data.name} Admin`).trim().slice(0, 100).trim();
      const passwordHash = await unusablePasswordHash();
      // A super admin may have an X-Org-Id selected; this row belongs to the NEW org regardless.
      admin = await runSystem(() =>
        User.create({
          name: adminName,
          email: data.adminEmail,
          passwordHash,
          role: "admin",
          status: "invited",
          orgId: org._id,
          setupTokenHash: setup.hash,
          setupExpiresAt: setup.expiresAt,
        })
      );
    } catch (err) {
      try {
        await Organization.deleteOne({ _id: org._id });
      } catch (cleanupErr) {
        console.error(`[orgs] could not remove organization ${org._id} after a failed admin creation:`, cleanupErr && cleanupErr.message);
      }
      if (isDup(err)) return res.status(409).json({ error: "An account with that email already exists" });
      throw err;
    }

    await writeAuditLog({
      actor: req.user,
      action: "org_create",
      targetType: "Organization",
      targetId: org._id,
      orgId: org._id,
      details: `Created organization "${org.name}" with first admin ${admin.email}; domain rule ${ruleEnabled ? `on (${domains.join(", ")})` : "off"}`,
    });

    const { emailSent, setupLink } = await sendSetupInvite({ user: admin, orgName: org.name, token: setup.token });
    res.status(201).json({ org: orgView(org), admin: admin.toSafeJSON({ orgName: org.name }), setupLink, emailSent });
  } catch (err) {
    serverError(res, err, "Failed to create organization");
  }
});

// Declared before "/:id" so "current" is never taken for an id.
// --- org admin: the caller's own organization ----------------------------------------------
router.get("/current", ...orgAdmin, async (req, res) => {
  try {
    const org = await Organization.findById(req.orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json({ org: orgView(org) });
  } catch (err) {
    serverError(res, err, "Failed to load the organization");
  }
});

// The only organization setting an org admin may change; everything else is the super admin's.
router.patch("/current", ...orgAdmin, async (req, res) => {
  try {
    const data = parse(autoApproveSchema, req.body, res);
    if (!data) return;
    const org = await Organization.findById(req.orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    if (data.autoApprove && !org.domainRuleEnabled) {
      return fieldError(res, "autoApprove", "auto-approve needs the domain rule; the super admin has turned it off for this organization");
    }
    if (org.autoApprove === data.autoApprove) return res.json({ org: orgView(org) });

    // The domain rule is re-checked in the update itself (it may be switched off meanwhile).
    const filter = { _id: org._id };
    if (data.autoApprove) filter.domainRuleEnabled = true;
    const updated = await Organization.findOneAndUpdate(filter, { $set: { autoApprove: data.autoApprove } }, { new: true });
    if (!updated) return res.status(409).json({ error: "The organization settings changed meanwhile; reload and try again" });

    await writeAuditLog({
      actor: req.user,
      action: "org_update",
      targetType: "Organization",
      targetId: org._id,
      orgId: org._id,
      details: `autoApprove ${org.autoApprove} -> ${data.autoApprove}`,
    });
    res.json({ org: orgView(updated) });
  } catch (err) {
    serverError(res, err, "Failed to update the organization");
  }
});

router.put("/current/codes/:kind", ...orgAdmin, checkKind, async (req, res) => {
  try {
    const data = parse(codeSchema, req.body, res);
    if (!data) return;
    const kind = req.params.kind;
    const p = `codes.${kind}`;
    const org = await Organization.findById(req.orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    const prev = org.codes[kind];

    const set = {};
    const changes = [];
    if (data.expiresAt !== undefined) {
      const before = prev.expiresAt ? prev.expiresAt.getTime() : null;
      const after = data.expiresAt ? data.expiresAt.getTime() : null;
      if (before !== after) {
        set[`${p}.expiresAt`] = data.expiresAt;
        changes.push(`expiry ${fmtDate(prev.expiresAt)} -> ${fmtDate(data.expiresAt)}`);
      }
    }
    let limitChanged = false;
    if (data.seatLimit !== undefined) {
      if (data.seatLimit !== null && data.seatLimit < prev.used) {
        return fieldError(res, "seatLimit", `cannot be below the ${prev.used} seat(s) already in use`);
      }
      const before = prev.seatLimit == null ? null : prev.seatLimit;
      if (before !== data.seatLimit) {
        set[`${p}.seatLimit`] = data.seatLimit;
        limitChanged = true;
        changes.push(`seat limit ${fmtLimit(prev.seatLimit)} -> ${fmtLimit(data.seatLimit)} (${prev.used} used)`);
      }
    }
    if (!changes.length) return res.json({ org: orgView(org) });

    // Atomic: still the same code (not regenerated meanwhile) and, for a new limit, still not
    // below the seats used by the time the write happens (a signup may have taken one).
    const filter = { _id: org._id, [`${p}.value`]: prev.value };
    if (limitChanged && data.seatLimit !== null) filter[`${p}.used`] = { $lte: data.seatLimit };
    const updated = await Organization.findOneAndUpdate(filter, { $set: set }, { new: true });
    if (!updated) {
      const now = await Organization.findById(org._id);
      if (!now) return res.status(404).json({ error: "Organization not found" });
      if (now.codes[kind].value !== prev.value) {
        return res.status(409).json({ error: "The code was regenerated meanwhile; reload and try again" });
      }
      return fieldError(res, "seatLimit", `cannot be below the ${now.codes[kind].used} seat(s) already in use`);
    }

    // Never the code value itself.
    await writeAuditLog({
      actor: req.user,
      action: "code_update",
      targetType: "Organization",
      targetId: org._id,
      orgId: org._id,
      details: `${KIND_LABEL[kind]} join code: ${changes.join("; ")}`,
    });
    res.json({ org: orgView(updated) });
  } catch (err) {
    serverError(res, err, "Failed to update the join code");
  }
});

router.post("/current/codes/:kind/regenerate", ...orgAdmin, checkKind, async (req, res) => {
  try {
    const kind = req.params.kind;
    const p = `codes.${kind}`;
    const org = await Organization.findById(req.orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    const prev = org.codes[kind];

    // New value, seat count 0, no expiry, no limit, gen + 1 (a late seat release for the old
    // code becomes a no-op). Conditioned on the code we read, so two regenerates cannot both win.
    const updated = await Organization.findOneAndUpdate(
      { _id: org._id, [`${p}.gen`]: prev.gen, [`${p}.value`]: prev.value },
      { $set: { [p]: newCodeEntry(prev) } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ error: "The code was changed meanwhile; reload and try again" });

    await writeAuditLog({
      actor: req.user,
      action: "code_regenerate",
      targetType: "Organization",
      targetId: org._id,
      orgId: org._id,
      details: `Regenerated the ${KIND_LABEL[kind]} join code (the old code stopped working; ${prev.used} seat(s) had been used)`,
    });
    res.json({ org: orgView(updated) });
  } catch (err) {
    serverError(res, err, "Failed to regenerate the join code");
  }
});

// --- platform: edit any organization (super admin) ------------------------------------------
router.patch("/:id", ...platformOnly, validIdParam, async (req, res) => {
  try {
    const data = parse(patchOrgSchema, req.body, res);
    if (!data) return;
    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const domains = data.allowedDomains !== undefined ? data.allowedDomains : org.allowedDomains;
    const ruleEnabled = data.domainRuleEnabled !== undefined ? data.domainRuleEnabled : org.domainRuleEnabled;
    // Validated on the RESULTING state, but only when this edit touches the domain settings
    // (a rename must not fail because of an older, already-accepted domain list).
    if (data.allowedDomains !== undefined || data.domainRuleEnabled !== undefined) {
      const problem = domainProblem(domains, ruleEnabled);
      if (problem) return fieldError(res, data.allowedDomains !== undefined ? "allowedDomains" : "domainRuleEnabled", problem);
    }

    const set = {};
    const changes = [];
    if (data.name !== undefined && data.name !== org.name) {
      if (await nameTaken(data.name, org._id)) return res.status(409).json({ error: "An organization with that name already exists" });
      set.name = data.name;
      changes.push(`name "${org.name}" -> "${data.name}"`);
    }
    if (data.address !== undefined && data.address !== (org.address || "")) {
      set.address = data.address;
      changes.push("address changed");
    }
    if (data.allowedDomains !== undefined && data.allowedDomains.join(",") !== (org.allowedDomains || []).join(",")) {
      set.allowedDomains = data.allowedDomains;
      changes.push(`allowedDomains [${(org.allowedDomains || []).join(", ")}] -> [${data.allowedDomains.join(", ")}]`);
    }
    if (data.domainRuleEnabled !== undefined && data.domainRuleEnabled !== org.domainRuleEnabled) {
      set.domainRuleEnabled = data.domainRuleEnabled;
      changes.push(`domainRuleEnabled ${org.domainRuleEnabled} -> ${data.domainRuleEnabled}`);
    }
    // Without the domain rule auto-approve makes no sense (anyone verified would walk in).
    if (ruleEnabled === false && org.autoApprove) {
      set.autoApprove = false;
      changes.push("autoApprove true -> false (domain rule is off)");
    }
    const statusFlip = data.status !== undefined && data.status !== org.status ? data.status : null;
    if (statusFlip) {
      set.status = statusFlip;
      changes.push(`status ${org.status} -> ${statusFlip}`);
    }
    if (!changes.length) return res.json({ org: orgView(org) });

    let updated;
    try {
      updated = await Organization.findOneAndUpdate({ _id: org._id }, { $set: set }, { new: true });
    } catch (err) {
      if (dupOnName(err)) return res.status(409).json({ error: "An organization with that name already exists" });
      throw err;
    }
    if (!updated) return res.status(404).json({ error: "Organization not found" });

    const audit = (action, details) =>
      writeAuditLog({ actor: req.user, action, targetType: "Organization", targetId: org._id, orgId: org._id, details });
    await audit("org_update", `Updated organization "${org.name}": ${changes.join("; ")}`);
    if (statusFlip) {
      await audit(statusFlip === "suspended" ? "org_suspend" : "org_activate", `${statusFlip === "suspended" ? "Suspended" : "Re-activated"} organization "${updated.name}"`);
    }
    res.json({ org: orgView(updated) });
  } catch (err) {
    serverError(res, err, "Failed to update the organization");
  }
});

module.exports = router;
