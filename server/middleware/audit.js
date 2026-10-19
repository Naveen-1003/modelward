const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const { GENESIS, computeHash, normalizeFields, currentAlg } = require("../utils/auditChain");
const { runSystem, currentOrgId } = require("../utils/tenant");

// Several instances (or the in-process queue's absence in tests) can race for the
// same next seq; the unique seq index rejects the loser, which re-reads and retries
// with a randomized, growing backoff so contending writers spread out.
const MAX_ATTEMPTS = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asObjectId = (v) => (v && mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : undefined);

// Serialize writes inside this process so they don't fight over the next seq;
// the unique seq index + retry loop below covers other processes.
let queue = Promise.resolve();

// Throws only if every attempt lost the seq race or the write failed for another
// reason; writeAuditLog() turns that into a loud log line.
async function appendEntry(rawFields) {
  const fields = normalizeFields(rawFields); // well-formed strings, BEFORE hashing
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // The chain is ONE global sequence across all organizations: read its head cross-tenant.
    const latest = await AuditLog.findOne({ seq: { $exists: true } }).setOptions({ bypassTenant: true }).sort({ seq: -1 }).select("seq hash").lean();
    const alg = currentAlg();
    const entry = {
      ...fields,
      chainV: 2, // the hash covers orgId (see utils/auditChain.js computeHash)
      seq: ((latest && latest.seq) || 0) + 1,
      prevHash: (latest && latest.hash) || GENESIS,
      hashAlg: alg,
      createdAt: new Date(),
    };
    entry.hash = computeHash(entry, alg);
    try {
      // Written system-wide: the entry's orgId is the org the EVENT belongs to, which may differ
      // from the request context (e.g. a super admin writing into the selected org).
      return await runSystem(() => AuditLog.create(entry));
    } catch (err) {
      if (err && err.code === 11000 && attempt < MAX_ATTEMPTS) {
        await sleep(Math.floor(Math.random() * Math.min(300, 10 + attempt * 15))); // another writer took this seq
        continue;
      }
      throw err;
    }
  }
}

// Which organization an event belongs to: an explicit `orgId` wins (null = platform level);
// omitted -> the request's organization, else the actor's own, else none.
function deriveOrgId(orgId, actor, ctxOrgId) {
  if (orgId !== undefined) return asObjectId(orgId && orgId._id ? orgId._id : orgId) || null;
  return asObjectId(ctxOrgId) || asObjectId(actor && actor.orgId) || null;
}

// Never throws: a logging failure must not break the request that triggered it.
// Await it so the entry is durable before the response (and so tests are deterministic).
async function writeAuditLog({ actor, action, targetType, targetId, details, orgId } = {}) {
  // Resolved NOW, in the caller's async context: the queued `run` below may start inside
  // another request's context (the queue chains promises across requests).
  const resolvedOrgId = deriveOrgId(orgId, actor, currentOrgId());
  const run = async () => {
    try {
      const fields = {
        orgId: resolvedOrgId,
        actorName: String((actor && actor.name) || "anonymous").slice(0, 200),
        actorRole: String((actor && actor.role) || "none"),
        actorId: asObjectId(actor && (actor._id || actor.id)),
        action,
        targetType: targetType || "System",
        targetId: asObjectId(targetId),
        details: String(details == null ? "" : details).slice(0, 2000),
      };
      await appendEntry(fields);
    } catch (err) {
      // An audit entry that could not be stored is a compliance event: say so loudly.
      console.error(
        `[audit] LOST AUDIT ENTRY action=${action} targetType=${targetType || "System"} targetId=${targetId || "-"} actor=${(actor && (actor._id || actor.id)) || "anonymous"}: ${err && err.message}`
      );
    }
  };
  const p = queue.then(run);
  queue = p;
  return p;
}

module.exports = writeAuditLog;
module.exports.appendEntry = appendEntry; // exported for tests: bypasses the in-process queue
