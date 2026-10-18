const mongoose = require("mongoose");
const softDelete = require("../utils/softDelete");

const STATUSES = [
  "draft",
  "submitted",
  "changes_requested",
  "approved",
  "rejected",
  "deployed",
  "needs_review",
  "superseded",
  "retired",
  "upload_failed",
];
// "Live" = currently serving: at most one per model (deploy supersedes the rest).
const LIVE_STATUSES = ["deployed", "needs_review"];
const FILE_TYPES = ["csv", "pickle", "joblib"];
const RISK_TIERS = ["low", "medium", "high"];
const RETRY_CLAIM_TTL_MS = 5 * 60 * 1000;

const groupSchema = new mongoose.Schema({
  group: { type: String, default: "" },
  count: { type: Number, default: null },
  accuracy: { type: Number, default: null },
  positiveRate: { type: Number, default: null },
  tpr: { type: Number, default: null },
}, { _id: false });

const num = { type: Number, default: null };

const versionSchema = new mongoose.Schema({
  modelId: { type: mongoose.Schema.Types.ObjectId, ref: "Model", required: true },
  versionNumber: { type: Number, required: true },
  fileType: { type: String, enum: FILE_TYPES, required: true },
  filePath: { type: String, default: null },    // never serialised (see toJSON)
  datasetPath: { type: String, default: null }, // companion dataset, only for pickle/joblib; never serialised
  fileName: { type: String, default: null },        // original upload name, for display + download
  datasetFileName: { type: String, default: null },
  datasetNotes: { type: String, default: "", maxlength: 5000 },
  trainingNotes: { type: String, default: "", maxlength: 5000 },
  status: { type: String, enum: STATUSES, default: "draft" },
  metrics: {
    accuracy: num,
    fairnessGap: num,
    latencyMs: num,
    computedBy: { type: String, enum: ["self_reported", "microservice", null], default: null },
    rows: num,
    demographicParityDiff: num,
    equalOpportunityDiff: num,
    disparateImpactRatio: num,
    precision: num,
    recall: num,
    f1: num,
    auc: num,
    groups: { type: [groupSchema], default: [] },
  },
  scoringWarnings: { type: [String], default: [] },
  // Computed server-side by utils/riskTier.js. Never accept this from the client.
  riskTier: { type: String, enum: [...RISK_TIERS, null], default: null },        // CURRENT tier (re-evaluated per snapshot)
  initialRiskTier: { type: String, enum: [...RISK_TIERS, null], default: null }, // tier at upload
  // The admin-configurable thresholds in force when this version was scored.
  thresholdsUsed: {
    lowAccuracy: num,
    lowFairnessGap: num,
    mediumAccuracy: num,
    mediumFairnessGap: num,
    driftThreshold: num,
  },
  uploadError: { type: String, default: null }, // set only when status = "upload_failed"
  retryable: { type: Boolean, default: false },
  // Set while a retry is scoring (retryable is flipped to false as the claim). A claim older
  // than RETRY_CLAIM_TTL_MS counts as abandoned (server crashed mid-scoring) and may be re-claimed.
  retryClaimedAt: { type: Date, default: null },
  reviewComment: { type: String, default: "" },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  deployedAt: { type: Date, default: null },
  // "Keep deployed" after a drift flag = compliance accepted the metrics as of that moment:
  // the acknowledged snapshot becomes the drift baseline and older flags stop counting against
  // compliance. Only driftAckAt is exposed in JSON; the snapshot id/time stay internal.
  driftAckAt: { type: Date, default: null },
  driftAckSnapshotId: { type: mongoose.Schema.Types.ObjectId, ref: "MetricSnapshot", default: null },
  driftAckSnapshotAt: { type: Date, default: null },
}, { timestamps: true });

versionSchema.plugin(softDelete);

versionSchema.index({ modelId: 1, versionNumber: 1 }, { unique: true });
versionSchema.index({ status: 1, createdAt: -1 });

const INTERNAL_FIELDS = [
  "isDeleted", "deletedAt", "deletedBy", "deletedByCascade", "deleteReason",
  "retryClaimedAt", "driftAckSnapshotId", "driftAckSnapshotAt",
];

versionSchema.set("toJSON", {
  transform(doc, ret) {
    ret.hasFile = !!ret.filePath;
    ret.hasDataset = !!ret.datasetPath;
    delete ret.filePath;
    delete ret.datasetPath;
    delete ret.__v;
    // internals: soft-delete bookkeeping (see routes/trash.js for the admin view), retry claim, ack ids
    for (const k of INTERNAL_FIELDS) delete ret[k];
    if (ret.createdBy && typeof ret.createdBy === "object" && ret.createdBy._bsontype) ret.createdBy = String(ret.createdBy);
    return ret;
  },
});

module.exports = mongoose.model("Version", versionSchema);
module.exports.STATUSES = STATUSES;
module.exports.LIVE_STATUSES = LIVE_STATUSES;
module.exports.FILE_TYPES = FILE_TYPES;
module.exports.RISK_TIERS = RISK_TIERS;
module.exports.RETRY_CLAIM_TTL_MS = RETRY_CLAIM_TTL_MS;
