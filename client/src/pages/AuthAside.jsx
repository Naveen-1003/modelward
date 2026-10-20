import React from "react";

const STAGES = [
  ["Register", "Every model gets a record"],
  ["Score", "Accuracy, fairness and latency, measured"],
  ["Review", "Risk-tiered sign-off by compliance"],
  ["Deploy", "Only approved versions ship"],
  ["Audit", "Each action logged, read-only"],
];

import Logo from "../components/Logo.jsx";

export default function AuthAside() {
  return (
    <aside className="auth-aside">
      <div className="brand">
        <Logo dark />
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

// Neutral placeholder while the stored session is checked (no form flash before a redirect).
export function AuthLoading() {
  return (
    <main className="auth-page">
      <AuthAside />
      <section className="auth-main">
        <p className="muted" role="status">Loading…</p>
      </section>
    </main>
  );
}
