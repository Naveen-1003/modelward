import React, { useEffect, useMemo, useState } from "react";
import api, { extractError } from "../api/axios.js";
import ModelList from "../components/ModelList.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";
import { PageHeader, Loading, ErrorBox } from "../components/ui.jsx";

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

  const pendingReview = models.filter((m) => m.latestVersionStatus === "submitted").length;
  const deployed = models.filter((m) => m.latestVersionStatus === "deployed").length;

  return (
    <main className="page">
      <PageHeader
        kicker="Admin"
        title="Governance overview"
        description="Model risk, review status and deployment across the portfolio."
      />
      <ErrorBox>{error}</ErrorBox>

      <section className="figures" aria-label="Summary">
        <div><span className="mono">{models.length}</span>Models</div>
        <div><span className="mono">{pendingReview}</span>Pending review</div>
        <div><span className="mono">{deployed}</span>Deployed</div>
      </section>

      {models.length > 0 && (
        <section className="section" aria-label="Risk distribution">
          <div className="section-head"><h2>Risk distribution</h2></div>
          <div className="riskbar" role="img" aria-label={RISK_TIERS.map((t) => `${riskCounts[t]} ${t}`).join(", ")}>
            {RISK_TIERS.filter((t) => riskCounts[t] > 0).map((t) => (
              <span key={t} className={`seg seg-${t}`} style={{ flexGrow: riskCounts[t] }} />
            ))}
          </div>
          <ul className="legend">
            {RISK_TIERS.map((t) => (
              <li key={t}>
                <i className={`seg-${t}`} /> {t === "unrated" ? "Unrated" : `${t} risk`}
                <b className="mono">{riskCounts[t]}</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <div className="section-head"><h2>All models</h2></div>
        {loading ? (
          <Loading />
        ) : models.length === 0 ? (
          <div className="empty-state">No models registered yet.</div>
        ) : (
          <ModelList models={models} />
        )}
      </section>

      <AuditLogTable />
    </main>
  );
}
