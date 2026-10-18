// Pure function, not a DB write -- computed on every read, never stored.
//
// Which checks apply depends on the version's CURRENT risk tier (re-evaluated on
// every monitoring snapshot), so a drifting version's compliance drops.
//   low:    metrics, approval
//   medium: metrics, approval, drift_clear
//   high:   metrics, documented_review_comment, approval, drift_clear
//   unrated/null is treated as high until proven otherwise.
//
// High risk deliberately does NOT gate on a fairness threshold: the tier is itself
// derived from that fairness gap, so requiring "fairnessGap < X" to approve a
// version classified high *because* of it would make approval impossible. Instead
// high risk requires a documented reviewer comment -- more human scrutiny, not an
// unpassable score.
const APPROVED_STATUSES = ["approved", "deployed", "needs_review", "superseded", "retired"];

const LABELS = {
  metrics: "Metrics computed",
  documented_review_comment: "Documented reviewer comment",
  approval: "Compliance approval",
  drift_clear: "No unresolved drift",
};

const REQUIRED_BY_TIER = {
  low: ["metrics", "approval"],
  medium: ["metrics", "approval", "drift_clear"],
  high: ["metrics", "documented_review_comment", "approval", "drift_clear"],
};

// A flagged snapshot at/before the version's "keep deployed" acknowledgement is resolved.
function flagStillOpen(version, latestSnapshot) {
  if (!latestSnapshot || !latestSnapshot.flagged) return false;
  const ackId = version.driftAckSnapshotId;
  if (!ackId) return true;
  if (String(latestSnapshot._id) === String(ackId)) return false;
  const ackAt = version.driftAckSnapshotAt;
  return !(ackAt && latestSnapshot.createdAt && new Date(latestSnapshot.createdAt) <= new Date(ackAt));
}

function scoreCompliance(version, latestSnapshot = null) {
  const { riskTier, metrics, status, reviewComment } = version;
  const passedByKey = {
    metrics: !!(metrics && metrics.accuracy != null),
    documented_review_comment: typeof reviewComment === "string" && reviewComment.trim().length > 0,
    approval: APPROVED_STATUSES.includes(status),
    drift_clear: status !== "needs_review" && !flagStillOpen(version, latestSnapshot),
  };

  const keys = REQUIRED_BY_TIER[riskTier] || REQUIRED_BY_TIER.high;
  const checks = keys.map((key) => ({ key, label: LABELS[key], passed: passedByKey[key] }));
  const score = Math.round((checks.filter((c) => c.passed).length / checks.length) * 100);
  return { score, checks, required: checks.map((c) => c.label) };
}

module.exports = scoreCompliance;
module.exports.scoreCompliance = scoreCompliance;
