const express = require("express");
const path = require("path");
const env = require("../config/env");
const Model = require("../models/Model");
const User = require("../models/User");
const Version = require("../models/Version");
const MetricSnapshot = require("../models/MetricSnapshot");
const { STATUSES, FILE_TYPES, LIVE_STATUSES, RETRY_CLAIM_TTL_MS } = Version;
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const writeAuditLog = require("../middleware/audit");
const validId = require("../middleware/validId");
const { uploadVersionFiles, uploadBatchFile } = require("../middleware/upload");
const { parse, z, str, requiredStr } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const computeMetrics = require("../utils/metricsClient");
const computeRiskTier = require("../utils/riskTier");
const scoreCompliance = require("../utils/compliance");
const { nextSnapshot, evaluateSnapshot } = require("../utils/drift");
const { getThresholds } = require("../utils/settings");
const { removeFiles, finalizeAfterScoring, sanitizeDownloadName, fileExists } = require("../utils/fileStore");
const { paginationFields, pageWindow, envelope, escapeRegex } = require("../utils/query");

const router = express.Router();
router.param("id", validId);
router.param("modelId", validId);

const MODEL_FILES_DISABLED = "Model file uploads are disabled on this deployment; upload a predictions CSV instead";
const MAX_SNAPSHOTS = 500;
const MAX_LATENCY_MS = 600000;
const ARCHIVABLE = ["draft", "changes_requested", "rejected", "upload_failed", "superseded", "retired"];
const MODEL_EXTENSIONS = [".pkl", ".pickle", ".joblib"];
const MODEL_NAME_MATCH_CAP = 200; // GET /versions?q= : at most this many model-name matches feed the $in
const CLEAR_ARCHIVE = { isDeleted: false, deletedAt: null, deletedBy: null, deleteReason: "", deletedByCascade: false };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const ext = (file) => path.extname((file && file.originalname) || "").toLowerCase();
const filePaths = (...files) => files.filter(Boolean).map((f) => f.path);
const uploadedFiles = (req) => Object.values(req.files || {}).flat().concat(req.file ? [req.file] : []);

// id -> display name for createdBy / reviewedBy / snapshot authors, in ONE query.
async function nameMap(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } }).select("name").lean();
  return new Map(users.map((u) => [String(u._id), u.name]));
}

// Version JSON (filePath / datasetPath never appear: see Version's toJSON) + display names.
async function presentVersions(versions) {
  const names = await nameMap(versions.flatMap((v) => [v.createdBy, v.reviewedBy]));
  return versions.map((v) => ({
    ...v.toJSON(),
    createdByName: names.get(String(v.createdBy)) || null,
    reviewedByName: v.reviewedBy ? names.get(String(v.reviewedBy)) || null : null,
  }));
}
const presentVersion = async (v) => (await presentVersions([v]))[0];

// A version is only actionable while neither it nor its model is archived
// (the soft-delete plugin makes both lookups return null otherwise).
async function loadActive(id) {
  const version = await Version.findById(id);
  if (!version) return null;
  const model = await Model.findById(version.modelId);
  if (!model) return null;
  return { version, model };
}

// Atomic status transition: only succeeds if the version still has one of the expected
// statuses, so two concurrent clicks cannot both win.
function transition(id, from, set, extraFilter = {}) {
  return Version.findOneAndUpdate({ _id: id, status: { $in: from }, ...extraFilter }, { $set: set }, { new: true });
}

// Response for a transition that did not apply: 404 if the version vanished/was archived,
// else 400 naming the status it actually has now.
async function illegal(res, id, what) {
  const current = await Version.findById(id).select("status").lean();
  if (!current) return res.status(404).json({ error: "Version not found" });
  return res.status(400).json({ error: `Cannot ${what} a version with status '${current.status}'`, currentStatus: current.status });
}

const notFound = (res) => res.status(404).json({ error: "Version not found" });

// Editing/submitting/withdrawing/retrying a version belongs to the engineer who uploaded it.
// (Uploading a NEW version to a model is deliberately open to every ml_engineer: models are
// shared team assets. Only the resulting version is private to its uploader for these actions.)
// Returns true when it already sent the 403.
function notOwner(req, res, version, what) {
  if (req.user.role === "ml_engineer" && String(version.createdBy) !== String(req.user._id)) {
    res.status(403).json({ error: `Only the engineer who uploaded this version can ${what} it` });
    return true;
  }
  return false;
}

