// Startup migrations + index creation. Idempotent (safe to run on every boot, on an
// empty database, and on data written by the pre-hardening schema).
//
// Order matters:  super admin -> default organization -> backfills (incl. orgId) -> duplicate
// cleanup -> index repair -> indexes.
// autoIndex is OFF (config/db.js) precisely so a UNIQUE index is only built after
// legacy rows were repaired -- otherwise old duplicates would make createIndex fail.
//
// All writes go through the raw driver collections (`Model.collection`) so the
// soft-delete hooks do not hide archived rows and legacy documents that do not match
// the current schema are still reachable.
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const env = require("../config/env");
const { normalizeEmail } = require("../utils/identity");
const { newCodes } = require("../utils/joinCodes");
const { ensureSuperAdmin } = require("../utils/superAdmin");
const { DEFAULT_THRESHOLDS } = require("../utils/settings");
const computeRiskTier = require("../utils/riskTier");

const MODELS_DIR = path.join(__dirname, "..", "models");

// Require every file in models/ so models written by other workstreams are registered
// too. A model file that fails to load must not take the whole server down.
function loadAllModels() {
  for (const file of fs.readdirSync(MODELS_DIR)) {
    if (!file.endsWith(".js")) continue;
    try {
      require(path.join(MODELS_DIR, file));
    } catch (err) {
      console.warn(`[migrations] could not load models/${file}: ${err.message}`);
    }
  }
}

const isNoCollection = (err) => err && (err.code === 26 || err.codeName === "NamespaceNotFound");
const sameKey = (a, b) => JSON.stringify(Object.entries(a || {})) === JSON.stringify(Object.entries(b || {}));

async function listIndexes(M) {
  try {
    return await M.collection.indexes();
  } catch (err) {
    if (isNoCollection(err)) return []; // no collection yet
    throw err;
  }
}

// Drops every index of M for which `stale(idx)` is true. These are leftovers of OUR OWN older
// schemas, so they are dropped and (by ensureIndexes) rebuilt from the current definitions.
async function dropIndexesWhere(M, stale, reason) {
  if (!M) return 0;
  let n = 0;
  for (const idx of await listIndexes(M)) {
    if (idx.name === "_id_" || !stale(idx)) continue;
    await M.collection.dropIndex(idx.name);
    n += 1;
    console.warn(`[migrations] dropped stale index "${idx.name}" on ${M.collection.collectionName} (${reason}); recreating`);
  }
  return n;
}

// Legacy indexes that must not survive the multi-tenant schema:
//  - models: the global {name:1} index (any options) made names unique across ALL organizations;
//    and an {orgId,name} index without the current collation/partial filter is rebuilt.
//    (The pre-hardening schema also had {name:1} without collation/partialFilterExpression.)
//  - settings: the unique {key:1} index of the single global settings document.
async function repairLegacyIndexes() {
  await dropIndexesWhere(
    mongoose.models.Model,
    (idx) => {
      if (sameKey(idx.key, { name: 1 })) return true;
      return sameKey(idx.key, { orgId: 1, name: 1 }) && !(idx.collation && idx.partialFilterExpression);
    },
    "models names are unique per organization now"
  );
  await dropIndexesWhere(mongoose.models.Settings, (idx) => sameKey(idx.key, { key: 1 }), "settings are per organization now");
}

// Same options as far as MongoDB's conflict check cares about?
function sameOptions(idx, opts = {}) {
  const j = (v) => JSON.stringify(v == null ? null : v);
  const c = (x) => (x ? `${x.locale}/${x.strength == null ? 3 : x.strength}` : null);
  return (
    !!idx.unique === !!opts.unique &&
    !!idx.sparse === !!opts.sparse &&
    j(idx.partialFilterExpression) === j(opts.partialFilterExpression) &&
    c(idx.collation) === c(opts.collation) &&
    (idx.expireAfterSeconds == null ? null : idx.expireAfterSeconds) === (opts.expireAfterSeconds == null ? null : opts.expireAfterSeconds)
  );
}

