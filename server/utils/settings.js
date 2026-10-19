const Settings = require("../models/Settings");
const { currentOrgId, TenantContextError } = require("./tenant");

const DEFAULT_THRESHOLDS = Object.freeze({
  lowAccuracy: 0.85,
  lowFairnessGap: 0.1,
  mediumAccuracy: 0.7,
  mediumFairnessGap: 0.2,
  driftThreshold: 0.1,
});
const KEYS = Object.keys(DEFAULT_THRESHOLDS);

// Plain object with the five threshold keys for ONE organization (default: the current
// request's); defaults when that org has no admin override. Deliberately uncached: one tiny
// indexed read per scoring, and an update is visible to every caller immediately.
// Settings is tenant-scoped, so inside a request the org filter applies as well; background
// code (jobs, migrations) passes the org explicitly and runs under the system context.
async function getThresholds(orgId = currentOrgId()) {
  if (!orgId) throw new TenantContextError();
  const doc = await Settings.findOne({ orgId }).lean();
  const out = {};
  for (const k of KEYS) out[k] = doc && typeof doc[k] === "number" ? doc[k] : DEFAULT_THRESHOLDS[k];
  return out;
}

module.exports = { DEFAULT_THRESHOLDS, THRESHOLD_KEYS: KEYS, getThresholds };
