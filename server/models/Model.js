const mongoose = require("mongoose");
const softDelete = require("../utils/softDelete");
const { tenantPlugin } = require("../utils/tenant");

// The registered AI model being governed (not to be confused with a Mongoose "model").
// Deliberately has NO riskTier field -- risk is a property of a measured Version,
// never a claim made by the uploader at registration time.
const modelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: "", maxlength: 2000 },
  useCase: { type: String, default: "", maxlength: 200 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  // Atomic per-model counter for Version.versionNumber (never decremented, so
  // archiving a version can't cause a number to be handed out twice).
  versionSeq: { type: Number, default: 0 },
}, { timestamps: { createdAt: true, updatedAt: false } });

modelSchema.plugin(softDelete);
modelSchema.plugin(tenantPlugin);

// Names are unique case-insensitively PER ORGANIZATION among non-archived models only, so an
// archived name can be reused and two companies may both have a "Credit Scorer".
// Created by migrations.ensureIndexes() (autoIndex is off).
modelSchema.index(
  { orgId: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 }, partialFilterExpression: { isDeleted: false } }
);
modelSchema.index({ createdAt: -1 });

modelSchema.set("toJSON", {
  transform(doc, ret) {
    delete ret.__v;
    // internals: the counter and soft-delete bookkeeping (routes/trash.js builds the admin view itself)
    for (const k of ["versionSeq", "isDeleted", "deletedAt", "deletedBy", "deletedByCascade", "deleteReason"]) delete ret[k];
    return ret;
  },
});

module.exports = mongoose.model("Model", modelSchema);