// An index with the same key but different options exists (code 85/86): if the schema defines
// that key, the existing one is a leftover of an older schema -> drop it, then rebuild once.
async function dropConflictingSchemaIndexes(M) {
  const wanted = M.schema.indexes();
  return dropIndexesWhere(
    M,
    (idx) => wanted.some(([fields, opts]) => sameKey(fields, idx.key) && !sameOptions(idx, opts)),
    "options differ from the current schema"
  );
}

// createIndexes() for every registered model. Index definitions live on the schemas.
async function ensureIndexes() {
  loadAllModels();
  await repairLegacyIndexes();
  for (const M of Object.values(mongoose.models)) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await M.createIndexes();
        break;
      } catch (err) {
        // 85/86 = an index with the same key but different options already exists (an older
        // schema); 11000 = a unique index could not be built because existing data violates it.
        // Never crash the boot over either: say so loudly and keep serving.
        if (err && (err.code === 85 || err.code === 86)) {
          if (attempt === 1 && (await dropConflictingSchemaIndexes(M)) > 0) continue; // rebuild once
          console.error(`[migrations] index conflict on ${M.modelName}: ${err.message} -- drop the old index manually`);
          break;
        }
        if (err && err.code === 11000) {
          console.error(`[migrations] WARNING: could not build a unique index on ${M.modelName} because existing data has duplicates (${err.message}). The server keeps booting WITHOUT that index; fix the data and restart.`);
          break;
        }
        throw err;
      }
    }
  }
}

const hasPath = (M, p) => !!M.schema.path(p);
// "1791005212828-good_predictions.csv" or "<ts>-<8hex>-name.csv" -> original-looking name
const stripUploadPrefix = (p) =>
  path.basename(String(p).replace(/\\/g, "/")).replace(/^\d{10,}-(?:[0-9a-f]{8}-)?/, "");

async function backfillSoftDeleteFlag(summary) {
  for (const M of Object.values(mongoose.models)) {
    if (!hasPath(M, "isDeleted")) continue;
    const r = await M.collection.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } });
    if (r.modifiedCount) summary.push(`isDeleted:false on ${r.modifiedCount} ${M.modelName}`);
  }
}

// Old code numbered versions with countDocuments(), so concurrent uploads could create
// duplicate numbers. Renumber later duplicates (oldest keeps its number) BEFORE the
// unique {modelId, versionNumber} index exists, then align Model.versionSeq.
async function fixVersionNumbers(summary) {
  const Versions = mongoose.model("Version").collection;
  const Models = mongoose.model("Model").collection;

  const maxByModel = new Map();
  const maxes = await Versions.aggregate([{ $group: { _id: "$modelId", max: { $max: "$versionNumber" } } }], { allowDiskUse: true }).toArray();
  for (const m of maxes) maxByModel.set(String(m._id), m.max || 0);

  const dups = await Versions.aggregate(
    [
      { $sort: { createdAt: 1, _id: 1 } },
      { $group: { _id: { m: "$modelId", n: "$versionNumber" }, ids: { $push: "$_id" } } },
      { $match: { "ids.1": { $exists: true } } },
    ],
    { allowDiskUse: true }
  ).toArray();
  let renumbered = 0;
  for (const d of dups) {
    const key = String(d._id.m);
    for (const id of d.ids.slice(1)) {
      const next = (maxByModel.get(key) || 0) + 1;
      maxByModel.set(key, next);
      await Versions.updateOne({ _id: id }, { $set: { versionNumber: next } });
      renumbered += 1;
    }
  }
  if (renumbered) summary.push(`renumbered ${renumbered} duplicate version number(s)`);

  let seqSet = 0;
  const ops = [];
  for (const [modelId, max] of maxByModel) {
    // Orphans: a version with no modelId (or a non-id value) groups under "null"/"undefined"/garbage;
    // there is no model whose counter it could raise, and `new ObjectId("null")` would crash the boot.
    if (!/^[0-9a-f]{24}$/i.test(modelId)) continue;
    ops.push({ updateOne: { filter: { _id: new mongoose.Types.ObjectId(modelId) }, update: { $max: { versionSeq: max } } } });
  }
  if (ops.length) {
    const r = await Models.bulkWrite(ops, { ordered: false });
    seqSet += r.modifiedCount;
  }
  const r2 = await Models.updateMany({ versionSeq: { $exists: false } }, { $set: { versionSeq: 0 } });
  seqSet += r2.modifiedCount;
  if (seqSet) summary.push(`versionSeq set on ${seqSet} model(s)`);
}

