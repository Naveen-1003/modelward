// Directional-walk-plus-jitter, not pure random -- pure noise won't visibly
// "trend" across repeated demo clicks, which undercuts the "we caught
// degradation early" story a drift chart is supposed to tell.
function nextSnapshot(baseline, last) {
  const step = -0.01 + (Math.random() * 0.04 - 0.02); // small downward drift + jitter
  const accuracy = Math.max(0, Math.min(1, last.accuracy + step));
  const driftDelta = accuracy - baseline.accuracy;
  const flagged = Math.abs(driftDelta) > 0.1; // threshold, tune to taste
  return {
    accuracy,
    fairnessGap: last.fairnessGap,
    latencyMs: last.latencyMs,
    driftDelta,
    flagged,
  };
}

module.exports = nextSnapshot;
