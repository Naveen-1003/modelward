import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import RiskBadge from "../components/RiskBadge.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";

const RISK_TIERS = ["low", "medium", "high", "unrated"];

export default function AdminDashboard() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get("/models")
      .then(({ data }) => setModels(data.models))
      .catch((err) => setError(extractError(err)))
      .finally(() => setLoading(false));
  }, []);

  const riskCounts = useMemo(() => {
    const counts = { low: 0, medium: 0, high: 0, unrated: 0 };
    models.forEach((m) => {
      counts[m.latestRiskTier || "unrated"] = (counts[m.latestRiskTier || "unrated"] || 0) + 1;
    });
    return counts;
  }, [models]);

  const pendingReview = useMemo(
    () => models.filter((m) => m.latestVersionStatus === "submitted").length,
    [models]
  );
  const deployed = useMemo(
    () => models.filter((m) => m.latestVersionStatus === "deployed").length,
    [models]
  );

  return (
    <main className="page">
      <h2>Governance Overview</h2>
      {error && <div className="error-box">{error}</div>}

      <div className="stat-row">
        <div className="stat-tile">
          <div className="stat-value">{models.length}</div>
          <div className="stat-label">Total Models</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{pendingReview}</div>
          <div className="stat-label">Pending Review</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{deployed}</div>
          <div className="stat-label">Deployed</div>
        </div>
        {RISK_TIERS.map((tier) => (
          <div className="stat-tile" key={tier}>
            <div className="stat-value">{riskCounts[tier] || 0}</div>
            <div className="stat-label">{tier} risk</div>
          </div>
        ))}
      </div>

      <h3>All Models</h3>
      {loading ? (
        <p className="muted">Loading...</p>
      ) : models.length === 0 ? (
        <p className="muted">No models registered yet.</p>
      ) : (
        <div className="dashboard-grid">
          {models.map((m) => (
            <Link key={m._id} to={`/models/${m._id}`} className="card card-link">
              <h3>{m.name}</h3>
              <p className="muted">{m.useCase || "No use case noted"}</p>
              <div className="metric-row">
                <RiskBadge riskTier={m.latestRiskTier} />
                {m.latestVersionStatus && <StatusBadge status={m.latestVersionStatus} />}
              </div>
            </Link>
          ))}
        </div>
      )}

      <div style={{ marginTop: "2.5rem" }}>
        <AuditLogTable />
      </div>
    </main>
  );
}
