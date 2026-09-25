// Pure function, not a DB write -- computed on every read, never stored.
// version.riskTier is already computed and stored on the Version -- read it,
// don't recompute it here.
//
// High risk deliberately does NOT gate on a fairness threshold: riskTier is
// itself derived from that same fairness gap, so requiring "fairnessGap < X"
// to approve a version already classified high-risk *because* its fairness
// gap exceeded X would make approval permanently impossible. Instead, high
// risk requires a mandatory, documented reviewer comment -- more human
// scrutiny, not an unpassable score.
function scoreCompliance(version) {
  const { riskTier, metrics, status, reviewComment } = version;
  const hasMetrics = !!(metrics && metrics.accuracy != null);
  const hasApproval = status === "approved" || status === "deployed";
  const hasDocumentedComment = !!reviewComment && reviewComment.trim().length > 0;

  if (riskTier === "low") {
    return { score: hasMetrics ? 100 : 0, required: ["metrics"] };
  }

  if (riskTier === "medium") {
    const checks = [hasMetrics, hasApproval];
    return {
      score: Math.round((checks.filter(Boolean).length / checks.length) * 100),
      required: ["metrics", "approval"],
    };
  }

  // high (or unrated/null, treated as high until proven otherwise)
  const checks = [hasMetrics, hasDocumentedComment, hasApproval];
  return {
    score: Math.round((checks.filter(Boolean).length / checks.length) * 100),
    required: ["metrics", "documented_review_comment", "approval"],
  };
}

module.exports = scoreCompliance;