async function backfillVersions(summary) {
  const Versions = mongoose.model("Version").collection;
  let n = 0;

  // initialRiskTier = the tier it was uploaded with (legacy tiers were frozen at upload).
  const r1 = await Versions.updateMany(
    { initialRiskTier: { $exists: false } },
    [{ $set: { initialRiskTier: { $ifNull: ["$riskTier", null] } } }]
  );
  n += r1.modifiedCount;
  // Legacy versions were scored with the hard-coded defaults.
  const r2 = await Versions.updateMany({ thresholdsUsed: { $exists: false } }, { $set: { thresholdsUsed: { ...DEFAULT_THRESHOLDS } } });
  n += r2.modifiedCount;
  const r3 = await Versions.updateMany({ retryable: { $exists: false } }, { $set: { retryable: false } });
  n += r3.modifiedCount;

  // Display names recovered from the stored (timestamp-prefixed) upload path.
  const cursor = Versions.find({
    $or: [
      { fileName: { $exists: false }, filePath: { $type: "string" } },
      { datasetFileName: { $exists: false }, datasetPath: { $type: "string" } },
    ],
  });
  for await (const v of cursor) {
    const $set = {};
    if (v.fileName === undefined && v.filePath) $set.fileName = stripUploadPrefix(v.filePath);
    if (v.datasetFileName === undefined && v.datasetPath) $set.datasetFileName = stripUploadPrefix(v.datasetPath);
    if (Object.keys($set).length) {
      await Versions.updateOne({ _id: v._id }, { $set });
      n += 1;
    }
  }
  if (n) summary.push(`${n} version field backfill(s)`);
}

async function backfillSnapshots(summary) {
  const Snaps = mongoose.model("MetricSnapshot").collection;
  let n = 0;
  let ops = [];
  const flush = async () => {
    if (!ops.length) return;
    await Snaps.bulkWrite(ops, { ordered: false });
    ops = [];
  };
  for await (const s of Snaps.find({ source: { $exists: false } })) {
    ops.push({
      updateOne: {
        filter: { _id: s._id },
        update: {
          $set: {
            source: s.isBaseline ? "baseline" : "simulated",
            riskTier:
              s.riskTier !== undefined
                ? s.riskTier
                : computeRiskTier({ accuracy: s.accuracy, fairnessGap: s.fairnessGap }, DEFAULT_THRESHOLDS),
            ...(s.rows === undefined ? { rows: null } : {}),
          },
        },
      },
    });
    n += 1;
    if (ops.length >= 500) await flush();
  }
  await flush();
  if (n) summary.push(`${n} snapshot backfill(s)`);
}

async function backfillUsers(summary) {
  const User = mongoose.models.User;
  if (!User) return;
  const r = await User.collection.updateMany({ isActive: { $exists: false } }, { $set: { isActive: true } });
  if (r.modifiedCount) summary.push(`isActive:true on ${r.modifiedCount} user(s)`);
}

// ---- multi-tenant backfill -------------------------------------------------------------------
// Legacy rows = rows without an orgId (the single-tenant schema). They go into ONE organization:
// the Default Organization. Everything below works on raw collections: AuditLog is immutable
// through Mongoose and the tenant plugin refuses to write orgId anyway.
const lacksOrg = { orgId: null }; // matches a missing field as well as an explicit null

const tenantCollections = () => ({
  users: mongoose.models.User.collection,
  models: mongoose.models.Model.collection,
  versions: mongoose.models.Version.collection,
  comments: mongoose.models.Comment.collection,
  snapshots: mongoose.models.MetricSnapshot.collection,
  settings: mongoose.models.Settings.collection,
  audit: mongoose.models.AuditLog.collection,
});

