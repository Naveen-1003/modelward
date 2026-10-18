const mongoose = require("mongoose");

// Singleton: exactly one document, identified by the fixed key "global".
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: "global" },
  lowAccuracy: { type: Number, required: true, min: 0.001, max: 1 },
  lowFairnessGap: { type: Number, required: true, min: 0.001, max: 1 },
  mediumAccuracy: { type: Number, required: true, min: 0.001, max: 1 },
  mediumFairnessGap: { type: Number, required: true, min: 0.001, max: 1 },
  driftThreshold: { type: Number, required: true, min: 0.001, max: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: { createdAt: true, updatedAt: true } });

module.exports = mongoose.model("Settings", settingsSchema);
