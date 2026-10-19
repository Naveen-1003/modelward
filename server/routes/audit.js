const express = require("express");
const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const Organization = require("../models/Organization");
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const { parse, z } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const { verifyChain } = require("../utils/auditChain");

const router = express.Router();

const EXPORT_MAX_ROWS = 5000;
// A cross_org_attempt row exists only because the id the caller asked for belongs to ANOTHER
// organization. If the caller could read it back (or even count it), the audit trail would tell
// them which ids exist elsewhere. So organization users never see these rows: only the platform
// owner (super admin) does, inside the organization it happened in or in the all-orgs view.
const PROBE_ACTION = "cross_org_attempt";
const hidesProbes = (user) => user.role !== "super_admin";
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const escapeRegex = (s) => s.replace(/\0/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // NUL: MongoDB rejects it in a pattern (-> 500)

// Strict positive-integer parse: "-3", "abc", "0", "1.5", arrays => fallback.
function intParam(v, fallback, max) {
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) return fallback;
  const n = Number(v);
  if (n < 1) return fallback;
  return Math.min(n, max);
}

const optStr = (max) => z.string({ invalid_type_error: "must be a string" }).trim().max(max, `must be at most ${max} characters`).optional();
const isoDate = z
  .string({ invalid_type_error: "must be a string" })
  .trim()
  .refine((v) => v === "" || !Number.isNaN(Date.parse(v)), "must be an ISO date")
  .optional();

const filterSchema = z.object({
  // Super admin only, and only without a selected organization (see viewOf); ignored for everyone else.
  orgId: z.string({ invalid_type_error: "must be a string" }).trim().refine((v) => v === "" || OBJECT_ID.test(v), "must be a valid organization id").optional(),
  action: optStr(60),
  actorRole: optStr(40),
  targetType: optStr(40),
  q: optStr(100),
  from: isoDate,
  to: isoDate,
  page: z.any().optional(),
  limit: z.any().optional(),
});

// "2026-01-31" as `to` means "through the end of that day".
function toBound(v) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { $lt: new Date(Date.parse(v) + 86400000) };
  return { $lte: new Date(v) };
}

// How wide this request may read. Every audit endpoint runs behind authGuard.platform, so a
// super admin may arrive with no organization selected:
//   - everyone else, and a super admin WITH an org selected: the plugin restricts the queries to
//     req.orgId (the org never comes from the query string);
//   - super admin with NO org selected: every organization plus platform entries (orgId null),
//     read with an explicit bypassTenant, optionally narrowed by a validated ?orgId=.
function viewOf(req, f) {
  const allOrgs = req.user.role === "super_admin" && !req.orgId;
  if (!allOrgs) return { allOrgs: false, opts: {}, orgFilter: null };
  return { allOrgs: true, opts: { bypassTenant: true }, orgFilter: f.orgId ? new mongoose.Types.ObjectId(f.orgId) : null };
}

function buildFilter(f, view, hideProbes) {
  const filter = {};
  if (view && view.orgFilter) filter.orgId = view.orgFilter;
  if (f.action) filter.action = hideProbes && f.action === PROBE_ACTION ? { $in: [] } : f.action;
  else if (hideProbes) filter.action = { $ne: PROBE_ACTION };
  if (f.actorRole) filter.actorRole = f.actorRole;
  if (f.targetType) filter.targetType = f.targetType;
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), "i");
    filter.$or = [{ details: rx }, { actorName: rx }];
  }
  if (f.from || f.to) {
    filter.createdAt = {};
    if (f.from) filter.createdAt.$gte = new Date(f.from);
    if (f.to) Object.assign(filter.createdAt, toBound(f.to));
  }
  return filter;
}

