import React, { useEffect, useState } from "react";
import api, { extractError } from "../api/axios.js";

function formatTime(iso) {
  return new Date(iso).toLocaleString();
}

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
    <section>
      <div className="section-title">
        <h3>Audit Trail</h3>
        <span className="muted">Read-only, all governance actions</span>
      </div>
      {error && <div className="error-box">{error}</div>}
      {loading ? (
        <p className="muted">Loading...</p>
      ) : logs.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="audit-table compact">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Role</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log._id}>
                  <td className="muted">{formatTime(log.createdAt)}</td>
                  <td>{log.actorName}</td>
                  <td className="muted">{log.actorRole}</td>
                  <td>{log.action}</td>
                  <td>{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
