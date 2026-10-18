// Retention + orphan sweep. Rows are never hard-deleted here, only the files
// they point at (Render's disk is ephemeral, and archived/failed uploads should
// not pile up forever).
const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const Version = require("../models/Version");

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const ORPHAN_MIN_AGE_MS = DAY_MS;

// Unlink a file; a file that is already gone counts as handled (but not "removed").
async function unlinkQuiet(file) {
  try {
    await fs.promises.unlink(file);
    return true;
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[cleanup] could not delete ${file}: ${err.message}`);
    return false;
  }
}

// Stored paths are absolute (multer) or, if bare, relative to the upload dir.
const resolveStored = (p) => (/[\\/]/.test(p) || path.isAbsolute(p) ? path.resolve(p) : path.join(env.uploadDir, p));

// Never delete outside the upload dir, whatever a (possibly tampered) row says.
function insideUploadDir(file) {
  const rel = path.relative(path.resolve(env.uploadDir), file);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function purgeVersionFiles(cutoff) {
  const versions = await Version.find({
    $and: [
      { $or: [{ filePath: { $ne: null } }, { datasetPath: { $ne: null } }] },
      {
        $or: [
          { isDeleted: true, deletedAt: { $lt: cutoff } },
          { status: "upload_failed", updatedAt: { $lt: cutoff } },
        ],
      },
    ],
  })
    .setOptions({ includeDeleted: true })
    .select("filePath datasetPath status")
    .lean();

  let filesRemoved = 0;
  let versionsUpdated = 0;
  for (const v of versions) {
    for (const p of [v.filePath, v.datasetPath]) {
      if (!p) continue;
      const full = resolveStored(p);
      if (!insideUploadDir(full)) console.warn(`[cleanup] skipping file outside upload dir: ${full}`);
      else if (await unlinkQuiet(full)) filesRemoved += 1;
    }
    // A failed upload whose files are gone can never be retried: say so (uploadError stays,
    // it is the reason the user sees). timestamps:false so updatedAt isn't bumped by housekeeping.
    const set = { filePath: null, datasetPath: null };
    if (v.status === "upload_failed") Object.assign(set, { retryable: false, retryClaimedAt: null });
    await Version.updateOne({ _id: v._id }, { $set: set })
      .setOptions({ includeDeleted: true, timestamps: false });
    versionsUpdated += 1;
  }
  return { filesRemoved, versionsUpdated };
}

async function sweepOrphans() {
  let names;
  try {
    names = await fs.promises.readdir(env.uploadDir);
  } catch {
    return 0; // directory doesn't exist (e.g. discard mode) -> nothing to sweep
  }

  const referenced = new Set();
  const refs = await Version.find({ $or: [{ filePath: { $ne: null } }, { datasetPath: { $ne: null } }] })
    .setOptions({ includeDeleted: true })
    .select("filePath datasetPath")
    .lean();
  for (const r of refs) {
    for (const p of [r.filePath, r.datasetPath]) if (p) referenced.add(path.resolve(resolveStored(p)));
  }

  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  let removed = 0;
  for (const name of names) {
    if (name === ".gitkeep") continue;
    const full = path.resolve(env.uploadDir, name);
    let stat;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs > cutoff || referenced.has(full)) continue;
    if (await unlinkQuiet(full)) removed += 1;
  }
  return removed;
}

async function runCleanupOnce() {
  const cutoff = new Date(Date.now() - env.retentionDays * DAY_MS);
  const { filesRemoved, versionsUpdated } = await purgeVersionFiles(cutoff);
  const orphansRemoved = await sweepOrphans();
  if (filesRemoved || orphansRemoved) {
    console.log(`[cleanup] removed ${filesRemoved} retained file(s) from ${versionsUpdated} version(s) and ${orphansRemoved} orphan file(s)`);
  }
  return { filesRemoved, versionsUpdated, orphansRemoved };
}

async function safeRun() {
  try {
    await runCleanupOnce();
  } catch (err) {
    console.error("[cleanup] run failed:", err);
  }
}

function startCleanupJob() {
  if (process.env.NODE_ENV === "test") return;
  setTimeout(safeRun, FIRST_RUN_DELAY_MS).unref();
  setInterval(safeRun, INTERVAL_MS).unref();
}

module.exports = { startCleanupJob, runCleanupOnce };
