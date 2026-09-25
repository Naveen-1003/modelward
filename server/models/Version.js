const mongoose = require("mongoose");

const STATUSES = ["draft", "submitted", "approved", "rejected", "deployed", "upload_failed"];
const FILE_TYPES = ["csv", "pickle", "joblib"];
const RISK_TIERS = ["low", "medium", "high"];

const versionSchema = new mongoose.Schema({
  modelId: { type: mongoose.Schema.Types.ObjectId, ref: "Model", required: true, index: true },
  versionNumber: { type: Number, required: true },
  fileType: { type: String, enum: FILE_TYPES, required: true },
  filePath: { type: String, default: null },
  datasetPath: { type: String, default: null }, // companion dataset, only for pickle/joblib
  datasetNotes: { type: String, default: "" },
  trainingNotes: { type: String, default: "" },
  status: { type: String, enum: STATUSES, default: "draft" },
  metrics: {
    accuracy: { type: Number, default: null },
    fairnessGap: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
    computedBy: { type: String, enum: ["self_reported", "microservice", null], default: null },
  },
  // Computed server-side by utils/riskTier.js right after the microservice responds.
  // Never accept this from the client.
  riskTier: { type: String, enum: [...RISK_TIERS, null], default: null },
  uploadError: { type: String, default: null }, // set only when status = "upload_failed"
  reviewComment: { type: String, default: "" },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

module.exports = mongoose.model("Version", versionSchema);
module.exports.STATUSES = STATUSES;
module.exports.FILE_TYPES = FILE_TYPES;
module.exports.RISK_TIERS = RISK_TIERS;
