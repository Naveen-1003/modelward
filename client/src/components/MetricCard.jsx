import React from "react";

function fmt(value, digits = 3) {
  if (value === null || value === undefined) return "—";
  return Number(value).toFixed(digits);
}

export default function MetricCard({ metrics }) {
  if (!metrics || metrics.accuracy == null) {
    return <p className="muted">No metrics computed yet.</p>;
  }
  const pct = Math.max(0, Math.min(1, Number(metrics.accuracy))) * 100;
  return (
    <dl className="metrics">
      <div>
        <dt>Accuracy</dt>
        <dd className="mono">{fmt(metrics.accuracy)}</dd>
        <div className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      </div>
      <div>
        <dt>Fairness gap</dt>
        <dd className="mono">{fmt(metrics.fairnessGap)}</dd>
        <small>lower is better</small>
      </div>
      <div>
        <dt>Latency</dt>
        <dd className="mono">{metrics.latencyMs != null ? `${fmt(metrics.latencyMs, 2)} ms` : "—"}</dd>
        <small>{metrics.computedBy === "self_reported" ? "self-reported" : "measured"}</small>
      </div>
    </dl>
  );
}
