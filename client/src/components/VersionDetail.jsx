import React, { useEffect, useState } from "react";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import StatusBadge from "./StatusBadge.jsx";
import RiskBadge from "./RiskBadge.jsx";
import MetricCard from "./MetricCard.jsx";

export default function VersionDetail({ versionId, onChanged }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");

  function load() {
    setLoading(true);
    setError("");
    api
      .get(`/versions/${versionId}`)
      .then(({ data }) => setData(data))
      .catch((err) => setError(extractError(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [versionId]);

  async function runAction(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      load();
      onChanged?.();
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading version...</p>;
  if (error && !data) return <div className="error-box">{error}</div>;
  if (!data) return null;

  const { version, compliance, snapshots } = data;
  const isHighRisk = version.riskTier === "high";

  return (
    <div className="card">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Version {version.versionNumber}</h3>
        <div className="metric-row" style={{ margin: 0 }}>
          <StatusBadge status={version.status} />
          <RiskBadge riskTier={version.riskTier} />
        </div>
      </div>

      <p className="muted">
        File type: {version.fileType} · Uploaded {new Date(version.createdAt).toLocaleString()}
      </p>

      {version.status === "upload_failed" && (
        <div className="error-box">Upload failed: {version.uploadError}</div>
      )}

      <MetricCard metrics={version.metrics} />

      {compliance && (
        <p>
          <strong>Compliance score: {compliance.score}%</strong>{" "}
          <span className="muted">(required: {compliance.required.join(", ") || "none"})</span>
        </p>
      )}

      {(version.datasetNotes || version.trainingNotes) && (
        <details>
          <summary>Notes</summary>
          {version.datasetNotes && <p><strong>Dataset:</strong> {version.datasetNotes}</p>}
          {version.trainingNotes && <p><strong>Training:</strong> {version.trainingNotes}</p>}
        </details>
      )}

      {version.reviewComment && (
        <p className="muted">Reviewer comment: "{version.reviewComment}"</p>
      )}

      {error && <div className="error-box">{error}</div>}

      {/* ML Engineer: submit a draft for review */}
      {user.role === "ml_engineer" && version.status === "draft" && (
        <button disabled={busy} onClick={() => runAction(() => api.post(`/versions/${versionId}/submit`))}>
          Submit for Review
        </button>
      )}

      {/* Compliance Officer: approve/reject a submitted version */}
      {user.role === "compliance_officer" && version.status === "submitted" && (
        <div style={{ marginTop: "1rem" }}>
          <label>
            Reviewer comment {isHighRisk && <strong>(required -- high risk)</strong>}
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div className="inline-form">
            <button
              disabled={busy}
              onClick={() =>
                runAction(() =>
                  api.post(`/versions/${versionId}/review`, { decision: "approve", comment })
                )
              }
            >
              Approve
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                runAction(() =>
                  api.post(`/versions/${versionId}/review`, { decision: "reject", comment })
                )
              }
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Compliance Officer or Admin: deploy an approved version */}
      {["compliance_officer", "admin"].includes(user.role) && version.status === "approved" && (
        <button disabled={busy} onClick={() => runAction(() => api.post(`/versions/${versionId}/deploy`))}>
          Deploy
        </button>
      )}

      {/* Any role: simulate drift on a deployed version (deliberately open, see build plan) */}
      {version.status === "deployed" && (
        <button
          disabled={busy}
          onClick={() => runAction(() => api.post(`/versions/${versionId}/simulate-drift`))}
        >
          Simulate Next Snapshot
        </button>
      )}

      {snapshots && snapshots.length > 0 && (
        <div style={{ marginTop: "1.25rem" }}>
          <h4>Snapshot History</h4>
          <table className="compact">
            <thead>
              <tr>
                <th>When</th>
                <th>Accuracy</th>
                <th>Drift Δ</th>
                <th>Flagged</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s._id}>
                  <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
                  <td>{Number(s.accuracy).toFixed(3)}</td>
                  <td>{Number(s.driftDelta).toFixed(3)}</td>
                  <td>{s.flagged ? "⚠️ Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
