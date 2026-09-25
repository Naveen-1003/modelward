import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import RiskBadge from "../components/RiskBadge.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";

export default function MLDashboard() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", useCase: "" });
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  function loadModels() {
    setLoading(true);
    api
      .get("/models")
      .then(({ data }) => setModels(data.models))
      .catch((err) => setError(extractError(err)))
      .finally(() => setLoading(false));
  }

  useEffect(loadModels, [refreshKey]);

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      await api.post("/models", form);
      setForm({ name: "", description: "", useCase: "" });
      setShowForm(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="page">
      <div className="section-title">
        <h2>Model Registry</h2>
        <button onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "+ Register Model"}
        </button>
      </div>
      <p className="muted">
        Risk tier is never chosen here -- it's computed automatically once a version is scored.
      </p>

      {error && <div className="error-box">{error}</div>}

      {showForm && (
        <form onSubmit={handleCreate} className="card" style={{ marginBottom: "1.5rem" }}>
          <label>
            Name
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Description
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label>
            Business use case
            <input value={form.useCase} onChange={(e) => setForm({ ...form, useCase: e.target.value })} />
          </label>
          <button type="submit" disabled={creating} aria-busy={creating}>
            Create
          </button>
        </form>
      )}

      {loading ? (
        <p className="muted">Loading models...</p>
      ) : models.length === 0 ? (
        <p className="muted">No models registered yet. Create one to get started.</p>
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
              <p className="muted">
                {m.latestVersionNumber ? `Latest: v${m.latestVersionNumber}` : "No versions uploaded yet"}
              </p>
            </Link>
          ))}
        </div>
      )}

      <div style={{ marginTop: "2.5rem" }}>
        <AuditLogTable refreshKey={refreshKey} />
      </div>
    </main>
  );
}
