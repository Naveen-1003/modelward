import React from "react";
import { Link } from "react-router-dom";
import RiskBadge from "./RiskBadge.jsx";
import StatusBadge from "./StatusBadge.jsx";

// Live version (what is actually serving) matters more than the latest upload,
// so the tier shown is displayRiskTier; the chips say which version it describes.
export default function ModelList({ models }) {
  return (
    <ul className="model-list">
      {models.map((m) => {
        const tier = m.displayRiskTier || m.latestRiskTier || "unrated";
        const hasLive = m.liveVersionNumber != null;
        const showLatest = m.latestVersionNumber != null && m.latestVersionNumber !== m.liveVersionNumber;
        const count = m.versionCount ?? 0;
        return (
          <li key={m._id}>
            <Link to={`/models/${m._id}`} className={`model-row tier-${tier}`}>
              <span className="model-row-main">
                <strong>{m.name}</strong>
                <span className="muted">{m.useCase || "No use case noted"}</span>
              </span>
              <span className="model-row-ver mono">
                {count === 0 ? "no versions" : `${count} ${count === 1 ? "version" : "versions"}`}
              </span>
              <span className="model-row-badges">
                {hasLive && (
                  <span className="chip chip-live" title="Version currently live">Live: v{m.liveVersionNumber}</span>
                )}
                {showLatest && (
                  <span className="chip" title="Most recently uploaded version">Latest: v{m.latestVersionNumber}</span>
                )}
                <RiskBadge riskTier={tier} />
                {hasLive
                  ? m.liveVersionStatus && <StatusBadge status={m.liveVersionStatus} />
                  : m.latestVersionStatus && <StatusBadge status={m.latestVersionStatus} />}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
