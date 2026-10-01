import React, { useEffect, useState } from "react";
import api, { extractError } from "../api/axios.js";
import RiskBadge from "../components/RiskBadge.jsx";
import VersionDetail from "../components/VersionDetail.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";
import { PageHeader, Loading, ErrorBox } from "../components/ui.jsx";

export default function ComplianceDashboard() {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function load() {
    setLoading(true);
    setError("");
    api
      .get("/models")
      .then(async ({ data }) => {
        const perModel = await Promise.all(
          data.models.map((m) =>
            api.get(`/models/${m._id}/versions`).then(({ data }) =>
              data.versions
                .filter((v) => v.status === "submitted")
                .map((v) => ({ ...v, modelName: m.name }))
            )
          )
        );
        const flattened = perModel.flat().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        setQueue(flattened);
        if (flattened.length > 0) setSelectedVersionId((prev) => prev || flattened[0]._id);
      })
      .catch((err) => setError(extractError(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [refreshKey]);

  function handleChanged() {
    setRefreshKey((k) => k + 1);
  }

  return (
    <main className="page">
      <PageHeader
        kicker="Compliance"
        title="Review queue"
        description="Versions awaiting review, oldest first."
      >
        <div className="count"><b className="mono">{queue.length}</b> awaiting</div>
      </PageHeader>

      <ErrorBox>{error}</ErrorBox>

      {loading && queue.length === 0 ? (
        <Loading />
      ) : queue.length === 0 && !selectedVersionId ? (
        <div className="empty-state">Nothing waiting for review right now.</div>
      ) : (
        <div className="split">
          <nav className="queue" aria-label="Review queue">
            {queue.length === 0 && <div className="empty-state">Queue cleared.</div>}
            {queue.map((v) => (
              <button
                key={v._id}
                className={`queue-item${v._id === selectedVersionId ? " is-selected" : ""}`}
                aria-current={v._id === selectedVersionId ? "true" : undefined}
                onClick={() => setSelectedVersionId(v._id)}
              >
                <span className="queue-top">
                  <strong>{v.modelName}</strong>
                  <span className="mono">v{v.versionNumber}</span>
                </span>
                <span className="queue-bottom">
                  <RiskBadge riskTier={v.riskTier} />
                  <span className="muted small">{new Date(v.createdAt).toLocaleDateString()}</span>
                </span>
              </button>
            ))}
          </nav>
          <div className="split-detail">
            {selectedVersionId && (
              <VersionDetail versionId={selectedVersionId} onChanged={handleChanged} />
            )}
          </div>
        </div>
      )}

      <AuditLogTable refreshKey={refreshKey} />
    </main>
  );
}
