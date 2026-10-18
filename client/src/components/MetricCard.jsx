import React from "react";
import { fmt } from "./featureUtils.js";

// Extra metrics only render when the scoring service produced them (null otherwise).
const EXTRA = [
  { key: "precision", label: "Precision", help: "Of the cases predicted positive, the share that really were positive." },
  { key: "recall", label: "Recall", help: "Of the cases that really were positive, the share the model found." },
  { key: "f1", label: "F1", help: "Balance of precision and recall; 1.0 is perfect." },
  { key: "auc", label: "AUC", help: "How well predicted probabilities rank positives above negatives; 0.5 is chance, 1.0 is perfect." },
  { key: "demographicParityDiff", label: "Demographic parity diff", help: "Largest gap in positive-prediction rate between groups. Closer to 0 is fairer.", note: "closer to 0 is fairer" },
  { key: "equalOpportunityDiff", label: "Equal opportunity diff", help: "Largest gap in true-positive rate between groups. Closer to 0 is fairer.", note: "closer to 0 is fairer" },
  { key: "disparateImpactRatio", label: "Disparate impact ratio", help: "Lowest group positive rate divided by the highest. 80% rule: ≥ 0.80 is typical.", note: "80% rule: ≥ 0.80 is typical", warnBelow: 0.8 },
];

function latencyTag(metrics) {
  if (metrics.latencyMs == null) return { text: "not provided", cls: "" };
  if (metrics.computedBy === "microservice") return { text: "Measured", cls: "measured" };
  if (metrics.computedBy === "self_reported") return { text: "Self-reported", cls: "self-reported" };
  return { text: "", cls: "" };
}

export default function MetricCard({ metrics, scoringWarnings }) {
  if (!metrics || metrics.accuracy == null) {
    return <p className="muted">No metrics computed yet.</p>;
  }
  const pct = Math.max(0, Math.min(1, Number(metrics.accuracy))) * 100;
  const lat = latencyTag(metrics);
  const extras = EXTRA.filter((e) => metrics[e.key] != null);
  const groups = Array.isArray(metrics.groups) ? metrics.groups : [];
  const warnings = Array.isArray(scoringWarnings) ? scoringWarnings.filter(Boolean) : [];

  return (
    <>
      <dl className="metrics">
        <div>
          <dt>Accuracy</dt>
          <dd className="mono">{fmt(metrics.accuracy)}</dd>
          <div className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
          {metrics.rows != null && <small>{Number(metrics.rows).toLocaleString()} rows scored</small>}
        </div>
        <div>
          <dt>Fairness gap</dt>
          <dd className="mono">{fmt(metrics.fairnessGap)}</dd>
          <small>max − min group accuracy; lower is better</small>
        </div>
        <div>
          <dt>Latency</dt>
          <dd className="mono">{metrics.latencyMs != null ? `${fmt(metrics.latencyMs, 2)} ms` : "—"}</dd>
          {lat.text && (
            <small>
              <span
                className={`metric-tag ${lat.cls}`}
                title={
                  lat.cls === "measured"
                    ? "Measured by ModelWard while running the model file"
                    : lat.cls === "self-reported"
                    ? "Entered by the uploader; ModelWard did not measure it"
                    : undefined
                }
              >
                {lat.text}
              </span>
            </small>
          )}
        </div>
      </dl>

      {extras.length > 0 && (
        <dl className="metrics metrics-extra" aria-label="Additional metrics">
          {extras.map((e) => {
            const v = Number(metrics[e.key]);
            const warn = e.warnBelow != null && v < e.warnBelow;
            return (
              <div key={e.key} title={e.help}>
                <dt>{e.label}</dt>
                <dd className={`mono${warn ? " metric-warn" : ""}`}>{fmt(v)}</dd>
                {e.note && <small>{e.note}</small>}
                {warn && <small className="metric-warn">below the 0.80 rule of thumb</small>}
              </div>
            );
          })}
        </dl>
      )}

      {groups.length > 0 && (
        <div className="group-table">
          <h3 className="mini-head">Per-group results</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th className="num">Rows</th>
                  <th className="num">Accuracy</th>
                  <th className="num" title="Share of rows the model predicted positive">Positive rate</th>
                  <th className="num" title="True-positive rate (recall) within the group">TPR</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={`${g.group}-${i}`}>
                    <td className="mono">{String(g.group ?? "—")}</td>
                    <td className="num mono">{g.count != null ? Number(g.count).toLocaleString() : "—"}</td>
                    <td className="num mono">{fmt(g.accuracy)}</td>
                    <td className="num mono">{fmt(g.positiveRate)}</td>
                    <td className="num mono">{fmt(g.tpr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="info-list" aria-label="Scoring notes">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}
