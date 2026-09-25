const mongoose = require("mongoose");

const ROLES = ["admin", "ml_engineer", "compliance_officer"];

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return { id: this._id, name: this.name, email: this.email, role: this.role, createdAt: this.createdAt };
};

module.exports = mongoose.model("User", userSchema);
module.exports.ROLES = ROLES;
