import React from "react";

export default function RiskBadge({ riskTier }) {
  const tier = riskTier || "unrated";
  return <span className={`badge badge-risk-${tier}`}>{tier === "unrated" ? "Unrated" : `${tier} risk`}</span>;
}
