const crypto = require("crypto");
const env = require("../config/env");

const GENESIS = "GENESIS";

// ---------------------------------------------------------------------------
// What the chain protects -- and what it does not (read before relying on it).
//
//  * Every entry hashes its content plus the previous entry's hash, so editing,
//    deleting or inserting a row in the MIDDLE of the log is detected by
//    verifyChain().
//  * By default the hash is a plain SHA-256: anyone with write access to the
//    database can recompute the whole chain after tampering, and nothing will
//    notice. Setting AUDIT_HMAC_KEY switches NEW entries to HMAC-SHA256, so a
//    database-only attacker (no access to the key) cannot forge them. Rows are
//    tagged with `hashAlg`; older sha256 rows keep verifying, but they stay
//    forgeable (they predate the key). A sha256 row appearing AFTER an hmac row is
//    reported as broken (downgrade). Changing or losing the key makes every hmac
//    row fail verification -- keep it stable and backed up.
//  * TAIL TRUNCATION (deleting the newest N entries) leaves a perfectly valid
//    shorter chain, with or without a key. It is only detectable against a head
//    (seq + hash) recorded OUTSIDE the database: GET /api/audit-log/verify returns
//    `head`, and `?expectedHeadSeq=N&expectedHeadHash=...` checks it later.
//    Record the head regularly somewhere the DB admin cannot edit.
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// MongoDB stores strings as UTF-8, which turns a lone UTF-16 surrogate into
// U+FFFD. Hashing the original and storing the replacement would break the chain
// on read-back, so every string is made well-formed BEFORE hashing and storing.
function wellFormed(value) {
  const s = String(value);
  return typeof s.toWellFormed === "function" ? s.toWellFormed() : s.replace(LONE_SURROGATE, "�");
}

const ALGS = ["sha256", "hmac-sha256"];
const currentAlg = () => (env.auditHmacKey ? "hmac-sha256" : "sha256");

function digest(payload, alg) {
  if (alg === "hmac-sha256") {
    if (!env.auditHmacKey) throw new Error("AUDIT_HMAC_KEY is not set");
    return crypto.createHmac("sha256", env.auditHmacKey).update(payload).digest("hex");
  }
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// Canonical hash input. Order and types are part of the contract: verify() must
// reproduce exactly what writeAuditLog() hashed. `alg` defaults to the entry's own
// hashAlg (legacy rows have none => sha256).
//
// chainV 2 (multi-organization) appends the entry's orgId to the hashed array. Rows without
// chainV hash EXACTLY as before, even after the migration backfilled an orgId onto them, so
// the old chain keeps verifying. Dropping chainV from a v2 row changes its hash input, which
// verifyChain reports as a modified entry.
function computeHash(entry, alg) {
  const { seq, prevHash, actorName, actorRole, actorId, action, targetType, targetId, details, createdAt } = entry;
  const fields = [
    seq,
    wellFormed(prevHash),
    wellFormed(actorName),
    wellFormed(actorRole),
    actorId ? String(actorId) : null,
    wellFormed(action),
    wellFormed(targetType),
    targetId ? String(targetId) : null,
    wellFormed(details || ""),
    new Date(createdAt).toISOString(),
  ];
  if (entry.chainV === 2) fields.push(entry.orgId ? String(entry.orgId) : null);
  const payload = JSON.stringify(fields);
  return digest(payload, alg || entry.hashAlg || "sha256");
}

// Normalize the free-text fields of an entry about to be written.
function normalizeFields(fields) {
  const out = { ...fields };
  for (const k of ["actorName", "actorRole", "action", "targetType", "details"]) {
    if (out[k] !== undefined && out[k] !== null) out[k] = wellFormed(out[k]);
  }
  return out;
}

const MAX_BROKEN_REPORTED = 50;

// Walks the chain in seq order using keyset batches (never loads the whole log).
// Does NOT stop at the first problem: it reports up to 50 broken seqs
// (`brokenSeqs`) and the first one as `brokenAtSeq`. `checked` = rows examined.
// Detects a modified entry, a broken link, a deleted/missing seq, an unverifiable
// hmac row (no key configured) and an hmac->sha256 downgrade.
async function verifyChain(AuditLog, batchSize = 1000) {
  let checked = 0;
  let expectedSeq = 1;
  let prevHash = GENESIS;
  let lastSeq = 0;
  let sawHmac = false;
  let head = null;
  const counts = { sha256: 0, "hmac-sha256": 0 };
  const broken = [];
  let brokenTotal = 0;
  const flag = (seq) => {
    brokenTotal += 1;
    if (broken.length < MAX_BROKEN_REPORTED) broken.push(seq);
  };

  for (;;) {
    // The chain is ONE global sequence across all organizations, so it is read cross-tenant.
    const batch = await AuditLog.find({ seq: { $gt: lastSeq } }).setOptions({ bypassTenant: true }).sort({ seq: 1 }).limit(batchSize).lean();
    if (batch.length === 0) break;
    for (const doc of batch) {
      let linkExplainedByGap = false;
      if (doc.seq !== expectedSeq) {
        flag(expectedSeq); // the first missing seq of the gap
        expectedSeq = doc.seq;
        linkExplainedByGap = true;
      }
      const alg = ALGS.includes(doc.hashAlg) ? doc.hashAlg : "sha256";
      let bad = false;
      if (!linkExplainedByGap && doc.prevHash !== prevHash) bad = true;
      if (alg === "sha256" && sawHmac) bad = true; // downgrade
      if (alg === "hmac-sha256" && !env.auditHmacKey) bad = true; // cannot verify
      else {
        try {
          if (computeHash(doc, alg) !== doc.hash) bad = true;
        } catch {
          bad = true;
        }
      }
      if (bad) flag(doc.seq);
      if (alg === "hmac-sha256") sawHmac = true;
      counts[alg] += 1;
      checked += 1;
      prevHash = doc.hash; // follow the stored link so one bad row is one report
      expectedSeq = doc.seq + 1;
      lastSeq = doc.seq;
      head = { seq: doc.seq, hash: doc.hash };
    }
  }
  const result = { ok: broken.length === 0, checked };
  if (broken.length) {
    result.brokenAtSeq = broken[0];
    result.brokenSeqs = broken;
    result.brokenCount = brokenTotal; // > brokenSeqs.length when capped
  }
  result.head = head;
  result.hashAlgs = counts;
  result.keyed = Boolean(env.auditHmacKey);
  return result;
}

module.exports = { GENESIS, computeHash, verifyChain, wellFormed, normalizeFields, currentAlg, MAX_BROKEN_REPORTED };
