const computeRiskTier = require("./riskTier");
const { worseThan } = require("./riskTier");
const { DEFAULT_THRESHOLDS } = require("./settings");

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// The single rule for "did this snapshot drift?", used by BOTH simulated and
// real (batch) snapshots. Pure.
//   riskTier   re-evaluated from the new metrics with the thresholds the version was scored under
//   escalated  the tier got worse than the version's previous current tier
//   flagged    accuracy or fairness gap moved more than driftThreshold from the
//              baseline, OR the tier escalated
// `baseline` is the EFFECTIVE baseline: the original baseline snapshot, or -- after a
// compliance "keep" -- the acknowledged snapshot (see Version.driftAck*).
// Threshold objects are cleaned (null / non-numeric fields dropped) so a null can never
// override a default.
function evaluateSnapshot({ baseline, metrics, version, thresholds }) {
  const t = { ...DEFAULT_THRESHOLDS, ...plain(version && version.thresholdsUsed), ...plain(thresholds) };
  const riskTier = computeRiskTier(metrics, t);
  const previous = version ? version.riskTier : null;
  const escalated = previous != null && worseThan(riskTier, previous);
  const driftDelta = metrics.accuracy - baseline.accuracy;
  const fairnessDelta = metrics.fairnessGap - baseline.fairnessGap;
  const flagged = Math.abs(driftDelta) > t.driftThreshold || Math.abs(fairnessDelta) > t.driftThreshold || escalated;
  return { riskTier, driftDelta, flagged, escalated };
}

// Mongoose subdocs -> plain object with only defined numbers.
function plain(obj) {
  if (!obj || typeof obj !== "object") return {};
  const src = typeof obj.toObject === "function" ? obj.toObject() : obj;
  const out = {};
  for (const [k, v] of Object.entries(src)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

// SIMULATED next snapshot: directional-walk-plus-jitter, not pure random -- pure
// noise won't visibly "trend" across repeated demo clicks, which undercuts the
// "we caught degradation early" story a drift chart is supposed to tell.
// Accuracy drifts down, the fairness gap drifts slightly up, latency just jitters.
// `version` (optional) supplies thresholdsUsed + the previous current tier.
function nextSnapshot(baseline, last, thresholds, version = null) {
  const accStep = -0.01 + (Math.random() * 0.04 - 0.02);
  const gapStep = 0.003 + (Math.random() * 0.006 - 0.003);
  const accuracy = clamp(last.accuracy + accStep, 0, 1);
  const fairnessGap = clamp(last.fairnessGap + gapStep, 0, 1);
  const latencyMs = last.latencyMs == null ? null : Math.max(0, last.latencyMs * (1 + (Math.random() - 0.5) * 0.04));
  const metrics = { accuracy, fairnessGap, latencyMs };
  const ver = version || { riskTier: last.riskTier || null, thresholdsUsed: thresholds };
  return { ...metrics, ...evaluateSnapshot({ baseline, metrics, version: ver, thresholds }) };
}

module.exports = nextSnapshot;
module.exports.nextSnapshot = nextSnapshot;
module.exports.evaluateSnapshot = evaluateSnapshot;
