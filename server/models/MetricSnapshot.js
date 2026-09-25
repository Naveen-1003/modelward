const mongoose = require("mongoose");

// The first snapshot created at upload time is the baseline for drift comparisons.
const metricSnapshotSchema = new mongoose.Schema({
  versionId: { type: mongoose.Schema.Types.ObjectId, ref: "Version", required: true, index: true },
  accuracy: { type: Number, required: true },
  fairnessGap: { type: Number, required: true },
  latencyMs: { type: Number, default: null },
  driftDelta: { type: Number, default: 0 },
  flagged: { type: Boolean, default: false },
  isBaseline: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model("MetricSnapshot", metricSnapshotSchema);
