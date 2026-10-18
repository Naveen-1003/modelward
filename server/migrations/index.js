// Startup migrations + index creation. Idempotent (safe to run on every boot, on an
// empty database, and on data written by the pre-hardening schema).
//
// Order matters:  backfills -> duplicate cleanup -> indexes.
// autoIndex is OFF (config/db.js) precisely so a UNIQUE index is only built after
// legacy rows were repaired -- otherwise old duplicates would make createIndex fail.
//
// All writes go through the raw driver collections (`Model.collection`) so the
// soft-delete hooks do not hide archived rows and legacy documents that do not match
// the current schema are still reachable.
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
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

// The pre-hardening schema had a plain {name:1} index (often unique) on models. Its options
// (no collation, no partialFilterExpression) clash with the current one, which would make an
// archived name un-reusable and keep case-variants distinct. It is a leftover of OUR OWN
// old schema, so it is dropped and rebuilt (dedupeModelNames has already made names safe).
async function dropStaleModelNameIndex() {
  const Model = mongoose.models.Model;
  if (!Model) return;
  let indexes;
  try {
    indexes = await Model.collection.indexes();
  } catch (err) {
    if (err && (err.code === 26 || err.codeName === "NamespaceNotFound")) return; // no collection yet
    throw err;
  }
  for (const idx of indexes) {
    const keys = Object.keys(idx.key || {});
    if (keys.length !== 1 || keys[0] !== "name" || idx.key.name !== 1) continue;
    if (idx.collation && idx.partialFilterExpression) continue; // already the current definition
    await Model.collection.dropIndex(idx.name);
    console.warn(`[migrations] dropped stale index "${idx.name}" on models (missing collation/partialFilterExpression); recreating`);
  }
}

// createIndexes() for every registered model. Index definitions live on the schemas.
async function ensureIndexes() {
  loadAllModels();
  await dropStaleModelNameIndex();
  for (const M of Object.values(mongoose.models)) {
    try {
      await M.createIndexes();
    } catch (err) {
      // 85/86 = an index with the same key but different options already exists (an older
      // schema); 11000 = a unique index could not be built because existing data violates it.
      // Never crash the boot over either: say so loudly and keep serving.
      if (err && (err.code === 85 || err.code === 86)) {
        console.error(`[migrations] index conflict on ${M.modelName}: ${err.message} -- drop the old index manually`);
        continue;
      }
      if (err && err.code === 11000) {
        console.error(`[migrations] WARNING: could not build a unique index on ${M.modelName} because existing data has duplicates (${err.message}). The server keeps booting WITHOUT that index; fix the data and restart.`);
        continue;
      }
      throw err;
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

// Case-insensitive duplicate names among active models: the oldest keeps its name, later
// ones become "Name (2)", "Name (3)", ... (skipping names that are already taken).
async function dedupeModelNames(summary) {
  const Models = mongoose.model("Model").collection;
  const active = await Models.find({ isDeleted: { $ne: true } }, { projection: { name: 1, createdAt: 1 } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  // Approximates the unique index's ICU collation (en, strength 2): case-insensitive, accents
  // and other letters still distinct (so "ß" stays different from "ss", like the index). Also
  // trimmed, because the API trims names -- being slightly more aggressive than the index is
  // harmless, being less aggressive would let the unique index build fail.
  const keyOf = (name) => String(name).normalize("NFC").trim().toLowerCase();
  const taken = new Set(active.map((m) => keyOf(m.name)));
  const seen = new Set();
  let renamed = 0;
  for (const m of active) {
    const k = keyOf(m.name);
    if (!seen.has(k)) {
      seen.add(k);
      continue;
    }
    const base = String(m.name).trim().slice(0, 110);
    let i = 2;
    while (taken.has(keyOf(`${base} (${i})`))) i += 1;
    const newName = `${base} (${i})`;
    taken.add(keyOf(newName));
    seen.add(keyOf(newName));
    await Models.updateOne({ _id: m._id }, { $set: { name: newName } });
    renamed += 1;
  }
  if (renamed) summary.push(`renamed ${renamed} duplicate model name(s)`);
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
  await backfillSoftDeleteFlag(summary);
  await fixVersionNumbers(summary);
  await backfillVersions(summary);
  await backfillSnapshots(summary);
  await backfillUsers(summary);
  await dedupeModelNames(summary);
  await warnUnknownStatuses();
  await ensureIndexes();
  console.log(`[migrations] ${summary.length ? summary.join("; ") : "no data changes needed"}; indexes ensured`);
  return summary;
}

module.exports = { runMigrations, ensureIndexes };