// Filters for the legacy rows of each collection. The platform owner never has an org; audit
// rows with chainV 2 were written by the multi-tenant code (orgId null there means platform
// level, and their hash covers orgId, so they must never be touched).
const legacyFilters = {
  users: { ...lacksOrg, role: { $ne: "super_admin" } },
  models: lacksOrg,
  versions: lacksOrg,
  comments: lacksOrg,
  snapshots: lacksOrg,
  settings: lacksOrg,
  audit: { ...lacksOrg, chainV: { $exists: false } },
};

async function hasLegacyRows(c) {
  for (const key of Object.keys(legacyFilters)) {
    if (await c[key].countDocuments(legacyFilters[key], { limit: 1 })) return true;
  }
  return false;
}

// The organization that receives legacy rows. Created only when legacy rows exist: none is ever
// invented for an empty database. If organizations already exist (stray rows after a partial
// run), the oldest one named env.defaultOrgName is used, else it is created.
async function resolveDefaultOrg(c, summary) {
  const Organization = mongoose.models.Organization;
  const name = env.defaultOrgName.slice(0, 120);
  const find = () =>
    Organization.collection.findOne({ name }, { collation: { locale: "en", strength: 2 }, sort: { createdAt: 1, _id: 1 } });
  const found = await find();
  if (found) return found._id;

  const admin = await c.users.findOne({ ...legacyFilters.users, role: "admin" }, { sort: { createdAt: 1, _id: 1 }, projection: { email: 1 } });
  // The unique name index protects against two instances booting at the same moment.
  try {
    await Organization.createIndexes();
  } catch (err) {
    console.warn(`[migrations] could not build organization indexes before creating the default organization: ${err.message}`);
  }
  let org;
  try {
    org = await Organization.create({
      name,
      domainRuleEnabled: false,
      autoApprove: false,
      allowedDomains: [],
      codes: newCodes(),
      contactEmail: admin ? admin.email : "",
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const again = await find();
      if (again) return again._id;
    }
    throw err;
  }
  summary.push(`created organization "${name}" for existing data`);
  return org._id;
}

// versions take their model's org, comments and snapshots their version's. A parent that is
// missing, or has no org itself, falls back to the default organization.
async function backfillFromParent(child, fk, parent, fallbackId) {
  let n = 0;
  const parentIds = await child.distinct(fk, lacksOrg);
  for (let i = 0; i < parentIds.length; i += 1000) {
    const byOrg = new Map();
    const batch = parentIds.slice(i, i + 1000);
    for await (const p of parent.find({ _id: { $in: batch }, orgId: { $type: "objectId" } }, { projection: { orgId: 1 } })) {
      const k = String(p.orgId);
      if (!byOrg.has(k)) byOrg.set(k, { orgId: p.orgId, ids: [] });
      byOrg.get(k).ids.push(p._id);
    }
    for (const { orgId, ids } of byOrg.values()) {
      n += (await child.updateMany({ ...lacksOrg, [fk]: { $in: ids } }, { $set: { orgId } })).modifiedCount;
    }
  }
  return n + (await child.updateMany(lacksOrg, { $set: { orgId: fallbackId } })).modifiedCount;
}

// emailKey = "one person, one account". Plain addresses claim their key first (oldest first); a
// later "+tag" address whose normalized key is already taken keeps its full lowercase address
// as key, so the unique index can always be built.
async function backfillEmailKeys(c, summary) {
  const taken = new Set();
  for await (const u of c.users.find({ emailKey: { $type: "string" } }, { projection: { emailKey: 1 } })) taken.add(u.emailKey);
  const todo = await c.users
    .find({ emailKey: { $not: { $type: "string" } } }, { projection: { email: 1 } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  const fullOf = (u) => String(u.email == null ? "" : u.email).trim().toLowerCase();
  const isPlain = (u) => normalizeEmail(u.email) === fullOf(u);
  const ordered = [...todo.filter(isPlain), ...todo.filter((u) => !isPlain(u))];
  let set = 0;
  const unresolved = [];
  for (const u of ordered) {
    const key = [normalizeEmail(u.email), fullOf(u)].find((k) => k && !taken.has(k));
    if (!key) {
      unresolved.push(u.email);
      continue;
    }
    taken.add(key);
    await c.users.updateOne({ _id: u._id }, { $set: { emailKey: key } });
    set += 1;
  }
  if (set) summary.push(`emailKey on ${set} user(s)`);
  if (unresolved.length) {
    console.warn(`[migrations] WARNING: ${unresolved.length} user(s) have an address that differs from another account's only by case and got no emailKey: ${unresolved.join(", ")}`);
  }
}

// Settings was ONE document with key "global"; it is now one document per organization.
async function backfillSettings(c, defaultId, summary) {
  // The unique {key:1} index goes before keys are unset (afterwards the documents have no key).
  await dropIndexesWhere(mongoose.models.Settings, (idx) => sameKey(idx.key, { key: 1 }), "settings are per organization now");
  const strays = await c.settings.find(lacksOrg).toArray();
  if (strays.length && defaultId) {
    // The legacy global document ("global" first, then the oldest) becomes the default organization's.
    // A second stray cannot be attached (one document per org) and is left alone.
    strays.sort((a, b) => (b.key === "global") - (a.key === "global") || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    let owned = (await c.settings.countDocuments({ orgId: defaultId }, { limit: 1 })) > 0;
    let n = 0;
    for (const doc of strays) {
      if (owned) {
        console.warn(`[migrations] WARNING: extra settings document ${doc._id} cannot be attached (the default organization already has one); left unchanged`);
        continue;
      }
      await c.settings.updateOne({ _id: doc._id }, { $set: { orgId: defaultId } });
      owned = true;
      n += 1;
    }
    if (n) summary.push(`orgId on ${n} settings document(s)`);
  }
  const r = await c.settings.updateMany({ key: { $exists: true }, orgId: { $type: "objectId" } }, { $unset: { key: 1 } });
  if (r.modifiedCount) summary.push(`removed legacy key from ${r.modifiedCount} settings document(s)`);
}

async function backfillTenant(summary) {
  const c = tenantCollections();
  let defaultId = null;
  if (await hasLegacyRows(c)) {
    defaultId = await resolveDefaultOrg(c, summary);
    const note = (n, label) => {
      if (n) summary.push(`orgId on ${n} ${label}`);
    };
    // Parents first, so children can follow them.
    note((await c.models.updateMany(legacyFilters.models, { $set: { orgId: defaultId } })).modifiedCount, "model(s)");
    note(await backfillFromParent(c.versions, "modelId", c.models, defaultId), "version(s)");
    note(await backfillFromParent(c.comments, "versionId", c.versions, defaultId), "comment(s)");
    note(await backfillFromParent(c.snapshots, "versionId", c.versions, defaultId), "snapshot(s)");
    note((await c.users.updateMany(legacyFilters.users, { $set: { orgId: defaultId } })).modifiedCount, "user(s)");
    // Legacy audit rows keep hashing exactly as before: they have no chainV, so computeHash ignores orgId.
    note((await c.audit.updateMany(legacyFilters.audit, { $set: { orgId: defaultId } })).modifiedCount, "audit log row(s)");
  }
  await backfillSettings(c, defaultId, summary);
  // Every account (the platform owner too) gets a status and its uniqueness key.
  const st = await c.users.updateMany({ status: { $exists: false } }, { $set: { status: "active" } });
  if (st.modifiedCount) summary.push(`status:active on ${st.modifiedCount} user(s)`);
  await backfillEmailKeys(c, summary);
}

// Case-insensitive duplicate names among active models OF THE SAME ORGANIZATION (two companies
// may both have a "Credit Scorer"): the oldest keeps its name, later
// ones become "Name (2)", "Name (3)", ... (skipping names that are already taken).
async function dedupeModelNames(summary) {
  const Models = mongoose.model("Model").collection;
  const active = await Models.find({ isDeleted: { $ne: true } }, { projection: { name: 1, createdAt: 1, orgId: 1 } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  // Approximates the unique index's ICU collation (en, strength 2): case-insensitive, accents
  // and other letters still distinct (so "ß" stays different from "ss", like the index). Also
  // trimmed, because the API trims names -- being slightly more aggressive than the index is
  // harmless, being less aggressive would let the unique index build fail.
  // NFKC, not NFC: at collation strength 2 compatibility variants (the "fi" ligature, fullwidth
  // letters, circled letters, ...) are equal too, and one surviving pair keeps the unique index from building.
  const keyOf = (name) => String(name).normalize("NFKC").trim().toLowerCase();
  const scoped = (m, name) => `${m.orgId == null ? "" : String(m.orgId)}|${keyOf(name)}`;
  const taken = new Set(active.map((m) => scoped(m, m.name)));
  const seen = new Set();
  let renamed = 0;
  for (const m of active) {
    const k = scoped(m, m.name);
    if (!seen.has(k)) {
      seen.add(k);
      continue;
    }
    const base = String(m.name).trim().slice(0, 110);
    let i = 2;
    while (taken.has(scoped(m, `${base} (${i})`))) i += 1;
    const newName = `${base} (${i})`;
    taken.add(scoped(m, newName));
    seen.add(scoped(m, newName));
    await Models.updateOne({ _id: m._id }, { $set: { name: newName } });
    renamed += 1;
  }
  if (renamed) summary.push(`renamed ${renamed} duplicate model name(s)`);
}

// An organization nobody can administer: typically the Default Organization whose only admin was
// just promoted to super admin (SUPER_ADMIN_EMAIL). Nothing breaks (its members keep working and the
// super admin can select it and Add user an admin), but pending sign-ups would sit there unanswered,
// so say so on every boot until it has an admin (an invited one counts: that person is on the way).
async function warnOrgsWithoutAdmin() {
  const users = mongoose.models.User.collection;
  const withAdmin = new Set(
    (
      await users.distinct("orgId", {
        role: "admin",
        isActive: { $ne: false },
        status: { $nin: ["unverified", "pending"] },
        orgId: { $type: "objectId" },
      })
    ).map(String)
  );
  for await (const org of mongoose.models.Organization.collection.find({}, { projection: { name: 1 } })) {
    if (!withAdmin.has(String(org._id))) {
      console.warn(
        `[migrations] WARNING: organization "${org.name}" has no active admin. Sign in as the super admin, select the organization and use Add user (role admin) to create one.`
      );
    }
  }
}

// Statuses outside the current enum are left untouched (data is never guessed at), but
// they would be invisible to every status filter, so say how many there are.
async function warnUnknownStatuses() {
  const { STATUSES } = mongoose.model("Version");
  const n = await mongoose.model("Version").collection.countDocuments({ status: { $nin: STATUSES } });
  if (n) console.warn(`[migrations] WARNING: ${n} version(s) have a status outside the known set (${STATUSES.join(", ")}); left unchanged`);
}

async function runMigrations() {
  loadAllModels();
  const summary = [];
  // The platform owner first (a promoted user must not be given an organization below). A problem
  // here (e.g. a weak configured password) must never keep the server from booting.
  try {
    const sa = await ensureSuperAdmin();
    if (sa) summary.push(sa);
  } catch (err) {
    console.error(`[migrations] super admin step failed: ${err.message}`);
  }
  await backfillSoftDeleteFlag(summary);
  await fixVersionNumbers(summary);
  await backfillVersions(summary);
  await backfillSnapshots(summary);
  await backfillUsers(summary);
  await backfillTenant(summary);
  await dedupeModelNames(summary);
  await warnUnknownStatuses();
  await warnOrgsWithoutAdmin();
  await ensureIndexes(); // repairs legacy indexes first, then builds the current ones
  console.log(`[migrations] ${summary.length ? summary.join("; ") : "no data changes needed"}; indexes ensured`);
  return summary;
}

module.exports = { runMigrations, ensureIndexes };