// latencyMs arrives as a multipart STRING; accept plain decimals only, finite, 0..600000.
function parseLatency(raw) {
  if (typeof raw !== "string" || !/^\s*\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= MAX_LATENCY_MS ? n : null;
}
const LATENCY_MSG = `must be a number between 0 and ${MAX_LATENCY_MS}`;

function metricsFromComputed(computed, fileType, latency) {
  return {
    accuracy: computed.accuracy,
    fairnessGap: computed.fairnessGap,
    // csv: no inference happens, so latency is the uploader's (self-reported) claim;
    // pickle/joblib: measured for real by the metrics service.
    latencyMs: fileType === "csv" ? latency : computed.latencyMs,
    computedBy: fileType === "csv" ? "self_reported" : "microservice",
    rows: computed.rows,
    demographicParityDiff: computed.demographicParityDiff,
    equalOpportunityDiff: computed.equalOpportunityDiff,
    disparateImpactRatio: computed.disparateImpactRatio,
    precision: computed.precision,
    recall: computed.recall,
    f1: computed.f1,
    auc: computed.auc,
    groups: computed.groups,
  };
}

function createBaseline(versionId, metrics, riskTier, userId) {
  return MetricSnapshot.create({
    versionId,
    accuracy: metrics.accuracy,
    fairnessGap: metrics.fairnessGap,
    latencyMs: metrics.latencyMs,
    driftDelta: 0,
    flagged: false,
    isBaseline: true,
    riskTier,
    source: "baseline",
    rows: metrics.rows,
    createdBy: userId,
  });
}

// Scoring failures always come from metricsClient as Errors with `.retryable`; anything
// else is a bug, reported generically (and treated as retryable).
function classifyFailure(err) {
  if (err && typeof err.retryable === "boolean") return { uploadError: err.message, retryable: err.retryable };
  console.error("[scoring] unexpected error:", err);
  return { uploadError: "Scoring failed unexpectedly, try again shortly", retryable: true };
}

// ---------------------------------------------------------------------------
// POST /api/models/:modelId/versions  (ml_engineer)
// ---------------------------------------------------------------------------
const uploadFieldsSchema = z.object({
  fileType: z.enum(FILE_TYPES, { errorMap: () => ({ message: `must be one of: ${FILE_TYPES.join(", ")}` }) }),
  latencyMs: z.string().optional(),
  datasetNotes: str(5000).optional(),
  trainingNotes: str(5000).optional(),
});

function respondAfterCleanup(res, pathsToRemove) {
  const send = res.json.bind(res);
  res.json = (body) => {
    removeFiles(pathsToRemove()).then(() => send(body));
    return res;
  };
}

router.post("/models/:modelId/versions", authGuard, roleGuard(["ml_engineer"]), uploadVersionFiles, async (req, res) => {
  const files = req.files || {};
  const primary = files.file && files.file[0];
  const dataset = files.datasetFile && files.datasetFile[0];
  const everything = filePaths(primary, dataset);
  let keepFiles = false;
  const reject = (status, body) => res.status(status).json(body);
  // temp files are removed BEFORE the response goes out, so "got a response" implies "no stray
  // file left behind" (the finally block below stays as a safety net)
  respondAfterCleanup(res, () => (keepFiles ? [] : everything));

  try {
    const model = await Model.findById(req.params.modelId);
    if (!model) return reject(404, { error: "Model not found" });

    const fields = parse(uploadFieldsSchema, req.body, res);
    if (!fields) return;
    const { fileType } = fields;
    const isCsv = fileType === "csv";

    if (!isCsv && !env.allowModelFiles) return reject(400, { error: MODEL_FILES_DISABLED });

    if (!primary) return reject(400, { error: "A primary file ('file') is required" });
    if (isCsv && ext(primary) !== ".csv") return reject(400, { error: "A csv upload must be a .csv file" });
    if (!isCsv && !MODEL_EXTENSIONS.includes(ext(primary))) {
      return reject(400, { error: `A ${fileType} upload must be a ${MODEL_EXTENSIONS.join(" / ")} file` });
    }
    if (!isCsv) {
      if (!dataset) {
        return reject(400, { error: "A companion dataset CSV ('datasetFile') is required when fileType is pickle or joblib" });
      }
      if (ext(dataset) !== ".csv") return reject(400, { error: "The companion dataset must be a .csv file" });
    }

    let latency = null;
    if (isCsv) {
      if (fields.latencyMs === undefined || fields.latencyMs.trim() === "") {
        return reject(400, { error: "latencyMs: is required (self-reported) when fileType is csv", fields: { latencyMs: "is required" } });
      }
      latency = parseLatency(fields.latencyMs);
      if (latency === null) {
        return reject(400, { error: `latencyMs: ${LATENCY_MSG}`, fields: { latencyMs: LATENCY_MSG } });
      }
    }

    if (isCsv && dataset) await removeFiles(filePaths(dataset)); // a csv upload never uses a companion file

    // Attempt to score the upload. From here on the result is ALWAYS a saved Version --
    // either scored, or explicitly marked upload_failed with a human-readable reason.
    const thresholds = await getThresholds();
    let status = "draft";
    let metrics = null;
    let riskTier = null;
    let warnings = [];
    let uploadError = null;
    let retryable = false;
    try {
      const computed = await computeMetrics({
        fileType,
        primaryFilePath: primary.path,
        datasetFilePath: isCsv ? null : dataset.path,
      });
      metrics = metricsFromComputed(computed, fileType, latency);
      riskTier = computeRiskTier(metrics, thresholds);
      warnings = computed.warnings || [];
    } catch (err) {
      status = "upload_failed";
      ({ uploadError, retryable } = classifyFailure(err));
    }

    // discard mode keeps files only for retryable failures (Retry needs them)
    const storedFiles = await finalizeAfterScoring({
      files: isCsv ? filePaths(primary) : everything,
      keep: status === "upload_failed" && retryable,
    });

    // Number allocation happens as late as possible so validation failures never burn one.
    const bumped = await Model.findOneAndUpdate({ _id: model._id }, { $inc: { versionSeq: 1 } }, { new: true });
    if (!bumped) return reject(404, { error: "Model not found" }); // model archived meanwhile; finally cleans up

    // keepFiles stays false (the finally block deletes the files) until the version AND its
    // baseline snapshot both exist.
    const version = await Version.create({
      modelId: model._id,
      versionNumber: bumped.versionSeq,
      fileType,
      filePath: storedFiles ? primary.path : null,
      datasetPath: storedFiles && !isCsv ? dataset.path : null,
      fileName: sanitizeDownloadName(primary.originalname, "upload"),
      datasetFileName: !isCsv && dataset ? sanitizeDownloadName(dataset.originalname, "dataset.csv") : null,
      datasetNotes: fields.datasetNotes || "",
      trainingNotes: fields.trainingNotes || "",
      status,
      // keep the self-reported latency on a failed csv upload so a later Retry can reuse it
      metrics: metrics || (isCsv ? { latencyMs: latency, computedBy: "self_reported" } : {}),
      scoringWarnings: warnings,
      riskTier,
      initialRiskTier: riskTier,
      thresholdsUsed: thresholds,
      uploadError,
      retryable,
      createdBy: req.user._id,
    });

    if (metrics) {
      try {
        await createBaseline(version._id, metrics, riskTier, req.user._id);
      } catch (err) {
        // never leave a scored version without its baseline: drop the row (and, via keepFiles,
        // the files) and report a clean 500. The burned version number is harmless.
        await Version.deleteOne({ _id: version._id }).setOptions({ includeDeleted: true }).catch(() => {});
        throw err;
      }
    }
    keepFiles = storedFiles;

    await writeAuditLog({
      actor: req.user,
      action: "upload_version",
      targetType: "Version",
      targetId: version._id,
      details:
        status === "upload_failed"
          ? `Upload failed for "${model.name}" v${version.versionNumber}: ${uploadError}`
          : `Uploaded "${model.name}" v${version.versionNumber} (${fileType}), risk tier: ${riskTier}`,
    });

    // 201 either way -- the Version row exists either way (see status / uploadError).
    res.status(201).json({ version: await presentVersion(version) });
  } catch (err) {
    serverError(res, err, "Failed to upload version");
  } finally {
    if (!keepFiles) await removeFiles(everything);
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/retry  (ml_engineer)  upload_failed -> draft | upload_failed
// ---------------------------------------------------------------------------
router.post("/versions/:id/retry", authGuard, roleGuard(["ml_engineer"]), async (req, res) => {
  let claimedId = null;
  let baselineId = null;
  let filesDiscarded = false;
  try {
    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    const { version, model } = ctx;
    if (notOwner(req, res, version, "retry scoring for")) return;
    if (version.status !== "upload_failed") return illegal(res, version._id, "retry scoring for");

    // retryable === false normally means "claimed by a running retry" or "cannot be fixed".
    // A claim older than the TTL is a crashed retry: allow taking it over.
    const claimCutoff = new Date(Date.now() - RETRY_CLAIM_TTL_MS);
    const claimExpired = !!version.retryClaimedAt && version.retryClaimedAt < claimCutoff;
    if (!version.retryable && !claimExpired) {
      return res.status(400).json({ error: "This failure cannot be fixed by retrying -- upload a corrected file as a new version" });
    }
    const isCsv = version.fileType === "csv";
    if (!fileExists(version.filePath) || (!isCsv && !fileExists(version.datasetPath))) {
      return res.status(400).json({ error: "The uploaded files are no longer stored -- upload the version again" });
    }

    // Claim the retry atomically (flip retryable, stamp the claim) so two clicks cannot score twice.
    const claimed = await Version.findOneAndUpdate(
      { _id: version._id, status: "upload_failed", $or: [{ retryable: true }, { retryClaimedAt: { $lt: claimCutoff } }] },
      { $set: { retryable: false, retryClaimedAt: new Date() } },
      { new: true }
    );
    if (!claimed) return illegal(res, version._id, "retry scoring for");
    claimedId = claimed._id;

    const thresholds = await getThresholds();
    const set = { retryClaimedAt: null };
    const files = [version.filePath, version.datasetPath].filter(Boolean);
    let metrics = null;
    try {
      const computed = await computeMetrics({
        fileType: version.fileType,
        primaryFilePath: version.filePath,
        datasetFilePath: isCsv ? null : version.datasetPath,
      });
      const latency = version.metrics && version.metrics.latencyMs != null ? version.metrics.latencyMs : 0;
      metrics = metricsFromComputed(computed, version.fileType, latency);
      const riskTier = computeRiskTier(metrics, thresholds);
      Object.assign(set, {
        status: "draft",
        metrics,
        riskTier,
        initialRiskTier: riskTier,
        thresholdsUsed: thresholds,
        scoringWarnings: computed.warnings || [],
        uploadError: null,
        retryable: false,
      });
    } catch (err) {
      const failure = classifyFailure(err);
      Object.assign(set, { uploadError: failure.uploadError, retryable: failure.retryable });
    }

    const failed = !metrics;
    // Baseline first: if it cannot be written the version stays upload_failed + retryable
    // (the catch below releases the claim) instead of becoming a draft without a baseline.
    if (metrics) baselineId = (await createBaseline(version._id, metrics, set.riskTier, req.user._id))._id;

    const retained = await finalizeAfterScoring({ files, keep: failed && set.retryable });
    if (!retained) {
      filesDiscarded = true;
      Object.assign(set, { filePath: null, datasetPath: null, retryable: false });
    }

    const updated = await Version.findOneAndUpdate({ _id: version._id }, { $set: set }, { new: true });
    claimedId = null; // the final write released the claim
    baselineId = null;
    if (!updated) {
      // archived while it was being scored: the snapshot belongs to an invisible version, nothing to undo
      return res.status(409).json({ error: "The version was archived while it was being retried" });
    }

    await writeAuditLog({
      actor: req.user,
      action: "retry_version",
      targetType: "Version",
      targetId: version._id,
      details: failed
        ? `Retry failed for "${model.name}" v${version.versionNumber}: ${set.uploadError}`
        : `Retried scoring for "${model.name}" v${version.versionNumber}, risk tier: ${set.riskTier}`,
    });

    res.json({ version: await presentVersion(updated) });
  } catch (err) {
    // Anything that blows up after the claim must not strand the version: give the claim back
    // (unless the files are already gone, in which case a retry could never work).
    if (baselineId) await MetricSnapshot.deleteOne({ _id: baselineId }).catch(() => {});
    if (claimedId) {
      const release = { retryClaimedAt: null, retryable: !filesDiscarded };
      if (filesDiscarded) Object.assign(release, { filePath: null, datasetPath: null });
      await Version.updateOne({ _id: claimedId, status: "upload_failed" }, { $set: release }).catch(() => {});
    }
    serverError(res, err, "Failed to retry scoring");
  }
});

// ---------------------------------------------------------------------------
// GET /api/models/:modelId/versions
// ---------------------------------------------------------------------------
router.get("/models/:modelId/versions", authGuard, async (req, res) => {
  try {
    const model = await Model.findById(req.params.modelId).select("_id").lean();
    if (!model) return res.status(404).json({ error: "Model not found" });
    const versions = await Version.find({ modelId: model._id }).sort({ versionNumber: -1 });
    res.json({ versions: await presentVersions(versions) });
  } catch (err) {
    serverError(res, err, "Failed to list versions");
  }
});

// ---------------------------------------------------------------------------
// GET /api/versions?status=a,b&q&page&limit   (review queue / needs-review lists)
// ---------------------------------------------------------------------------
const queueSchema = z.object({
  ...paginationFields,
  q: str(100).optional(),
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []))
    .refine((list) => list.every((s) => STATUSES.includes(s)), { message: `must be a comma-separated list of: ${STATUSES.join(", ")}` }),
});

router.get("/versions", authGuard, async (req, res) => {
  try {
    const q = parse(queueSchema, req.query, res);
    if (!q) return;
    const win = pageWindow(q, 20);

    // Only versions of ACTIVE models (never an item whose modelId would populate to null).
    // Done in the query, so total/pagination stay consistent.
    const activeIds = (await Model.find().select("_id").lean()).map((m) => m._id);
    const filter = { modelId: { $in: activeIds } };
    if (q.status && q.status.length) filter.status = { $in: q.status };
    if (q.q) {
      // model-name matches are capped: a vague query must not turn into a huge $in
      const models = await Model.find({ name: { $regex: escapeRegex(q.q), $options: "i" } })
        .select("_id")
        .limit(MODEL_NAME_MATCH_CAP)
        .lean();
      const or = [{ modelId: { $in: models.map((m) => m._id) } }];
      const num = /^v?(\d{1,9})$/i.exec(q.q);
      if (num) or.push({ versionNumber: Number(num[1]) });
      filter.$or = or;
    }

    const [total, versions] = await Promise.all([
      Version.countDocuments(filter),
      Version.find(filter).sort({ createdAt: -1, _id: -1 }).skip(win.skip).limit(win.limit).populate("modelId", "name"),
    ]);
    // a model archived between the id lookup and populate() would leave modelId null: drop it
    res.json(envelope(await presentVersions(versions.filter((v) => v.modelId)), "versions", win, total));
  } catch (err) {
    serverError(res, err, "Failed to list versions");
  }
});

// ---------------------------------------------------------------------------
// GET /api/versions/:id
// ---------------------------------------------------------------------------
router.get("/versions/:id", authGuard, async (req, res) => {
  try {
    const version = await Version.findById(req.params.id).populate("modelId", "name description useCase");
    if (!version || !version.modelId) return notFound(res);

    const snapshots = await MetricSnapshot.find({ versionId: version._id }).sort({ createdAt: 1, _id: 1 });
    const compliance = scoreCompliance(version, snapshots[snapshots.length - 1] || null);

    const names = await nameMap(snapshots.map((s) => s.createdBy));
    res.json({
      version: await presentVersion(version),
      compliance,
      snapshots: snapshots.map((s) => ({ ...s.toJSON(), createdByName: s.createdBy ? names.get(String(s.createdBy)) || null : null })),
    });
  } catch (err) {
    serverError(res, err, "Failed to fetch version");
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/versions/:id/notes  (ml_engineer)   draft | changes_requested
// ---------------------------------------------------------------------------
const notesSchema = z.object({ datasetNotes: str(5000).optional(), trainingNotes: str(5000).optional() });

router.patch("/versions/:id/notes", authGuard, roleGuard(["ml_engineer"]), async (req, res) => {
  try {
    const data = parse(notesSchema, req.body, res);
    if (!data) return;
    const set = {};
    if (data.datasetNotes !== undefined) set.datasetNotes = data.datasetNotes;
    if (data.trainingNotes !== undefined) set.trainingNotes = data.trainingNotes;
    if (!Object.keys(set).length) return res.status(400).json({ error: "Provide datasetNotes and/or trainingNotes" });

    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    if (notOwner(req, res, ctx.version, "edit the notes of")) return;
    const version = await transition(ctx.version._id, ["draft", "changes_requested"], set);
    if (!version) return illegal(res, ctx.version._id, "edit notes of");

    await writeAuditLog({
      actor: req.user,
      action: "update_notes",
      targetType: "Version",
      targetId: version._id,
      details: `Updated ${Object.keys(set).join(" and ")} on "${ctx.model.name}" v${version.versionNumber}`,
    });
    res.json({ version: await presentVersion(version) });
  } catch (err) {
    serverError(res, err, "Failed to update notes");
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/submit | withdraw  (ml_engineer)
// ---------------------------------------------------------------------------
router.post("/versions/:id/submit", authGuard, roleGuard(["ml_engineer"]), async (req, res) => {
  try {
    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    if (notOwner(req, res, ctx.version, "submit")) return;
    const version = await transition(ctx.version._id, ["draft", "changes_requested"], { status: "submitted" });
    if (!version) return illegal(res, ctx.version._id, "submit");

    await writeAuditLog({
      actor: req.user,
      action: "submit_version",
      targetType: "Version",
      targetId: version._id,
      details: `Submitted "${ctx.model.name}" v${version.versionNumber} for review`,
    });
    res.json({ version: await presentVersion(version) });
  } catch (err) {
    serverError(res, err, "Failed to submit version");
  }
});

router.post("/versions/:id/withdraw", authGuard, roleGuard(["ml_engineer"]), async (req, res) => {
  try {
    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    if (notOwner(req, res, ctx.version, "withdraw")) return;
    const version = await transition(ctx.version._id, ["submitted"], { status: "draft" });
    if (!version) return illegal(res, ctx.version._id, "withdraw");

    await writeAuditLog({
      actor: req.user,
      action: "withdraw_version",
      targetType: "Version",
      targetId: version._id,
      details: `Withdrew "${ctx.model.name}" v${version.versionNumber} back to draft`,
    });
    res.json({ version: await presentVersion(version) });
  } catch (err) {
    serverError(res, err, "Failed to withdraw version");
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/review  (compliance_officer)  { decision, comment? }
// ---------------------------------------------------------------------------
const reviewSchema = z.object({
  decision: z.enum(["approve", "reject", "request_changes"], {
    errorMap: () => ({ message: "must be 'approve', 'reject' or 'request_changes'" }),
  }),
  comment: str(2000).optional(),
});
const REVIEW_OUTCOME = {
  approve: { status: "approved", audit: "approve", verb: "Approved" },
  reject: { status: "rejected", audit: "reject", verb: "Rejected" },
  request_changes: { status: "changes_requested", audit: "request_changes", verb: "Requested changes on" },
};

router.post("/versions/:id/review", authGuard, roleGuard(["compliance_officer"]), async (req, res) => {
  try {
    const data = parse(reviewSchema, req.body, res);
    if (!data) return;
    const comment = data.comment || "";

    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    const { version: current, model } = ctx;
    if (current.status !== "submitted") {
      return res.status(400).json({ error: `Version is not awaiting review (status: '${current.status}')`, currentStatus: current.status });
    }

    const highRisk = (current.riskTier || "high") === "high";
    if (!comment && (data.decision !== "approve" || highRisk)) {
      const why = data.decision === "approve" ? "High-risk versions require a documented reviewer comment before they can be approved" : `A comment is required to ${data.decision === "reject" ? "reject" : "request changes on"} a version`;
      return res.status(400).json({ error: why, fields: { comment: "is required" } });
    }

    const outcome = REVIEW_OUTCOME[data.decision];
    const version = await transition(
      current._id,
      ["submitted"],
      { status: outcome.status, reviewComment: comment, reviewedBy: req.user._id, reviewedAt: new Date() },
      { riskTier: current.riskTier } // the high-risk rule was checked against this tier
    );
    if (!version) {
      const now = await Version.findById(current._id).select("status").lean();
      if (!now) return notFound(res);
      return res.status(409).json({ error: `Version is no longer awaiting review (status: '${now.status}')`, currentStatus: now.status });
    }

    await writeAuditLog({
      actor: req.user,
      action: outcome.audit,
      targetType: "Version",
      targetId: version._id,
      details: `${outcome.verb} "${model.name}" v${version.versionNumber}${comment ? ` -- "${comment.slice(0, 300)}"` : ""}`,
    });
    res.json({ version: await presentVersion(version) });
  } catch (err) {
    serverError(res, err, "Failed to review version");
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/deploy  (compliance_officer, admin)  approved -> deployed
// Every other live version of the model becomes `superseded`.
// ---------------------------------------------------------------------------
router.post("/versions/:id/deploy", authGuard, roleGuard(["compliance_officer", "admin"]), async (req, res) => {
  try {
    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    const { version: current, model } = ctx;
    if (current.status !== "approved") {
      return res.status(400).json({ error: `Only approved versions can be deployed (status: '${current.status}')`, currentStatus: current.status });
    }

    // 1. claim the deploy atomically FIRST (status guard): of N concurrent clicks exactly one
    //    proceeds, the rest get 400 without having touched any other version.
    const version = await transition(current._id, ["approved"], { status: "deployed", deployedAt: new Date() });
    if (!version) return illegal(res, current._id, "deploy");

    // 2. supersede the model's older live versions. "Older" = deployed earlier (null = oldest):
    //    two DIFFERENT versions deploying at once would otherwise supersede each other and
    //    leave nothing live. Each one gets its own audit entry.
    const superseded = [];
    const supersede = async (old) => {
      const upd = await transition(old._id, LIVE_STATUSES, { status: "superseded" });
      if (upd) superseded.push(upd);
    };
    const rivals = await Version.find({
      modelId: model._id,
      _id: { $ne: version._id },
      status: { $in: LIVE_STATUSES },
      $or: [{ deployedAt: { $lt: version.deployedAt } }, { deployedAt: null }, { deployedAt: version.deployedAt, _id: { $lt: version._id } }],
    });
    for (const old of rivals) await supersede(old);

    // 3. final reconcile: if a concurrent deploy still left several live versions, the most
    //    recently deployed one (ties: newest id) wins and every other one is superseded.
    const live = await Version.find({ modelId: model._id, status: { $in: LIVE_STATUSES } });
    if (live.length > 1) {
      const rank = (v) => [v.deployedAt ? v.deployedAt.getTime() : -1, String(v._id)];
      live.sort((x, y) => {
        const [xt, xi] = rank(x);
        const [yt, yi] = rank(y);
        return yt - xt || (xi < yi ? 1 : xi > yi ? -1 : 0);
      });
      for (const old of live.slice(1)) await supersede(old);
    }

    for (const old of superseded) {
      await writeAuditLog({
        actor: req.user,
        action: "deploy",
        targetType: "Version",
        targetId: old._id,
        details: `Superseded ${old._id.equals(version._id) ? "by a concurrent deploy of a newer version" : `by v${version.versionNumber}`}`,
      });
    }
    const others = superseded.filter((v) => !v._id.equals(version._id));
    await writeAuditLog({
      actor: req.user,
      action: "deploy",
      targetType: "Version",
      targetId: version._id,
      details: `Deployed "${model.name}" v${version.versionNumber}${others.length ? ` (superseded ${others.map((s) => `v${s.versionNumber}`).join(", ")})` : ""}`,
    });

    if (superseded.some((v) => v._id.equals(version._id))) {
      return res.status(409).json({ error: "A newer version was deployed at the same time and superseded this one" });
    }
    res.json({ version: await presentVersion(version) });
  } catch (err) {
    serverError(res, err, "Failed to deploy version");
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/retire  (compliance_officer, admin)  { comment }
// ---------------------------------------------------------------------------
const commentOnlySchema = z.object({ comment: requiredStr(2000) });

router.post("/versions/:id/retire", authGuard, roleGuard(["compliance_officer", "admin"]), async (req, res) => {
  try {
    const data = parse(commentOnlySchema, req.body, res);
    if (!data) return;
    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    const version = await transition(ctx.version._id, LIVE_STATUSES, { status: "retired" });
    if (!version) return illegal(res, ctx.version._id, "retire");

    await writeAuditLog({
      actor: req.user,
      action: "retire",
      targetType: "Version",
      targetId: version._id,
      details: `Retired "${ctx.model.name}" v${version.versionNumber} -- "${data.comment.slice(0, 300)}"`,
    });
    res.json({ version: await presentVersion(version) });
  } catch (err) {
    serverError(res, err, "Failed to retire version");
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/resolve-review  (compliance_officer, admin)
//   { decision: "keep" | "retire", comment }     needs_review -> deployed | retired
// ---------------------------------------------------------------------------
const resolveSchema = z.object({
  decision: z.enum(["keep", "retire"], { errorMap: () => ({ message: "must be 'keep' or 'retire'" }) }),
  comment: requiredStr(2000),
});

router.post("/versions/:id/resolve-review", authGuard, roleGuard(["compliance_officer", "admin"]), async (req, res) => {
  try {
    const data = parse(resolveSchema, req.body, res);
    if (!data) return;
    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    const to = data.decision === "keep" ? "deployed" : "retired";
    const set = { status: to };
    if (data.decision === "keep") {
      // "Keep" acknowledges the metrics as they are NOW: remember the newest snapshot. It becomes
      // the drift baseline from here on and stops the old flag from counting against compliance.
      const latest = await MetricSnapshot.findOne({ versionId: ctx.version._id }).sort({ createdAt: -1, _id: -1 }).lean();
      Object.assign(set, {
        driftAckAt: new Date(),
        driftAckSnapshotId: latest ? latest._id : null,
        driftAckSnapshotAt: latest ? latest.createdAt : null,
      });
    }
    const version = await transition(ctx.version._id, ["needs_review"], set);
    if (!version) return illegal(res, ctx.version._id, "resolve the review of");

    await writeAuditLog({
      actor: req.user,
      action: "resolve_review",
      targetType: "Version",
      targetId: version._id,
      details: `${data.decision === "keep" ? "Kept deployed" : "Retired"}: "${ctx.model.name}" v${version.versionNumber} after drift review -- "${data.comment.slice(0, 300)}"`,
    });
    res.json({ version: await presentVersion(version) });
  } catch (err) {
    serverError(res, err, "Failed to resolve review");
  }
});

// ---------------------------------------------------------------------------
// Monitoring: shared snapshot recorder for simulated and batch snapshots.
// Evaluates the new metrics with evaluateSnapshot(), stores the snapshot, updates the
// version's CURRENT tier, and flips deployed -> needs_review when it is flagged.
// ---------------------------------------------------------------------------
const snapshotLimitMsg = `Snapshot limit reached (${MAX_SNAPSHOTS} per version)`;

async function liveContext(id) {
  const ctx = await loadActive(id);
  if (!ctx) return { error: [404, "Version not found"] };
  if (!LIVE_STATUSES.includes(ctx.version.status)) {
    return { error: [400, "Only deployed versions can be monitored for drift"] };
  }
  const ackId = ctx.version.driftAckSnapshotId;
  const [original, acknowledged, last, count] = await Promise.all([
    MetricSnapshot.findOne({ versionId: ctx.version._id, isBaseline: true }),
    ackId ? MetricSnapshot.findOne({ _id: ackId, versionId: ctx.version._id }) : null,
    MetricSnapshot.findOne({ versionId: ctx.version._id }).sort({ createdAt: -1, _id: -1 }),
    MetricSnapshot.countDocuments({ versionId: ctx.version._id }),
  ]);
  if (!original || !last) return { error: [400, "No baseline metrics found for this version"] };
  if (count >= MAX_SNAPSHOTS) return { error: [400, snapshotLimitMsg] };
  // drift is measured from the acknowledged snapshot after a "keep"; the original baseline
  // snapshot itself is never modified (history)
  return { ...ctx, baseline: acknowledged || original, last };
}

// Returns { error:[status,msg] } when it cannot record, else { snapshot, version, escalated }.
async function recordSnapshot({ version, model, user, baseline, metrics, evaluation, source, rows }) {
  // cap re-checked right before the insert (the scoring call in between can be slow); a tiny
  // overshoot under heavy concurrency is accepted
  if ((await MetricSnapshot.countDocuments({ versionId: version._id })) >= MAX_SNAPSHOTS) return { error: [400, snapshotLimitMsg] };
  const snapshot = await MetricSnapshot.create({
    versionId: version._id,
    accuracy: metrics.accuracy,
    fairnessGap: metrics.fairnessGap,
    latencyMs: metrics.latencyMs,
    driftDelta: evaluation.driftDelta,
    flagged: evaluation.flagged,
    isBaseline: false,
    riskTier: evaluation.riskTier,
    source,
    rows: rows == null ? null : rows,
    createdBy: user._id,
  });

  // current tier follows the latest snapshot; deployed + flagged -> needs_review
  let updated = null;
  let becameNeedsReview = false;
  if (evaluation.flagged) {
    updated = await transition(version._id, ["deployed"], { riskTier: evaluation.riskTier, status: "needs_review" });
    becameNeedsReview = !!updated;
  }
  if (!updated) updated = await transition(version._id, LIVE_STATUSES, { riskTier: evaluation.riskTier });
  if (!updated) updated = await Version.findById(version._id);
  if (!updated) return { error: [409, "The version was archived while the snapshot was being recorded"] };

  await writeAuditLog({
    actor: user,
    action: source === "batch" ? "monitoring_batch" : "simulate_drift",
    targetType: "Version",
    targetId: version._id,
    details: `${source === "batch" ? "Batch" : "Simulated"} snapshot for "${model.name}" v${version.versionNumber}: accuracy=${metrics.accuracy.toFixed(3)}, drift=${evaluation.driftDelta.toFixed(3)}, tier=${evaluation.riskTier}${source === "batch" && rows != null ? `, rows=${rows}` : ""}${evaluation.flagged ? " (FLAGGED)" : ""}`,
  });
  if (becameNeedsReview) {
    await writeAuditLog({
      actor: user,
      action: "drift_flagged",
      targetType: "Version",
      targetId: version._id,
      details: `"${model.name}" v${version.versionNumber} moved to needs_review (tier ${version.riskTier || "unrated"} -> ${evaluation.riskTier}, accuracy ${metrics.accuracy.toFixed(3)} vs baseline ${baseline.accuracy.toFixed(3)})`,
    });
  }

  return {
    snapshot: { ...snapshot.toJSON(), createdByName: user.name },
    version: await presentVersion(updated),
    escalated: evaluation.escalated,
  };
}

// ---------------------------------------------------------------------------
// POST /api/versions/:id/simulate-drift  (any authenticated role)
// "Time passing" for demos: gated by ENABLE_DRIFT_SIMULATION and capped per version.
// ---------------------------------------------------------------------------
router.post("/versions/:id/simulate-drift", authGuard, async (req, res) => {
  try {
    if (!env.enableDriftSimulation) return res.status(403).json({ error: "Drift simulation is disabled on this deployment" });
    const ctx = await liveContext(req.params.id);
    if (ctx.error) return res.status(ctx.error[0]).json({ error: ctx.error[1] });
    const { version, model, baseline, last } = ctx;

    // thresholds come from version.thresholdsUsed inside evaluateSnapshot (null fields ignored)
    const next = nextSnapshot(baseline, last, null, version);
    const result = await recordSnapshot({
      version,
      model,
      user: req.user,
      baseline,
      metrics: { accuracy: next.accuracy, fairnessGap: next.fairnessGap, latencyMs: next.latencyMs },
      evaluation: next,
      source: "simulated",
      rows: last.rows,
    });
    if (result.error) return res.status(result.error[0]).json({ error: result.error[1] });
    res.status(201).json(result);
  } catch (err) {
    serverError(res, err, "Failed to simulate drift");
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/monitoring-batch  (any authenticated role)
// multipart: file (predictions CSV), optional latencyMs. Real re-score via the metrics
// service; the file is never kept.
// ---------------------------------------------------------------------------
const batchFieldsSchema = z.object({ latencyMs: z.string().optional() });

router.post("/versions/:id/monitoring-batch", authGuard, uploadBatchFile, async (req, res) => {
  respondAfterCleanup(res, () => uploadedFiles(req)); // the batch file is never kept
  try {
    const fields = parse(batchFieldsSchema, req.body, res);
    if (!fields) return;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "A predictions CSV ('file') is required" });
    if (ext(file) !== ".csv") return res.status(400).json({ error: "The monitoring batch must be a .csv file" });

    let latency = null;
    if (fields.latencyMs !== undefined && fields.latencyMs.trim() !== "") {
      latency = parseLatency(fields.latencyMs);
      if (latency === null) return res.status(400).json({ error: `latencyMs: ${LATENCY_MSG}`, fields: { latencyMs: LATENCY_MSG } });
    }

    const ctx = await liveContext(req.params.id);
    if (ctx.error) return res.status(ctx.error[0]).json({ error: ctx.error[1] });
    const { version, model, baseline, last } = ctx;

    let computed;
    try {
      computed = await computeMetrics({ fileType: "csv", primaryFilePath: file.path, datasetFilePath: null });
    } catch (err) {
      const failure = classifyFailure(err);
      return res.status(failure.retryable ? 503 : 400).json({ error: failure.uploadError, retryable: failure.retryable });
    }

    const metrics = { accuracy: computed.accuracy, fairnessGap: computed.fairnessGap, latencyMs: latency != null ? latency : last.latencyMs };
    const evaluation = evaluateSnapshot({ baseline, metrics, version, thresholds: null });
    const result = await recordSnapshot({
      version,
      model,
      user: req.user,
      baseline,
      metrics,
      evaluation,
      source: "batch",
      rows: computed.rows,
    });
    if (result.error) return res.status(result.error[0]).json({ error: result.error[1] });
    res.status(201).json({ ...result, warnings: computed.warnings || [] });
  } catch (err) {
    serverError(res, err, "Failed to score monitoring batch");
  } finally {
    await removeFiles(uploadedFiles(req)); // always discarded
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/versions/:id  (owner ml_engineer or admin)  -> archive
// ---------------------------------------------------------------------------
const reasonSchema = z.object({ reason: str(500).optional() });

router.delete("/versions/:id", authGuard, roleGuard(["ml_engineer", "admin"]), async (req, res) => {
  try {
    const data = parse(reasonSchema, req.body, res);
    if (!data) return;
    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    const { version: current, model } = ctx;
    if (req.user.role === "ml_engineer" && String(current.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ error: "Only the engineer who uploaded this version (or an admin) can archive it" });
    }

    const reason = data.reason || "";
    const archived = await Version.findOneAndUpdate(
      { _id: current._id, status: { $in: ARCHIVABLE } },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user._id, deleteReason: reason, deletedByCascade: false } },
      { new: true }
    );
    if (!archived) {
      const now = await Version.findById(current._id).select("status").lean();
      if (!now) return notFound(res);
      return res.status(409).json({
        error: `A version with status '${now.status}' cannot be archived (only ${ARCHIVABLE.join(", ")})`,
        currentStatus: now.status,
      });
    }

    await writeAuditLog({
      actor: req.user,
      action: "archive_version",
      targetType: "Version",
      targetId: current._id,
      details: `Archived "${model.name}" v${current.versionNumber}${reason ? ` -- ${reason}` : ""}`,
    });
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err, "Failed to archive version");
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/restore  (admin or owner ml_engineer)
// ---------------------------------------------------------------------------
router.post("/versions/:id/restore", authGuard, roleGuard(["ml_engineer", "admin"]), async (req, res) => {
  try {
    const current = await Version.findById(req.params.id).setOptions({ includeDeleted: true });
    if (!current) return notFound(res);
    if (req.user.role === "ml_engineer" && String(current.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ error: "Only the engineer who uploaded this version (or an admin) can restore it" });
    }
    if (!current.isDeleted) return res.status(409).json({ error: "Version is not archived" });

    const model = await Model.findById(current.modelId);
    if (!model) return res.status(409).json({ error: "The parent model is archived -- restore the model first" });

    const restored = await Version.findOneAndUpdate({ _id: current._id, isDeleted: true }, { $set: CLEAR_ARCHIVE }, { new: true });
    if (!restored) return res.status(409).json({ error: "Version is not archived" });

    await writeAuditLog({
      actor: req.user,
      action: "restore_version",
      targetType: "Version",
      targetId: current._id,
      details: `Restored "${model.name}" v${current.versionNumber} (status '${restored.status}')`,
    });
    res.json({ ok: true, version: await presentVersion(restored) });
  } catch (err) {
    serverError(res, err, "Failed to restore version");
  }
});

// ---------------------------------------------------------------------------
// GET /api/versions/:id/file?which=model|dataset   (any authenticated role)
// ---------------------------------------------------------------------------
const fileQuerySchema = z.object({ which: z.enum(["model", "dataset"]).optional() });

router.get("/versions/:id/file", authGuard, async (req, res) => {
  try {
    const q = parse(fileQuerySchema, req.query, res);
    if (!q) return;
    const which = q.which || "model";
    const ctx = await loadActive(req.params.id);
    if (!ctx) return notFound(res);
    const { version, model } = ctx;

    const stored = which === "dataset" ? version.datasetPath : version.filePath;
    const root = path.resolve(env.uploadDir) + path.sep;
    // the stored path is server-written, but never serve anything outside the upload dir anyway
    if (!stored || !path.resolve(stored).startsWith(root) || !fileExists(stored)) {
      return res.status(404).json({ error: "File not retained" });
    }

    const original = which === "dataset" ? version.datasetFileName : version.fileName;
    const name = sanitizeDownloadName(original, `${model.name}-v${version.versionNumber}-${which}${path.extname(stored)}`.replace(/\s+/g, "_"));

    await writeAuditLog({
      actor: req.user,
      action: "download_file",
      targetType: "Version",
      targetId: version._id,
      details: `Downloaded ${which} file of "${model.name}" v${version.versionNumber}`,
    });

    res.download(stored, name, { dotfiles: "allow" }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "File not retained" });
    });
  } catch (err) {
    serverError(res, err, "Failed to download file");
  }
});

module.exports = router;
