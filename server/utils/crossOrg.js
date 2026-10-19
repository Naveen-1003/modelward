// Cross-organization probe for the id loaders (model / version / comment / file).
//
// A lookup that misses INSIDE the caller's organization answers 404 as always. When it misses
// because the id belongs to ANOTHER organization, that is worth a record: this writes one
// `cross_org_attempt` audit entry (actor = the caller, orgId = the caller's organization).
// The response never changes and nothing about the other organization is revealed (the entry
// does not name it). Call it only on the miss path, then answer 404.
const mongoose = require("mongoose");
const writeAuditLog = require("../middleware/audit");

// What each kind is looked up in. A "File" is requested by its version's id.
const KINDS = {
  Model: { collection: () => require("../models/Model"), targetType: "Model" },
  Version: { collection: () => require("../models/Version"), targetType: "Version" },
  Comment: { collection: () => require("../models/Comment"), targetType: "Comment" },
  File: { collection: () => require("../models/Version"), targetType: "Version" },
};

// Returns true when `id` exists in a different organization (and an audit entry was attempted),
// false otherwise (unknown id, same organization, no organization context, bad input, any
// failure). Never throws.
async function logCrossOrg(req, kind, id) {
  try {
    const spec = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
    if (!spec || !req || !req.user || !req.orgId) return false;
    if (typeof id !== "string" && !(id instanceof mongoose.Types.ObjectId)) return false;
    if (!mongoose.isValidObjectId(id)) return false;
    // Cross-tenant on purpose: that is the question being asked. Archived rows count too.
    const elsewhere = await spec
      .collection()
      .exists({ _id: id, orgId: { $nin: [req.orgId, null] } })
      .setOptions({ bypassTenant: true, includeDeleted: true });
    if (!elsewhere) return false;
    await writeAuditLog({
      actor: req.user,
      action: "cross_org_attempt",
      targetType: spec.targetType,
      targetId: id,
      details: `Requested ${kind === "File" ? "the file of version" : kind.toLowerCase()} ${String(id)}, which is outside this organization`,
      orgId: req.orgId,
    });
    return true;
  } catch (err) {
    console.error("[crossOrg] probe failed:", err && err.message);
    return false;
  }
}

module.exports = { logCrossOrg };
