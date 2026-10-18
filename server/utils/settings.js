const Settings = require("../models/Settings");

const DEFAULT_THRESHOLDS = Object.freeze({
  lowAccuracy: 0.85,
  lowFairnessGap: 0.1,
  mediumAccuracy: 0.7,
  mediumFairnessGap: 0.2,
  driftThreshold: 0.1,
});
const KEYS = Object.keys(DEFAULT_THRESHOLDS);

// Plain object with the five threshold keys; defaults when no admin override
// exists. Deliberately uncached: one tiny indexed read per scoring, and an
// update is visible to every caller immediately.
async function getThresholds() {
  const doc = await Settings.findOne({ key: "global" }).lean();
  const out = {};
  for (const k of KEYS) out[k] = doc && typeof doc[k] === "number" ? doc[k] : DEFAULT_THRESHOLDS[k];
  return out;
}

module.exports = { DEFAULT_THRESHOLDS, THRESHOLD_KEYS: KEYS, getThresholds };
