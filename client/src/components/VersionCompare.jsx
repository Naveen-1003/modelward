import React, { useEffect, useMemo, useState } from "react";
import StatusBadge from "./StatusBadge.jsx";
import RiskBadge from "./RiskBadge.jsx";
import { fmt } from "./featureUtils.js";

// dir: "up" = higher is better, "down" = lower is better, "abs" = closer to 0 is better.
const ROWS = [
  { key: "accuracy", label: "Accuracy", dir: "up" },
  { key: "fairnessGap", label: "Fairness gap", dir: "down" },
  { key: "latencyMs", label: "Latency (ms)", dir: "down", digits: 2 },
  { key: "precision", label: "Precision", dir: "up" },
  { key: "recall", label: "Recall", dir: "up" },
  { key: "f1", label: "F1", dir: "up" },
  { key: "auc", label: "AUC", dir: "up" },
  { key: "demographicParityDiff", label: "Demographic parity diff", dir: "abs" },
  { key: "equalOpportunityDiff", label: "Equal opportunity diff", dir: "abs" },
  { key: "disparateImpactRatio", label: "Disparate impact ratio", dir: "up" },
  { key: "rows", label: "Rows scored", dir: null, digits: 0 },
];

function verdict(dir, a, b) {
  if (!dir || a == null || b == null) return "";
  const x = dir === "abs" ? Math.abs(a) : a;
  const y = dir === "abs" ? Math.abs(b) : b;
  if (Math.abs(y - x) < 1e-9) return "";
  const better = dir === "up" ? y > x : y < x;
  return better ? "better" : "worse";
}

function Pick({ id, label, value, onChange, versions }) {
  return (
    <label>
      {label}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {versions.map((v) => (
          <option key={v._id} value={v._id}>
            v{v.versionNumber}
          </option>
        ))}
      </select>
    </label>
  );
}

// Compares two versions using the list data already on the page.
export default function VersionCompare({ versions }) {
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");

  useEffect(() => {
    // default: previous vs newest; repair selections that disappeared (archived)
    const ids = versions.map((v) => v._id);
    if (!ids.includes(aId)) setAId(ids[1] || ids[0] || "");
    if (!ids.includes(bId)) setBId(ids[0] || "");
  }, [versions, aId, bId]);

  const a = useMemo(() => versions.find((v) => v._id === aId), [versions, aId]);
  const b = useMemo(() => versions.find((v) => v._id === bId), [versions, bId]);

  if (versions.length < 2) {
    return <div className="empty-state">Upload at least two versions to compare them.</div>;
  }
  if (!a || !b) return null;

  return (
    <div className="compare">
      <div className="compare-pick">
        <Pick id="cmp-a" label="Baseline version" value={aId} onChange={setAId} versions={versions} />
        <Pick id="cmp-b" label="Compare against" value={bId} onChange={setBId} versions={versions} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">v{a.versionNumber}</th>
              <th className="num">v{b.versionNumber}</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Status</td>
              <td className="num"><StatusBadge status={a.status} /></td>
              <td className="num"><StatusBadge status={b.status} /></td>
              <td />
            </tr>
            <tr>
              <td>Risk tier</td>
              <td className="num"><RiskBadge riskTier={a.riskTier} /></td>
              <td className="num"><RiskBadge riskTier={b.riskTier} /></td>
              <td />
            </tr>
            {ROWS.map((r) => {
              const av = a.metrics?.[r.key] ?? null;
              const bv = b.metrics?.[r.key] ?? null;
              const digits = r.digits ?? 3;
              const delta = av != null && bv != null ? Number(bv) - Number(av) : null;
              const v = verdict(r.dir, av, bv);
              return (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="num mono">{fmt(av, digits)}</td>
                  <td className="num mono">{fmt(bv, digits)}</td>
                  <td className={`num mono${v ? ` delta-${v}` : ""}`}>
                    {delta == null ? "—" : `${delta > 0 ? "+" : ""}${fmt(delta, digits)}`}
                    {v && <span className="sr-only"> ({v})</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">Green means the second version is better on that metric, red means worse. Change = second − first.</p>
    </div>
  );
}
