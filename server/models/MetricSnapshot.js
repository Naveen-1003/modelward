const mongoose = require("mongoose");
const { RISK_TIERS } = require("./Version");
const { tenantPlugin } = require("../utils/tenant");

const SNAPSHOT_SOURCES = ["baseline", "simulated", "batch"];

// The first snapshot created at upload time is the baseline for drift comparisons.
// Snapshots follow their version (no soft delete of their own).
const metricSnapshotSchema = new mongoose.Schema({
  versionId: { type: mongoose.Schema.Types.ObjectId, ref: "Version", required: true },
  accuracy: { type: Number, required: true },
  fairnessGap: { type: Number, required: true },
  latencyMs: { type: Number, default: null },
  driftDelta: { type: Number, default: 0 },
  flagged: { type: Boolean, default: false },
  isBaseline: { type: Boolean, default: false },
  riskTier: { type: String, enum: [...RISK_TIERS, null], default: null }, // tier at the time of this snapshot
  source: { type: String, enum: SNAPSHOT_SOURCES, default: "baseline" },
  rows: { type: Number, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

metricSnapshotSchema.plugin(tenantPlugin);

metricSnapshotSchema.index({ versionId: 1, createdAt: 1 });

metricSnapshotSchema.set("toJSON", {
  transform(doc, ret) {
    delete ret.__v;
    delete ret.createdBy; // routes expose createdByName instead
    return ret;
  },
});

module.exports = mongoose.model("MetricSnapshot", metricSnapshotSchema);
module.exports.SNAPSHOT_SOURCES = SNAPSHOT_SOURCES;
