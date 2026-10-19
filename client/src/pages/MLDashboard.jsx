import React, { useEffect, useRef, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { ML_SECTIONS } from "../navConfig.js";
import api, { extractError } from "../api/axios.js";
import { useToast } from "../context/ToastContext.jsx";
import ModelList from "../components/ModelList.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";
import Pagination from "../components/Pagination.jsx";
import { useDebounced, useKeyedPage, useMounted } from "../components/featureUtils.js";
import { Icon, PageHeader, Loading, ErrorBox } from "../components/ui.jsx";

const PAGE_SIZE = 12;
const LIMITS = { name: 120, description: 2000, useCase: 200 };
const EMPTY_FORM = { name: "", description: "", useCase: "" };

function validate(form) {
  const errors = {};
  const name = form.name.trim();
  if (!name) errors.name = "Name is required";
  else if (name.length > LIMITS.name) errors.name = `Name must be at most ${LIMITS.name} characters`;
  if (form.useCase.trim().length > LIMITS.useCase) errors.useCase = `Use case must be at most ${LIMITS.useCase} characters`;
  if (form.description.trim().length > LIMITS.description) errors.description = `Description must be at most ${LIMITS.description} characters`;
  return errors;
}

export default function MLDashboard() {
  const section = useParams()["*"] || "";
  const meta0 = ML_SECTIONS.find((x) => x.id === section);
  if (!meta0) return <Navigate to="/ml" replace />;
  if (section === "activity") {
    return (
      <main className="page">
        <PageHeader kicker={meta0.kicker} title={meta0.title} description={meta0.description} />
        <AuditLogTable />
      </main>
    );
  }
  return <MLRegistry />;
}

function MLRegistry() {
  const toast = useToast();
  const mounted = useMounted();
  const reqId = useRef(0);

  const [models, setModels] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState("");
  const q = useDebounced(search.trim(), 300);
  // The page belongs to the current filters: a filter change resets it in the same render.
  const [page, setPage] = useKeyedPage(`${q}|${tier}`);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState({});
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    const params = { page, limit: PAGE_SIZE };
    if (q) params.q = q;
    if (tier) params.tier = tier;
    api
      .get("/models", { params })
      .then(({ data }) => {
        if (id !== reqId.current) return;
        setModels(Array.isArray(data.models) ? data.models : []);
        setMeta({ page: data.page || 1, pages: data.pages || 1, total: data.total ?? 0 });
        setError("");
      })
      .catch((err) => {
        if (id === reqId.current) setError(extractError(err));
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
    return () => {
      reqId.current += 1;
    };
  }, [page, q, tier, refreshKey]);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((fe) => ({ ...fe, [key]: undefined }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (creating) return;
    const errors = validate(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    setCreating(true);
    try {
      await api.post("/models", {
        name: form.name.trim(),
        description: form.description.trim(),
        useCase: form.useCase.trim(),
      });
      if (!mounted.current) return;
      toast.success("Model registered");
      setForm(EMPTY_FORM);
      setShowForm(false);
      setSearch("");
      setTier("");
      setPage(1);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (!mounted.current) return;
      const status = err?.response?.status;
      const serverFields = err?.response?.data?.fields;
      const message = extractError(err);
      if (status === 409) setFieldErrors({ name: message });
      else if (serverFields && typeof serverFields === "object") setFieldErrors(serverFields);
      else toast.error(message);
    } finally {
      if (mounted.current) setCreating(false);
    }
  }

  const filtering = !!(q || tier);

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

      {showForm && (
        <form onSubmit={handleCreate} className="panel form-panel" noValidate>
          <h2>Register a model</h2>
          <label>
            <span>Name <span className="req" aria-hidden="true">*</span></span>
            <input
              required
              autoFocus
              maxLength={LIMITS.name + 20}
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              aria-invalid={fieldErrors.name ? "true" : undefined}
              aria-describedby={fieldErrors.name ? "mf-name-err" : undefined}
            />
            {fieldErrors.name && <span id="mf-name-err" className="field-error" role="alert">{fieldErrors.name}</span>}
          </label>
          <label>
            Business use case
            <input
              maxLength={LIMITS.useCase + 20}
              value={form.useCase}
              onChange={(e) => setField("useCase", e.target.value)}
              aria-invalid={fieldErrors.useCase ? "true" : undefined}
              aria-describedby={fieldErrors.useCase ? "mf-use-err" : undefined}
            />
            {fieldErrors.useCase && <span id="mf-use-err" className="field-error" role="alert">{fieldErrors.useCase}</span>}
          </label>
          <label>
            Description
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
              aria-invalid={fieldErrors.description ? "true" : undefined}
              aria-describedby={fieldErrors.description ? "mf-desc-err" : undefined}
            />
            {fieldErrors.description && <span id="mf-desc-err" className="field-error" role="alert">{fieldErrors.description}</span>}
          </label>
          <div className="btn-row">
            <button type="submit" disabled={creating} aria-busy={creating}>
              {creating ? "Creating…" : "Create model"}
            </button>
          </div>
        </form>
      )}

      <form className="filter-bar registry-filters" role="search" onSubmit={(e) => e.preventDefault()} aria-label="Search models">
        <label className="grow">
          Search
          <input
            type="search"
            placeholder="Search by name"
            maxLength={120}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Risk tier
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">All tiers</option>
            <option value="low">Low risk</option>
            <option value="medium">Medium risk</option>
            <option value="high">High risk</option>
            <option value="unrated">Unrated</option>
          </select>
        </label>
      </form>

      <ErrorBox>{error}</ErrorBox>

      {loading && models.length === 0 ? (
        <Loading />
      ) : models.length === 0 ? (
        !error && (
          <div className="empty-state">
            {filtering ? "No models match your search." : "No models registered yet. Register one to get started."}
          </div>
        )
      ) : (
        <div aria-busy={loading}>
          <ModelList models={models} />
          <Pagination page={meta.page} pages={meta.pages} total={meta.total} limit={PAGE_SIZE} onPage={setPage} />
        </div>
      )}

    </main>
  );
}
