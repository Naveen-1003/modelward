const express = require("express");
const fs = require("fs");
const Model = require("../models/Model");
const Version = require("../models/Version");
const MetricSnapshot = require("../models/MetricSnapshot");
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const writeAuditLog = require("../middleware/audit");
const upload = require("../middleware/upload");
const computeMetrics = require("../utils/metricsClient");
const computeRiskTier = require("../utils/riskTier");
const scoreCompliance = require("../utils/compliance");
const nextSnapshot = require("../utils/drift");

const router = express.Router();

const FILE_TYPES = ["csv", "pickle", "joblib"];

function cleanupFiles(files) {
  Object.values(files || {}).flat().forEach((f) => {
    fs.unlink(f.path, () => {});
  });
}

// ---------------------------------------------------------------------------
// POST /api/models/:modelId/versions  (ml_engineer)
// ---------------------------------------------------------------------------
router.post(
  "/models/:modelId/versions",
  authGuard,
  roleGuard(["ml_engineer"]),
  upload,
  async (req, res) => {
    const files = req.files || {};
    try {
      const model = await Model.findById(req.params.modelId);
      if (!model) {
        cleanupFiles(files);
        return res.status(404).json({ error: "Model not found" });
      }

      const { fileType, datasetNotes, trainingNotes, latencyMs } = req.body;
      if (!FILE_TYPES.includes(fileType)) {
        cleanupFiles(files);
        return res.status(400).json({ error: `fileType must be one of: ${FILE_TYPES.join(", ")}` });
      }

      const primaryFile = files.file && files.file[0];
      if (!primaryFile) {
        cleanupFiles(files);
        return res.status(400).json({ error: "A primary file ('file') is required" });
      }

      const datasetFile = files.datasetFile && files.datasetFile[0];
      if (fileType !== "csv" && !datasetFile) {
        cleanupFiles(files);
        return res.status(400).json({
          error: "A companion dataset CSV ('datasetFile') is required when fileType is pickle or joblib",
        });
      }

      if (fileType === "csv" && (latencyMs === undefined || latencyMs === "" || isNaN(Number(latencyMs)))) {
        cleanupFiles(files);
        return res.status(400).json({ error: "latencyMs (a number) is required and self-reported when fileType is csv" });
      }

      const versionNumber = (await Version.countDocuments({ modelId: model._id })) + 1;

      // Attempt to score the upload. Everything from here on results in a saved
      // Version -- either fully scored, or explicitly marked upload_failed with
      // a human-readable reason. Never let a scoring error bubble up as a 500.
      let metrics = null;
      let riskTier = null;
      let status = "draft";
      let uploadError = null;

      try {
        const computed = await computeMetrics({
          fileType,
          primaryFilePath: primaryFile.path,
          datasetFilePath: datasetFile ? datasetFile.path : null,
        });

        metrics = {
          accuracy: computed.accuracy,
          fairnessGap: computed.fairnessGap,
          // for csv, latency is self-reported by the uploader (no real inference happens);
          // for pickle/joblib, it's measured for real by the microservice.
          latencyMs: fileType === "csv" ? Number(latencyMs) : computed.latencyMs,
          computedBy: fileType === "csv" ? "self_reported" : "microservice",
        };

        riskTier = computeRiskTier(metrics);
      } catch (err) {
        status = "upload_failed";
        uploadError = err.message;
      }

      const version = await Version.create({
        modelId: model._id,
        versionNumber,
        fileType,
        filePath: primaryFile.path,
        datasetPath: datasetFile ? datasetFile.path : null,
        datasetNotes: datasetNotes || "",
        trainingNotes: trainingNotes || "",
        status,
        metrics: metrics || {},
        riskTier,
        uploadError,
        createdBy: req.user._id,
      });

      if (metrics) {
        await MetricSnapshot.create({
          versionId: version._id,
          accuracy: metrics.accuracy,
          fairnessGap: metrics.fairnessGap,
          latencyMs: metrics.latencyMs,
          driftDelta: 0,
          flagged: false,
          isBaseline: true,
        });
      }

      await writeAuditLog({
        actor: req.user,
        action: "upload_version",
        targetType: "Version",
        targetId: version._id,
        details:
          status === "upload_failed"
            ? `Upload failed for "${model.name}" v${versionNumber}: ${uploadError}`
            : `Uploaded "${model.name}" v${versionNumber} (${fileType}), risk tier: ${riskTier}`,
      });

      // 201 either way -- the Version row was created either way, just flagged
      // as upload_failed when scoring didn't succeed (see uploadError on it).
      res.status(201).json({ version });
    } catch (err) {
      cleanupFiles(files);
      res.status(500).json({ error: "Failed to upload version", details: err.message });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/models/:modelId/versions
// ---------------------------------------------------------------------------
router.get("/models/:modelId/versions", authGuard, async (req, res) => {
  try {
    const versions = await Version.find({ modelId: req.params.modelId }).sort({ versionNumber: -1 });
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: "Failed to list versions", details: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/versions/:id
// ---------------------------------------------------------------------------
router.get("/versions/:id", authGuard, async (req, res) => {
  try {
    const version = await Version.findById(req.params.id).populate("modelId", "name description useCase");
    if (!version) return res.status(404).json({ error: "Version not found" });

    const snapshots = await MetricSnapshot.find({ versionId: version._id }).sort({ createdAt: 1 });
    const compliance = scoreCompliance(version);

    res.json({ version, compliance, snapshots });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch version", details: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/submit  (ml_engineer)   draft -> submitted
// ---------------------------------------------------------------------------
router.post("/versions/:id/submit", authGuard, roleGuard(["ml_engineer"]), async (req, res) => {
  try {
    const version = await Version.findById(req.params.id);
    if (!version) return res.status(404).json({ error: "Version not found" });
    if (version.status !== "draft") {
      return res.status(400).json({ error: `Cannot submit a version with status '${version.status}'` });
    }

    version.status = "submitted";
    await version.save();

    await writeAuditLog({
      actor: req.user,
      action: "submit_version",
      targetType: "Version",
      targetId: version._id,
      details: `Submitted version ${version.versionNumber} for review`,
    });

    res.json({ version });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit version", details: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/review  (compliance_officer)  { decision, comment }
// ---------------------------------------------------------------------------
router.post("/versions/:id/review", authGuard, roleGuard(["compliance_officer"]), async (req, res) => {
  try {
    const { decision, comment } = req.body;
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
    }

    const version = await Version.findById(req.params.id);
    if (!version) return res.status(404).json({ error: "Version not found" });
    if (version.status !== "submitted") {
      return res.status(400).json({ error: `Version is not awaiting review (status: '${version.status}')` });
    }

    const hasComment = !!comment && comment.trim().length > 0;
    if (decision === "approve" && version.riskTier === "high" && !hasComment) {
      return res.status(400).json({
        error: "High-risk versions require a documented, non-empty reviewer comment before they can be approved",
      });
    }

    version.status = decision === "approve" ? "approved" : "rejected";
    version.reviewComment = comment || "";
    version.reviewedBy = req.user._id;
    await version.save();

    await writeAuditLog({
      actor: req.user,
      action: decision === "approve" ? "approve" : "reject",
      targetType: "Version",
      targetId: version._id,
      details: `${decision === "approve" ? "Approved" : "Rejected"} version ${version.versionNumber}${
        comment ? ` -- "${comment}"` : ""
      }`,
    });

    res.json({ version });
  } catch (err) {
    res.status(500).json({ error: "Failed to review version", details: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/deploy  (compliance_officer, admin)  approved -> deployed
// ---------------------------------------------------------------------------
router.post("/versions/:id/deploy", authGuard, roleGuard(["compliance_officer", "admin"]), async (req, res) => {
  try {
    const version = await Version.findById(req.params.id);
    if (!version) return res.status(404).json({ error: "Version not found" });
    if (version.status !== "approved") {
      return res.status(400).json({ error: `Only approved versions can be deployed (status: '${version.status}')` });
    }

    version.status = "deployed";
    await version.save();

    await writeAuditLog({
      actor: req.user,
      action: "deploy",
      targetType: "Version",
      targetId: version._id,
      details: `Deployed version ${version.versionNumber}`,
    });

    res.json({ version });
  } catch (err) {
    res.status(500).json({ error: "Failed to deploy version", details: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/versions/:id/simulate-drift  (any authenticated role)
// Deliberately open to every role -- it represents "time passing" for the demo,
// not a real governance action, so it's exempt from roleGuard on purpose.
// ---------------------------------------------------------------------------
router.post("/versions/:id/simulate-drift", authGuard, async (req, res) => {
  try {
    const version = await Version.findById(req.params.id);
    if (!version) return res.status(404).json({ error: "Version not found" });
    if (version.status !== "deployed") {
      return res.status(400).json({ error: "Only deployed versions can be monitored for drift" });
    }

    const baseline = await MetricSnapshot.findOne({ versionId: version._id, isBaseline: true });
    const last = await MetricSnapshot.findOne({ versionId: version._id }).sort({ createdAt: -1 });
    if (!baseline || !last) {
      return res.status(400).json({ error: "No baseline metrics found for this version" });
    }

    const next = nextSnapshot(baseline, last);
    const snapshot = await MetricSnapshot.create({
      versionId: version._id,
      accuracy: next.accuracy,
      fairnessGap: next.fairnessGap,
      latencyMs: next.latencyMs,
      driftDelta: next.driftDelta,
      flagged: next.flagged,
      isBaseline: false,
    });

    await writeAuditLog({
      actor: req.user,
      action: "simulate_drift",
      targetType: "Version",
      targetId: version._id,
      details: `New snapshot for version ${version.versionNumber}: accuracy=${next.accuracy.toFixed(3)}, drift=${next.driftDelta.toFixed(3)}${next.flagged ? " (FLAGGED)" : ""}`,
    });

    res.status(201).json({ snapshot });
  } catch (err) {
    res.status(500).json({ error: "Failed to simulate drift", details: err.message });
  }
});

module.exports = router;