// ml_engineer: only entries they performed, or that concern their own models/versions.
async function scopeFor(user) {
  const Model = require("../models/Model");
  const Version = require("../models/Version");
  const models = await Model.find({ createdBy: user._id }).setOptions({ includeDeleted: true }).select("_id").lean();
  const modelIds = models.map((m) => m._id);
  const versions = await Version.find({ $or: [{ modelId: { $in: modelIds } }, { createdBy: user._id }] })
    .setOptions({ includeDeleted: true })
    .select("_id")
    .lean();
  const targetIds = [...modelIds, ...versions.map((v) => v._id)];
  return {
    $or: [
      { actorId: user._id },
      { targetId: { $in: targetIds } },
      // True legacy rows only: written before the chain (no seq) AND before actorId.
      // Never match the placeholder identity used for anonymous events (failed
      // logins), or a user who simply NAMES themself "anonymous" would read them.
      ...(String(user.name).trim().toLowerCase() === "anonymous"
        ? []
        : [{ seq: { $exists: false }, actorId: { $exists: false }, actorRole: { $ne: "none" }, actorName: user.name }]),
    ],
  };
}

function combine(filter, scope) {
  return scope ? { $and: [scope, filter] } : filter;
}

const toJSON = (l) => ({
  _id: l._id,
  orgId: l.orgId || null, // null = platform-level entry
  seq: l.seq === undefined ? null : l.seq,
  actorName: l.actorName,
  actorRole: l.actorRole,
  action: l.action,
  targetType: l.targetType,
  targetId: l.targetId || null,
  details: l.details,
  createdAt: l.createdAt,
  hash: l.hash || null,
});

// Super admin all-orgs view: one batched lookup adds the organization's name to each row
// (null for platform-level entries, whose orgId is null).
async function addOrgNames(rows) {
  const ids = [...new Set(rows.map((r) => r.orgId).filter(Boolean).map(String))];
  const orgs = ids.length ? await Organization.find({ _id: { $in: ids } }).select("name").lean() : [];
  const names = new Map(orgs.map((o) => [String(o._id), o.name]));
  for (const r of rows) r.orgName = r.orgId ? names.get(String(r.orgId)) || null : null;
  return rows;
}

