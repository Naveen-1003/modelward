const mongoose = require("mongoose");
const { tenantPlugin } = require("../utils/tenant");

// One document per organization (the plugin's orgId is unique here).
const settingsSchema = new mongoose.Schema({
  lowAccuracy: { type: Number, required: true, min: 0.001, max: 1 },
  lowFairnessGap: { type: Number, required: true, min: 0.001, max: 1 },
  mediumAccuracy: { type: Number, required: true, min: 0.001, max: 1 },
  mediumFairnessGap: { type: Number, required: true, min: 0.001, max: 1 },
  driftThreshold: { type: Number, required: true, min: 0.001, max: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: { createdAt: true, updatedAt: true } });

settingsSchema.plugin(tenantPlugin, { unique: true });

module.exports = mongoose.model("Settings", settingsSchema);
