import React from "react";

const KNOWN = ["low", "medium", "high"];

export default function RiskBadge({ riskTier }) {
  const tier = KNOWN.includes(riskTier) ? riskTier : "unrated";
  return <span className={`badge badge-risk-${tier}`}>{tier === "unrated" ? "Unrated" : `${tier} risk`}</span>;
}
