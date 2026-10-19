const mongoose = require("mongoose");

// One company on the platform. The tenant root: it is NOT tenant-scoped itself
// (every other collection carries `orgId` pointing here).
//
// Join codes: two per organization; the code decides the role of whoever joins with it.
// `value` is 12 chars of an unambiguous alphabet (utils/joinCodes.js), stored normalized
// (no dashes). `used` counts seats taken (never above `seatLimit`); `gen` is bumped every
// time the code is regenerated so a late seat release for an old code is a no-op.
const codeSchema = new mongoose.Schema({
  value: { type: String, required: true },
  expiresAt: { type: Date, default: null },
  seatLimit: { type: Number, default: null, min: 1 },
  used: { type: Number, default: 0, min: 0 },
  gen: { type: Number, default: 1 },
}, { _id: false });

const orgSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  address: { type: String, default: "", trim: true, maxlength: 300 },
  contactEmail: { type: String, default: "", trim: true, lowercase: true, maxlength: 254 }, // the first admin's email
  // Exact-match email domains (lowercase, no "@"). Subdomains only count if listed.
  allowedDomains: { type: [String], default: [] },
  // false => no domain restriction: signup still needs email verification AND manual approval.
  domainRuleEnabled: { type: Boolean, default: true },
  // A verified address on an allowed domain is approved automatically. Only meaningful
  // while domainRuleEnabled is true; the routes keep the two consistent.
  autoApprove: { type: Boolean, default: false },
  status: { type: String, enum: ["active", "suspended"], default: "active" },
  codes: {
    ml_engineer: { type: codeSchema, required: true },
    compliance_officer: { type: codeSchema, required: true },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: { createdAt: true, updatedAt: true } });

orgSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
orgSchema.index({ "codes.ml_engineer.value": 1 }, { unique: true });
orgSchema.index({ "codes.compliance_officer.value": 1 }, { unique: true });

module.exports = mongoose.model("Organization", orgSchema);
