import React from "react";

function fmt(value, digits = 3) {
  if (value === null || value === undefined) return "—";
  return Number(value).toFixed(digits);
}

export default function MetricCard({ metrics }) {
  if (!metrics || metrics.accuracy == null) {
    return <p className="muted">No metrics computed yet.</p>;
  }
  return (
    <div className="metric-row">
      <div className="metric-chip">
        <strong>{fmt(metrics.accuracy)}</strong>
        Accuracy
      </div>
      <div className="metric-chip">
        <strong>{fmt(metrics.fairnessGap)}</strong>
        Fairness Gap
      </div>
      <div className="metric-chip">
        <strong>{metrics.latencyMs != null ? `${fmt(metrics.latencyMs, 2)} ms` : "—"}</strong>
        Latency {metrics.computedBy === "self_reported" ? "(self-reported)" : "(measured)"}
      </div>
    </div>
  );
}
