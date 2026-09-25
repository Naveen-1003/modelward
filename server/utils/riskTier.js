// Pure function, called server-side right after the metrics microservice responds
// and BEFORE saving the Version. Never trust a client-supplied riskTier.
function computeRiskTier({ accuracy, fairnessGap }) {
  if (accuracy == null || fairnessGap == null) return "high"; // missing metrics = treat as high risk
  if (accuracy >= 0.85 && fairnessGap <= 0.1) return "low";
  if (accuracy >= 0.7 && fairnessGap <= 0.2) return "medium";
  return "high";
}

module.exports = computeRiskTier;
