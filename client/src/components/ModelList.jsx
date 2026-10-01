import React from "react";
import { Link } from "react-router-dom";
import RiskBadge from "./RiskBadge.jsx";
import StatusBadge from "./StatusBadge.jsx";

export default function ModelList({ models }) {
  return (
    <ul className="model-list">
      {models.map((m) => (
        <li key={m._id}>
          <Link to={`/models/${m._id}`} className={`model-row tier-${m.latestRiskTier || "unrated"}`}>
            <span className="model-row-main">
              <strong>{m.name}</strong>
              <span className="muted">{m.useCase || "No use case noted"}</span>
            </span>
            <span className="model-row-ver mono">
              {m.latestVersionNumber ? `v${m.latestVersionNumber}` : "no versions"}
            </span>
            <span className="model-row-badges">
              <RiskBadge riskTier={m.latestRiskTier} />
              {m.latestVersionStatus && <StatusBadge status={m.latestVersionStatus} />}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
