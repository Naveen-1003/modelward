import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../components/ConfirmDialog.jsx";
import { roleHome } from "../roleHome.js";
import StatusBadge from "../components/StatusBadge.jsx";
import RiskBadge from "../components/RiskBadge.jsx";
import VersionDetail from "../components/VersionDetail.jsx";
import VersionCompare from "../components/VersionCompare.jsx";
import { MAX_NOTES, extOf, useMounted } from "../components/featureUtils.js";
import { Icon, PageHeader, Loading, ErrorBox } from "../components/ui.jsx";

const ALL_FILE_TYPES = ["csv", "pickle", "joblib"];
const MODEL_EXTS = [".pkl", ".pickle", ".joblib"];

function UploadForm({ modelId, prefill, onUploaded, onCancel }) {
  const { config } = useConfig();
  const toast = useToast();
  const mounted = useMounted();
  const fileTypes = ALL_FILE_TYPES.filter((t) => t === "csv" || config.allowModelFiles);

  const initialType = prefill?.fileType && fileTypes.includes(prefill.fileType) ? prefill.fileType : "csv";
  const [fileType, setFileType] = useState(initialType);
  const [file, setFile] = useState(null);
  const [datasetFile, setDatasetFile] = useState(null);
  const [inputKey, setInputKey] = useState(0); // remounts file inputs to clear them
  const [latencyMs, setLatencyMs] = useState("");
  const [datasetNotes, setDatasetNotes] = useState(prefill?.datasetNotes || "");
  const [trainingNotes, setTrainingNotes] = useState(prefill?.trainingNotes || "");
  const [errors, setErrors] = useState({});
  const [progress, setProgress] = useState(null); // null idle, 0..100
  const maxBytes = config.maxUploadMb * 1024 * 1024;
  const isCsv = fileType === "csv";
  const uploading = progress !== null;

  function chooseType(t) {
    setFileType(t);
    setFile(null);
    setDatasetFile(null);
    setInputKey((k) => k + 1);
    setErrors({});
  }

  function validate() {
    const e = {};
    if (!fileTypes.includes(fileType)) e.fileType = "Choose a supported file type";
    if (!file) e.file = isCsv ? "Choose a predictions CSV" : "Choose a model file";
    else if (isCsv && extOf(file.name) !== ".csv") e.file = "Predictions file must be a .csv";
    else if (!isCsv && !MODEL_EXTS.includes(extOf(file.name))) e.file = "Model file must be .pkl, .pickle or .joblib";
    else if (file.size > maxBytes) e.file = `File is larger than ${config.maxUploadMb} MB`;
    if (!isCsv) {
      if (!datasetFile) e.datasetFile = "A companion dataset CSV is required for model files";
      else if (extOf(datasetFile.name) !== ".csv") e.datasetFile = "Dataset must be a .csv";
      else if (datasetFile.size > maxBytes) e.datasetFile = `File is larger than ${config.maxUploadMb} MB`;
    }
    if (isCsv) {
      const n = Number(latencyMs);
      if (latencyMs.trim() === "") e.latencyMs = "Please self-report a latency value (ms) for CSV uploads";
      else if (!Number.isFinite(n) || n < 0) e.latencyMs = "Latency must be a number of milliseconds, 0 or more";
      else if (n > 600000) e.latencyMs = "Latency must be at most 600000 ms";
    }
    if (datasetNotes.length > MAX_NOTES) e.datasetNotes = `Dataset notes must be at most ${MAX_NOTES} characters`;
    if (trainingNotes.length > MAX_NOTES) e.trainingNotes = `Training notes must be at most ${MAX_NOTES} characters`;
    return e;
  }

  async function handleUpload(ev) {
    ev.preventDefault();
    if (uploading) return;
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;

    const body = new FormData();
    body.append("fileType", fileType);
    body.append("file", file);
    if (datasetFile && !isCsv) body.append("datasetFile", datasetFile);
    // Normalise (".5" -> "0.5"): the server only accepts plain decimals.
    if (isCsv) body.append("latencyMs", String(Number(latencyMs)));
    body.append("datasetNotes", datasetNotes);
    body.append("trainingNotes", trainingNotes);

    setProgress(0);
    try {
      const { data } = await api.post(`/models/${modelId}/versions`, body, {
        onUploadProgress: (p) => {
          if (mounted.current && p.total) setProgress(Math.round((p.loaded / p.total) * 100));
        },
      });
      const v = data.version;
      if (v?.status === "upload_failed") {
        toast.error(`Saved as v${v.versionNumber}, but scoring failed: ${v.uploadError || "see the version for details"}`);
      } else {
        toast.success(v?.versionNumber ? `Version ${v.versionNumber} uploaded and scored` : "Version uploaded and scored");
      }
      onUploaded(v);
    } catch (err) {
      if (!mounted.current) return;
      const fields = err?.response?.data?.fields;
      setErrors({ form: extractError(err), ...(fields && typeof fields === "object" ? fields : {}) });
    } finally {
      if (mounted.current) setProgress(null);
    }
  }

  const err = (k) => (errors[k] ? { "aria-invalid": "true", "aria-describedby": `uf-${k}-err` } : {});
  const errMsg = (k) =>
    errors[k] ? <span id={`uf-${k}-err`} className="field-error" role="alert">{errors[k]}</span> : null;

  return (
    <form onSubmit={handleUpload} className="panel form-panel" noValidate aria-label="Upload a version">
      <h2>Upload a version</h2>
      {prefill && <p className="note small">Pre-filled from version {prefill.fromVersionNumber}. Choose the new files to continue.</p>}
      <fieldset className="segmented" disabled={uploading}>
        <legend>File type</legend>
        {fileTypes.map((t) => (
          <label key={t}>
            <input type="radio" name="fileType" value={t} checked={fileType === t} onChange={() => chooseType(t)} />
            <span>{t}</span>
          </label>
        ))}
      </fieldset>
      {!config.allowModelFiles && (
        <p className="hint">
          Pickle and joblib uploads are turned off on this server because loading a model file runs its code. Upload a predictions CSV instead.
        </p>
      )}

      <label>
        {isCsv ? "Predictions CSV" : "Model file (.pkl / .joblib)"}
        <small className="hint">
          {isCsv ? "Columns: predicted, actual, protected_attribute (optional: probability)" : `Up to ${config.maxUploadMb} MB`}
        </small>
        <input
          key={`f-${inputKey}`}
          type="file"
          accept={isCsv ? ".csv,text/csv" : MODEL_EXTS.join(",")}
          disabled={uploading}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          {...err("file")}
        />
        {errMsg("file")}
      </label>

      {!isCsv && (
        <label>
          Companion dataset CSV
          <small className="hint">Features, actual and protected_attribute columns</small>
          <input
            key={`d-${inputKey}`}
            type="file"
            accept=".csv,text/csv"
            disabled={uploading}
            onChange={(e) => setDatasetFile(e.target.files?.[0] || null)}
            {...err("datasetFile")}
          />
          {errMsg("datasetFile")}
        </label>
      )}

      {isCsv && (
        <label>
          Self-reported latency (ms)
          <small className="hint">No real inference runs for a CSV upload, so latency is taken as reported</small>
          <input
            type="number"
            step="0.01"
            min="0"
            max="600000"
            value={latencyMs}
            disabled={uploading}
            onChange={(e) => setLatencyMs(e.target.value)}
            {...err("latencyMs")}
          />
          {errMsg("latencyMs")}
        </label>
      )}

      <label>
        Dataset notes
        <textarea rows={3} value={datasetNotes} disabled={uploading} onChange={(e) => setDatasetNotes(e.target.value)} {...err("datasetNotes")} />
        <span className={`hint mono${datasetNotes.length > MAX_NOTES ? " over" : ""}`}>{datasetNotes.length}/{MAX_NOTES}</span>
        {errMsg("datasetNotes")}
      </label>
      <label>
        Training notes
        <textarea rows={3} value={trainingNotes} disabled={uploading} onChange={(e) => setTrainingNotes(e.target.value)} {...err("trainingNotes")} />
        <span className={`hint mono${trainingNotes.length > MAX_NOTES ? " over" : ""}`}>{trainingNotes.length}/{MAX_NOTES}</span>
        {errMsg("trainingNotes")}
      </label>

      <ErrorBox>{errors.form}</ErrorBox>

      {uploading && (
        <div className="progress-wrap" role="status" aria-live="polite">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Upload progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <span className="small muted">{progress >= 100 ? "Scoring… this can take a moment" : `Uploading ${progress}%`}</span>
        </div>
      )}

      <div className="btn-row">
        <button type="submit" disabled={uploading} aria-busy={uploading}>
          {uploading ? (progress >= 100 ? "Scoring…" : "Uploading…") : "Upload & score"}
        </button>
        <button type="button" className="secondary" disabled={uploading} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function ModelDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const wantedVersion = searchParams.get("version");
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const mounted = useMounted();
  const reqId = useRef(0);
  const formRef = useRef(null);

  const [model, setModel] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [prefill, setPrefill] = useState(null);

  // A different model is a clean slate.
  useEffect(() => {
    setModel(null);
    setVersions([]);
    setSelectedVersionId(null);
    setNotFound(false);
    setError("");
    setShowForm(false);
    setPrefill(null);
    setShowCompare(false);
  }, [id]);

  const load = useCallback(() => {
    const rid = ++reqId.current;
    setLoading(true);
    Promise.all([api.get(`/models/${id}`), api.get(`/models/${id}/versions`)])
      .then(([modelRes, versionsRes]) => {
        if (rid !== reqId.current) return;
        const list = Array.isArray(versionsRes.data.versions) ? versionsRes.data.versions : [];
        setModel(modelRes.data.model);
        setVersions(list);
        setError("");
        setNotFound(false);
        const ids = list.map((v) => v._id);
        // keep the current selection, else honour ?version=, else newest
        setSelectedVersionId((prev) => {
          if (prev && ids.includes(prev)) return prev;
          if (wantedVersion && ids.includes(wantedVersion)) return wantedVersion;
          return ids[0] || null;
        });
      })
      .catch((err) => {
        if (rid !== reqId.current) return;
        if (err?.response?.status === 404) setNotFound(true);
        else setError(extractError(err));
      })
      .finally(() => {
        if (rid === reqId.current) setLoading(false);
      });
    // wantedVersion is applied by the effect below on later changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    load();
    return () => {
      reqId.current += 1;
    };
  }, [load, refreshKey]);

  // Following a ?version= link from the compliance queue while already on this model.
  // Applied once per distinct link: later reloads (after an action or an upload) must not
  // snap the selection back to it.
  const appliedWanted = useRef("");
  useEffect(() => {
    if (!wantedVersion) return;
    const key = `${id}:${wantedVersion}`;
    if (appliedWanted.current === key) return;
    if (versions.some((v) => v._id === wantedVersion)) {
      appliedWanted.current = key;
      setSelectedVersionId(wantedVersion);
    }
  }, [id, wantedVersion, versions]);

  // Scroll the form into view when a clone opens it.
  useEffect(() => {
    if (formKey > 0 && showForm && formRef.current) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      formRef.current.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }
  }, [formKey, showForm]);

  function handleClone(version) {
    setPrefill({
      fileType: version.fileType,
      datasetNotes: version.datasetNotes || "",
      trainingNotes: version.trainingNotes || "",
      fromVersionNumber: version.versionNumber,
    });
    setFormKey((k) => k + 1);
    setShowForm(true);
  }

  function toggleForm() {
    if (showForm) {
      setShowForm(false);
      return;
    }
    setPrefill(null);
    setFormKey((k) => k + 1);
    setShowForm(true);
  }

  function handleUploaded(version) {
    setShowForm(false);
    setPrefill(null);
    if (version?._id) setSelectedVersionId(version._id);
    setRefreshKey((k) => k + 1);
  }

  async function archiveModel() {
    const reason = await confirm({
      title: `Archive “${model.name}”?`,
      message: "The model and all its versions move to Trash. This is blocked while a version is live. An admin can restore it.",
      confirmLabel: "Archive model",
      danger: true,
      requireReason: true,
      reasonLabel: "Reason for archiving",
      maxLength: 500, // the server caps the archive reason at 500
    });
    if (!reason) return;
    setArchiving(true);
    try {
      await api.delete(`/models/${id}`, { data: { reason } });
      toast.success("Model archived");
      navigate(roleHome(user.role), { replace: true });
    } catch (err) {
      toast.error(extractError(err));
      if (mounted.current) setArchiving(false);
    }
  }

  const home = roleHome(user?.role);
  const backLabel = user?.role === "ml_engineer" ? "Registry" : user?.role === "compliance_officer" ? "Review queue" : "Overview";

  if (loading && !model && !notFound) return <main className="page"><Loading /></main>;
  if (notFound) {
    return (
      <main className="page">
        <Link to={home} className="back-link"><Icon name="back" /> {backLabel}</Link>
        <div className="empty-state" role="status">
          <p><strong>This model could not be found.</strong></p>
          <p>It may have been archived or removed.</p>
        </div>
      </main>
    );
  }
  if (error && !model) {
    return (
      <main className="page">
        <Link to={home} className="back-link"><Icon name="back" /> {backLabel}</Link>
        <ErrorBox>{error}</ErrorBox>
      </main>
    );
  }
  if (!model) return null;

  const tier = model.displayRiskTier || model.latestRiskTier;
  const hasLive = model.liveVersionNumber != null;
  const showLatest = model.latestVersionNumber != null && model.latestVersionNumber !== model.liveVersionNumber;

  return (
    <main className="page">
      <Link to={home} className="back-link"><Icon name="back" /> {backLabel}</Link>
      <PageHeader kicker="Governance record" title={model.name} description={model.description || "No description provided."}>
        <div className="header-chips">
          {hasLive && <span className="chip chip-live" title="Version currently live">Live: v{model.liveVersionNumber}</span>}
          {showLatest && <span className="chip" title="Most recently uploaded version">Latest: v{model.latestVersionNumber}</span>}
          <RiskBadge riskTier={tier} />
        </div>
        {user?.role === "admin" && (
          <button type="button" className="danger" onClick={archiveModel} disabled={archiving} aria-busy={archiving}>
            <Icon name="trash" /> Archive model
          </button>
        )}
      </PageHeader>
      {model.useCase && (
        <p className="use-case"><span className="kicker">Use case</span>{model.useCase}</p>
      )}

      <ErrorBox>{error}</ErrorBox>

      {user?.role === "ml_engineer" && (
        <>
          <button onClick={toggleForm} aria-expanded={showForm}>
            {!showForm && <Icon name="plus" />}
            {showForm ? "Cancel" : "Upload new version"}
          </button>

          {showForm && (
            <div ref={formRef} className="scroll-target">
              <UploadForm
                key={formKey}
                modelId={id}
                prefill={prefill}
                onUploaded={handleUploaded}
                onCancel={() => setShowForm(false)}
              />
            </div>
          )}
        </>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Versions</h2>
          <span className="muted">
            {versions.length} registered
            {versions.length >= 2 && (
              <>
                {" · "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setShowCompare((s) => !s)}
                  aria-expanded={showCompare}
                >
                  <Icon name="compare" size={14} /> {showCompare ? "Hide comparison" : "Compare versions"}
                </button>
              </>
            )}
          </span>
        </div>

        {showCompare && versions.length >= 2 && <VersionCompare versions={versions} />}

        {versions.length === 0 ? (
          <div className="empty-state">No versions uploaded yet.</div>
        ) : (
          <div className="split">
            <nav className="queue" aria-label="Versions">
              {versions.map((v) => (
                <button
                  key={v._id}
                  className={`queue-item${v._id === selectedVersionId ? " is-selected" : ""}`}
                  aria-current={v._id === selectedVersionId ? "true" : undefined}
                  onClick={() => setSelectedVersionId(v._id)}
                >
                  <span className="queue-top">
                    <strong className="mono">v{v.versionNumber}</strong>
                    <span className="mono muted">{v.metrics?.accuracy != null ? Number(v.metrics.accuracy).toFixed(3) : "—"}</span>
                  </span>
                  <span className="queue-bottom">
                    <span className="badge-row">
                      <StatusBadge status={v.status} />
                      {v.status === "needs_review" && (
                        <span className="flag" title="Drift flagged: needs a compliance decision">
                          <Icon name="alert" size={14} />
                          <span className="sr-only">Drift flagged</span>
                        </span>
                      )}
                    </span>
                    <RiskBadge riskTier={v.riskTier} />
                  </span>
                </button>
              ))}
            </nav>
            <div className="split-detail">
              {selectedVersionId && (
                <VersionDetail
                  versionId={selectedVersionId}
                  onChanged={() => setRefreshKey((k) => k + 1)}
                  onClone={handleClone}
                />
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
