import React, { useEffect, useState } from "react";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import StatusBadge from "./StatusBadge.jsx";
import RiskBadge from "./RiskBadge.jsx";
import MetricCard from "./MetricCard.jsx";
import { Icon, Loading, ErrorBox } from "./ui.jsx";

const STEPS = [
  { key: "draft", label: "Draft" },
  { key: "submitted", label: "In review" },
  { key: "approved", label: "Approved" },
  { key: "deployed", label: "Deployed" },
];

function Lifecycle({ status }) {
  const failed = status === "rejected" || status === "upload_failed";
  const current = status === "rejected" ? 1 : status === "upload_failed" ? 0 : STEPS.findIndex((s) => s.key === status);
  return (
    <ol className="lifecycle" aria-label="Version lifecycle">
      {STEPS.map((s, i) => {
        const state = i < current ? "done" : i === current ? (failed ? "bad" : "now") : "";
        const label = i === current && failed ? (status === "rejected" ? "Rejected" : "Upload failed") : s.label;
        return (
          <li key={s.key} className={state} aria-current={i === current ? "step" : undefined}>
            <span className="dot">{state === "done" ? <Icon name="check" size={11} /> : i + 1}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

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

  useEffect(() => {
    setData(null); // never show another version's actions while the new one loads
    setComment("");
    load();
  }, [versionId]);

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

  if (loading && !data) return <Loading rows={4} />;
  if (error && !data) return <ErrorBox>{error}</ErrorBox>;
  if (!data) return null;

  const { version, compliance, snapshots } = data;
  const isHighRisk = version.riskTier === "high";
  const canReview = user.role === "compliance_officer" && version.status === "submitted";
  const canDeploy = ["compliance_officer", "admin"].includes(user.role) && version.status === "approved";
  const canSubmit = user.role === "ml_engineer" && version.status === "draft";
  const canDrift = version.status === "deployed";

  return (
    <article className="panel version-panel" aria-busy={loading}>
      <div className="panel-head">
        <div>
          <h2>Version {version.versionNumber}</h2>
          <p className="muted mono small">
            {version.fileType} · uploaded {new Date(version.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="badge-row">
          <StatusBadge status={version.status} />
          <RiskBadge riskTier={version.riskTier} />
        </div>
      </div>

      <Lifecycle status={version.status} />

      {version.status === "upload_failed" && (
        <ErrorBox>Upload failed: {version.uploadError}</ErrorBox>
      )}

      <MetricCard metrics={version.metrics} />

      {compliance && (
        <div className="compliance">
          <span className="score mono">{compliance.score}%</span>
          <div>
            <strong>Compliance score</strong>
            <span className="muted"> Required: {compliance.required.join(", ") || "none"}</span>
            <div className="meter" aria-hidden="true"><span style={{ width: `${compliance.score}%` }} /></div>
          </div>
        </div>
      )}

      {(version.datasetNotes || version.trainingNotes) && (
        <details className="notes">
          <summary>Dataset &amp; training notes</summary>
          {version.datasetNotes && <p><strong>Dataset:</strong> {version.datasetNotes}</p>}
          {version.trainingNotes && <p><strong>Training:</strong> {version.trainingNotes}</p>}
        </details>
      )}

      {version.reviewComment && (
        <blockquote className="review-comment">
          <span className="kicker">Reviewer comment</span>
          {version.reviewComment}
        </blockquote>
      )}

      <ErrorBox>{error}</ErrorBox>

      {/* ML Engineer: submit a draft for review */}
      {canSubmit && (
        <div className="action-bar">
          <button disabled={busy} onClick={() => runAction(() => api.post(`/versions/${versionId}/submit`))}>
            Submit for review
          </button>
        </div>
      )}

      {/* Compliance Officer: approve/reject a submitted version */}
      {canReview && (
        <div className="action-bar review">
          <label>
            Reviewer comment {isHighRisk && <strong className="req">Required for high-risk versions</strong>}
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div className="btn-row">
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
              className="danger"
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
      {canDeploy && (
        <div className="action-bar">
          <button disabled={busy} onClick={() => runAction(() => api.post(`/versions/${versionId}/deploy`))}>
            Deploy
          </button>
        </div>
      )}

      {/* Any role: simulate drift on a deployed version (deliberately open, see build plan) */}
      {canDrift && (
        <div className="action-bar">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => runAction(() => api.post(`/versions/${versionId}/simulate-drift`))}
          >
            Simulate next snapshot
          </button>
        </div>
      )}

      {snapshots && snapshots.length > 0 && (
        <section className="section">
          <div className="section-head"><h3>Snapshot history</h3></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th className="num">Accuracy</th>
                  <th className="num">Drift Δ</th>
                  <th>Flagged</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s._id}>
                    <td className="muted mono nowrap">{new Date(s.createdAt).toLocaleString()}</td>
                    <td className="num mono">{Number(s.accuracy).toFixed(3)}</td>
                    <td className="num mono">{Number(s.driftDelta).toFixed(3)}</td>
                    <td>
                      {s.flagged ? (
                        <span className="flag"><Icon name="alert" size={14} /> Flagged</span>
                      ) : (
                        <span className="muted">No</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </article>
  );
}
