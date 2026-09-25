const mongoose = require("mongoose");

const ACTIONS = [
  "create_model",
  "upload_version",
  "submit_version",
  "approve",
  "reject",
  "deploy",
  "simulate_drift",
];

const auditLogSchema = new mongoose.Schema({
  actorName: { type: String, required: true },
  actorRole: { type: String, required: true },
  action: { type: String, enum: ACTIONS, required: true },
  targetType: { type: String, required: true }, // "Model" | "Version"
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  details: { type: String, default: "" },
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model("AuditLog", auditLogSchema);
module.exports.ACTIONS = ACTIONS;
