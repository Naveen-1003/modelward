const { DEFAULT_THRESHOLDS } = require("./settings");

const TIER_ORDER = ["low", "medium", "high"];
// low 0 < medium 1 < high 2. Unknown/null tiers rank as high (unrated = unproven).
const tierRank = (tier) => {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? 2 : i;
};
// True when tier `a` is strictly riskier than tier `b`.
const worseThan = (a, b) => tierRank(a) > tierRank(b);

// Pure function, called server-side right after the metrics microservice responds
// and BEFORE saving the Version. Never trust a client-supplied riskTier.
// Missing metrics = treat as high risk.
function computeRiskTier(metrics, thresholds = DEFAULT_THRESHOLDS) {
  const { accuracy, fairnessGap } = metrics || {};
  if (accuracy == null || fairnessGap == null) return "high";
  // null / non-numeric threshold fields must not override the defaults
  const given = Object.fromEntries(Object.entries(thresholds || {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
  const t = { ...DEFAULT_THRESHOLDS, ...given };
  if (accuracy >= t.lowAccuracy && fairnessGap <= t.lowFairnessGap) return "low";
  if (accuracy >= t.mediumAccuracy && fairnessGap <= t.mediumFairnessGap) return "medium";
  return "high";
}

module.exports = computeRiskTier;
module.exports.computeRiskTier = computeRiskTier;
module.exports.tierRank = tierRank;
module.exports.worseThan = worseThan;
