import React, { useEffect, useState } from "react";
import api, { extractError } from "../api/axios.js";
import { ErrorBox, Loading } from "./ui.jsx";

function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const ACTION_LABELS = {
  create_model: "Model created",
  upload_version: "Version uploaded",
  submit_version: "Submitted for review",
  approve: "Approved",
  reject: "Rejected",
  deploy: "Deployed",
  simulate_drift: "Drift snapshot",
};

export default function AuditLogTable({ limit = 50, refreshKey }) {
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/audit-log?limit=${limit}`)
      .then(({ data }) => {
        if (!cancelled) setLogs(data.logs);
      })
      .catch((err) => {
        if (!cancelled) setError(extractError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [limit, refreshKey]);

  return (
    <section className="section">
      <div className="section-head">
        <h2>Audit trail</h2>
        <span className="muted">Read-only record of every governance action</span>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {loading ? (
        <Loading />
      ) : logs.length === 0 ? (
        <div className="empty-state">No activity yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log._id}>
                  <td className="mono muted nowrap">{formatTime(log.createdAt)}</td>
                  <td>
                    {log.actorName}
                    <span className="sub">{log.actorRole.replace(/_/g, " ")}</span>
                  </td>
                  <td className="nowrap"><span className="badge badge-status-draft">{ACTION_LABELS[log.action] || log.action}</span></td>
                  <td className="muted">{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
