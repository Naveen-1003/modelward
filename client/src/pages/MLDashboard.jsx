import React, { useEffect, useState } from "react";
import api, { extractError } from "../api/axios.js";
import ModelList from "../components/ModelList.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";
import { Icon, PageHeader, Loading, ErrorBox } from "../components/ui.jsx";

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
      <PageHeader
        kicker="ML engineering"
        title="Model registry"
        description="Track versions, measured performance, and readiness for review."
      >
        <button onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
          {!showForm && <Icon name="plus" />}
          {showForm ? "Cancel" : "Register model"}
        </button>
      </PageHeader>

      <p className="note">Risk is calculated automatically. Upload a scored version to establish a model's tier.</p>

      <ErrorBox>{error}</ErrorBox>

      {showForm && (
        <form onSubmit={handleCreate} className="panel form-panel">
          <h2>Register a model</h2>
          <label>
            Name
            <input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Business use case
            <input value={form.useCase} onChange={(e) => setForm({ ...form, useCase: e.target.value })} />
          </label>
          <label>
            Description
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <div className="btn-row">
            <button type="submit" disabled={creating} aria-busy={creating}>
              {creating ? "Creating…" : "Create model"}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <Loading />
      ) : models.length === 0 ? (
        <div className="empty-state">No models registered yet. Register one to get started.</div>
      ) : (
        <ModelList models={models} />
      )}

      <AuditLogTable refreshKey={refreshKey} />
    </main>
  );
}