router.get("/", authGuard.platform, async (req, res) => {
  try {
    const f = parse(filterSchema, req.query, res);
    if (!f) return;
    const page = intParam(req.query.page, 1, 1000000);
    const limit = intParam(req.query.limit, 25, 100);

    const view = viewOf(req, f);
    const scoped = req.user.role === "ml_engineer";
    const query = combine(buildFilter(f, view, hidesProbes(req.user)), scoped ? await scopeFor(req.user) : null);

    const [total, logs] = await Promise.all([
      AuditLog.countDocuments(query).setOptions(view.opts),
      AuditLog.find(query).setOptions(view.opts).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    const rows = logs.map(toJSON);
    if (view.allOrgs) await addOrgNames(rows);
    res.json({ logs: rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), scoped });
  } catch (err) {
    serverError(res, err, "Failed to fetch audit log");
  }
});

// RFC 4180 quoting + CSV-injection guard (a cell starting with = + - @ is
// formula-evaluated by Excel/Sheets, so it gets a leading apostrophe).
function csvCell(value) {
  let s = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get("/export", authGuard.platform, roleGuard(["compliance_officer", "admin"]), async (req, res) => {
  try {
    const f = parse(filterSchema, req.query, res);
    if (!f) return;
    const view = viewOf(req, f);
    const logs = await AuditLog.find(buildFilter(f, view, hidesProbes(req.user))).setOptions(view.opts).sort({ createdAt: -1, _id: -1 }).limit(EXPORT_MAX_ROWS).lean();
    // The all-organizations export also says which organization each row belongs to.
    const rows = view.allOrgs ? await addOrgNames(logs.map((l) => ({ ...l, orgId: l.orgId || null }))) : logs;

    const header = ["seq", "createdAt", "actorName", "actorRole", "action", "targetType", "targetId", "details", "hash"];
    if (view.allOrgs) header.push("orgId", "orgName");
    const lines = [header.join(",")];
    for (const l of rows) {
      const cells = [l.seq, l.createdAt, l.actorName, l.actorRole, l.action, l.targetType, l.targetId, l.details, l.hash];
      if (view.allOrgs) cells.push(l.orgId, l.orgName);
      lines.push(cells.map(csvCell).join(","));
    }
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join("\r\n") + "\r\n");
  } catch (err) {
    serverError(res, err, "Failed to export audit log");
  }
});

// Optional external-head check: ?expectedHeadSeq=N&expectedHeadHash=<hex>.
// headMatches is true when entry N still exists with that hash, i.e. the head the
// admin recorded earlier is still part of the log (the log may have grown since).
// false => the tail was truncated or rewritten. See utils/auditChain.js.
const verifyQuery = z
  .object({
    expectedHeadSeq: z.string({ invalid_type_error: "must be a string" }).regex(/^[1-9]\d{0,14}$/, "must be a positive integer").optional(),
    expectedHeadHash: z.string({ invalid_type_error: "must be a string" }).regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex hash").optional(),
  })
  .refine((v) => (v.expectedHeadSeq === undefined) === (v.expectedHeadHash === undefined), {
    message: "provide both expectedHeadSeq and expectedHeadHash",
    path: ["expectedHeadSeq"],
  });

// The chain is ONE global sequence, so verification always walks all of it (verifyChain reads
// it cross-tenant). What the caller gets back depends on who asks:
//   super admin: the full result (chain head, totals, every broken seq) as always;
//   org admin:   { ok, entries, brokenInOrg, ... } where `ok` is the integrity of the WHOLE chain
//                (one boolean), and everything else concerns this organization's own entries only:
//                `entries` = its chained entries, `brokenInOrg` = broken seqs that are its rows,
//                `hashAlgs` / `legacyUnchained` = counts over its rows. No head, no foreign seq,
//                no foreign counts. (A deleted row cannot be attributed to an organization, so it
//                shows up as ok:false with nothing in brokenInOrg. verifyChain reports at most 50
//                broken seqs, so on a heavily damaged chain brokenInOrg can be incomplete.)
router.get("/verify", authGuard.platform, roleGuard(["admin"]), async (req, res) => {
  try {
    const q = parse(verifyQuery, req.query, res);
    if (!q) return;
    const result = await verifyChain(AuditLog);
    const superAdmin = req.user.role === "super_admin";
    let out;
    if (superAdmin) {
      const legacyUnchained = await AuditLog.collection.countDocuments({ seq: { $exists: false } });
      out = { ...result, legacyUnchained };
    } else {
      // These run in the request's organization context: the plugin restricts them to its rows.
      // (probe rows are left out of every figure: see PROBE_ACTION)
      const visible = { action: { $ne: PROBE_ACTION } };
      const [entries, legacyUnchained, algRows, brokenRows] = await Promise.all([
        AuditLog.countDocuments({ seq: { $exists: true }, ...visible }),
        AuditLog.countDocuments({ seq: { $exists: false } }),
        AuditLog.aggregate([{ $match: { seq: { $exists: true }, ...visible } }, { $group: { _id: { $ifNull: ["$hashAlg", "sha256"] }, n: { $sum: 1 } } }]),
        result.brokenSeqs && result.brokenSeqs.length ? AuditLog.find({ seq: { $in: result.brokenSeqs }, ...visible }).select("seq").lean() : [],
      ]);
      const hashAlgs = { sha256: 0, "hmac-sha256": 0 };
      for (const r of algRows) hashAlgs[r._id] = (hashAlgs[r._id] || 0) + r.n;
      out = {
        ok: result.ok,
        entries,
        brokenInOrg: brokenRows.map((r) => r.seq).sort((a, b) => a - b),
        hashAlgs,
        keyed: result.keyed,
        legacyUnchained,
      };
    }
    if (q.expectedHeadSeq !== undefined) {
      // Super admin: any entry of the chain. Org admin: only an entry of its own organization.
      const row = await AuditLog.findOne({ seq: Number(q.expectedHeadSeq), ...(superAdmin ? {} : { action: { $ne: PROBE_ACTION } }) })
        .setOptions(superAdmin ? { bypassTenant: true } : {})
        .select("hash")
        .lean();
      out.headMatches = Boolean(row && row.hash === q.expectedHeadHash.toLowerCase());
    }
    res.json(out);
  } catch (err) {
    serverError(res, err, "Failed to verify audit log");
  }
});

module.exports = router;
