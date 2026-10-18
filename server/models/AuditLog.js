const mongoose = require("mongoose");
const ACTIONS = require("../utils/auditActions");

// Append-only, hash-chained log. Entries written before the chain existed have no
// seq/hash ("legacy, unchained") and are never modified.
const auditLogSchema = new mongoose.Schema({
  seq: { type: Number }, // unique+sparse index below; the chain position
  prevHash: { type: String },
  hash: { type: String },
  hashAlg: { type: String, enum: ["sha256", "hmac-sha256"] }, // absent on rows from before AUDIT_HMAC_KEY existed => sha256
  actorName: { type: String, required: true }, // snapshot: the user's name may change later
  actorRole: { type: String, required: true }, // "none" for anonymous (failed logins)
  actorId: { type: mongoose.Schema.Types.ObjectId },
  action: { type: String, enum: ACTIONS, required: true },
  targetType: { type: String, required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId }, // optional (e.g. failed login for unknown email)
  details: { type: String, default: "", maxlength: 2000 },
  createdAt: { type: Date, required: true, default: Date.now }, // set explicitly before hashing
});

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ seq: 1 }, { unique: true, sparse: true });
auditLogSchema.index({ targetId: 1 });
auditLogSchema.index({ actorId: 1 });

// --- immutability --------------------------------------------------------
function immutable() {
  throw new Error("AUDIT_LOG_IMMUTABLE: audit log entries cannot be modified or deleted");
}
[
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne",
  "deleteOne", "deleteMany", "findOneAndDelete",
].forEach((op) => auditLogSchema.pre(op, { document: false, query: true }, immutable));
auditLogSchema.pre("deleteOne", { document: true, query: false }, immutable);
auditLogSchema.pre("save", function blockResave() {
  if (!this.isNew) immutable();
});
auditLogSchema.pre("bulkWrite", immutable);
auditLogSchema.pre("remove", immutable); // legacy document middleware name; harmless on Mongoose 8

module.exports = mongoose.model("AuditLog", auditLogSchema);
module.exports.ACTIONS = ACTIONS;
