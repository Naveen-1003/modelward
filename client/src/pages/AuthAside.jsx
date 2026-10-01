import React from "react";

const STAGES = [
  ["Register", "Every model gets a record"],
  ["Score", "Accuracy, fairness and latency, measured"],
  ["Review", "Risk-tiered sign-off by compliance"],
  ["Deploy", "Only approved versions ship"],
  ["Audit", "Each action logged, read-only"],
];

export default function AuthAside() {
  return (
    <aside className="auth-aside">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">MW</span>
        <span>ModelWard</span>
      </div>
      <div>
        <h2>Every model, accounted for.</h2>
        <ol className="stages">
          {STAGES.map(([name, note], i) => (
            <li key={name}>
              <span className="mono">{String(i + 1).padStart(2, "0")}</span>
              <strong>{name}</strong>
              <em>{note}</em>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
