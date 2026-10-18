const express = require("express");
const AuditLog = require("../models/AuditLog");
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const { parse, z } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const { verifyChain } = require("../utils/auditChain");

const router = express.Router();

const EXPORT_MAX_ROWS = 5000;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

function buildFilter(f) {
  const filter = {};
  if (f.action) filter.action = f.action;
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

router.get("/", authGuard, async (req, res) => {
  try {
    const f = parse(filterSchema, req.query, res);
    if (!f) return;
    const page = intParam(req.query.page, 1, 1000000);
    const limit = intParam(req.query.limit, 25, 100);

    const scoped = req.user.role === "ml_engineer";
    const query = combine(buildFilter(f), scoped ? await scopeFor(req.user) : null);

    const [total, logs] = await Promise.all([
      AuditLog.countDocuments(query),
      AuditLog.find(query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    res.json({ logs: logs.map(toJSON), page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), scoped });
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

router.get("/export", authGuard, roleGuard(["compliance_officer", "admin"]), async (req, res) => {
  try {
    const f = parse(filterSchema, req.query, res);
    if (!f) return;
    const logs = await AuditLog.find(buildFilter(f)).sort({ createdAt: -1, _id: -1 }).limit(EXPORT_MAX_ROWS).lean();

    const header = ["seq", "createdAt", "actorName", "actorRole", "action", "targetType", "targetId", "details", "hash"];
    const lines = [header.join(",")];
    for (const l of logs) {
      lines.push(
        [l.seq, l.createdAt, l.actorName, l.actorRole, l.action, l.targetType, l.targetId, l.details, l.hash].map(csvCell).join(",")
      );
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
    expectedHeadSeq: z.string({ invalid_type_error: "must be a string" }).regex(/^[1-9]d{0,14}$/, "must be a positive integer").optional(),
    expectedHeadHash: z.string({ invalid_type_error: "must be a string" }).regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex hash").optional(),
  })
  .refine((v) => (v.expectedHeadSeq === undefined) === (v.expectedHeadHash === undefined), {
    message: "provide both expectedHeadSeq and expectedHeadHash",
    path: ["expectedHeadSeq"],
  });

router.get("/verify", authGuard, roleGuard(["admin"]), async (req, res) => {
  try {
    const q = parse(verifyQuery, req.query, res);
    if (!q) return;
    const result = await verifyChain(AuditLog);
    const legacyUnchained = await AuditLog.collection.countDocuments({ seq: { $exists: false } });
    const out = { ...result, legacyUnchained };
    if (q.expectedHeadSeq !== undefined) {
      const row = await AuditLog.findOne({ seq: Number(q.expectedHeadSeq) }).select("hash").lean();
      out.headMatches = Boolean(row && row.hash === q.expectedHeadHash.toLowerCase());
    }
    res.json(out);
  } catch (err) {
    serverError(res, err, "Failed to verify audit log");
  }
});

module.exports = router;
