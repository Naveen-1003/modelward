import React, { useEffect, useState } from "react";
import api, { extractError } from "../api/axios.js";
import RiskBadge from "../components/RiskBadge.jsx";
import VersionDetail from "../components/VersionDetail.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";

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
      <h2>Review Queue</h2>
      <p className="muted">Versions awaiting compliance review, oldest first.</p>

      {error && <div className="error-box">{error}</div>}

      {loading ? (
        <p className="muted">Loading...</p>
      ) : queue.length === 0 ? (
        <p className="muted">Nothing waiting for review right now.</p>
      ) : (
        <table className="compact" style={{ marginBottom: "1.5rem" }}>
          <thead>
            <tr>
              <th>Model</th>
              <th>Version</th>
              <th>Risk</th>
              <th>Submitted</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {queue.map((v) => (
              <tr key={v._id} style={{ background: v._id === selectedVersionId ? "#F5F7F8" : "transparent" }}>
                <td>{v.modelName}</td>
                <td>v{v.versionNumber}</td>
                <td><RiskBadge riskTier={v.riskTier} /></td>
                <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                <td>
                  <button className="btn-link" onClick={() => setSelectedVersionId(v._id)}>
                    Review
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedVersionId && (
        <VersionDetail versionId={selectedVersionId} onChanged={handleChanged} />
      )}

      <div style={{ marginTop: "2.5rem" }}>
        <AuditLogTable refreshKey={refreshKey} />
      </div>
    </main>
  );
}
