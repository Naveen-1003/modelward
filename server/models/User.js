const mongoose = require("mongoose");
const { tenantPlugin } = require("../utils/tenant");
const { normalizeEmail } = require("../utils/identity");

// Organization roles: the only ones signup (via join code) or Add user can assign.
const ROLES = ["admin", "ml_engineer", "compliance_officer"];
// The schema enum also knows the platform owner, who belongs to no organization.
const ALL_ROLES = [...ROLES, "super_admin"];
// active    = may sign in
// unverified= signed up, email link not clicked yet     pending = verified, waiting for admin approval
// invited   = created by an admin / super admin, has not set a password yet
const STATUSES = ["active", "unverified", "pending", "invited"];
const SEAT_KINDS = ["ml_engineer", "compliance_officer"];

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  // normalizeEmail(email): "one person, one account" key (lowercase, "+tag" stripped). Set in the
  // pre-validate hook. Sparse so legacy rows without it do not collide before the migration.
  emailKey: { type: String, unique: true, sparse: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ALL_ROLES, required: true },
  // Deactivation blocks login and any existing token immediately; the user row
  // (and everything it authored) stays so the audit trail remains intact.
  isActive: { type: Boolean, default: true },
  status: { type: String, enum: STATUSES, default: "active" },
  // The join-code seat this account holds (released when the account is rejected / expires).
  seatKind: { type: String, enum: [...SEAT_KINDS, null], default: null },
  seatGen: { type: Number, default: null },
  // One-time link secrets: only hashes are stored and they are never selected or serialized.
  verifyTokenHash: { type: String, select: false },
  verifyExpiresAt: { type: Date },
  setupTokenHash: { type: String, select: false },
  setupExpiresAt: { type: Date },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Registered BEFORE the tenant plugin so they run before it fills orgId from the context.
userSchema.pre("validate", function prepareUser(next) {
  // Only when the key can actually change: the migration leaves a "+tag" row whose plain twin already
  // exists with its full address as key; recomputing it on every save() (rename, role change,
  // deactivate) would hit the unique index and turn those edits into a 500.
  if (this.email && (this.isNew || this.isModified("email") || !this.emailKey)) this.emailKey = normalizeEmail(this.email);
  // The platform owner never belongs to an organization, whatever context created it.
  if (this.role === "super_admin") this.orgId = null;
  next();
});

// orgId is optional at the schema level (super_admin has none); the rule lives here.
userSchema.plugin(tenantPlugin, { optionalOrg: true });

userSchema.pre("validate", function requireOrg(next) {
  if (this.role !== "super_admin" && !this.orgId) this.invalidate("orgId", "Organization is required");
  next();
});

userSchema.methods.toSafeJSON = function toSafeJSON(extra = {}) {
  const out = {
    id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    isActive: this.isActive !== false,
    orgId: this.orgId || null,
    status: this.status || "active",
    createdAt: this.createdAt,
  };
  if (extra && extra.orgName !== undefined) out.orgName = extra.orgName;
  return out;
};

// Even an accidental res.json(user) must not leak link secrets.
userSchema.set("toJSON", {
  transform(doc, ret) {
    for (const k of ["verifyTokenHash", "verifyExpiresAt", "setupTokenHash", "setupExpiresAt"]) delete ret[k];
    return ret;
  },
});

// Why this account may not sign in / use a token, or null when it may:
//   { reason, code, message }  reason: deactivated | not_active | org_suspended
// `org` is the user's Organization document (required for everyone but super_admin; a missing
// one counts as suspended). `message` is the login-form wording; authGuard uses its own.
function authProblem(user, org) {
  if (!user) return { reason: "missing", code: "UNAUTHENTICATED", message: "User no longer exists" };
  if (user.isActive === false) return { reason: "deactivated", code: "ACCOUNT_DEACTIVATED", message: "Account is deactivated" };
  const status = user.status === undefined || user.status === null ? "active" : user.status;
  if (status !== "active") {
    if (status === "unverified") return { reason: "not_active", code: "EMAIL_UNVERIFIED", message: "Verify your email first. Check your inbox for the link." };
    if (status === "pending") return { reason: "not_active", code: "ACCOUNT_PENDING", message: "Your account is awaiting approval from your organization's admin." };
    return { reason: "not_active", code: "ACCOUNT_NOT_ACTIVE", message: "Account is not active" };
  }
  if (user.role !== "super_admin" && (!org || org.status !== "active")) {
    return { reason: "org_suspended", code: "ORG_SUSPENDED", message: "Your organization is suspended." };
  }
  return null;
}

// Boolean: can this user sign in / use a token right now?
const canAuthenticate = (user, org) => authProblem(user, org) === null;

const User = mongoose.model("User", userSchema);
module.exports = User;
module.exports.ROLES = ROLES;
module.exports.ALL_ROLES = ALL_ROLES;
module.exports.STATUSES = STATUSES;
module.exports.authProblem = authProblem;
module.exports.canAuthenticate = canAuthenticate;
