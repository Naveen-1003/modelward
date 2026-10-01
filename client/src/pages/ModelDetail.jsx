import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import RiskBadge from "../components/RiskBadge.jsx";
import VersionDetail from "../components/VersionDetail.jsx";
import { Icon, PageHeader, Loading, ErrorBox } from "../components/ui.jsx";

const FILE_TYPES = ["csv", "pickle", "joblib"];

export default function ModelDetail() {
  const { id } = useParams();
  const { user } = useAuth();

  const [model, setModel] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const [showForm, setShowForm] = useState(false);
  const [fileType, setFileType] = useState("csv");
  const [file, setFile] = useState(null);
  const [datasetFile, setDatasetFile] = useState(null);
  const [latencyMs, setLatencyMs] = useState("");
  const [datasetNotes, setDatasetNotes] = useState("");
  const [trainingNotes, setTrainingNotes] = useState("");
  const [uploading, setUploading] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([api.get(`/models/${id}`), api.get(`/models/${id}/versions`)])
      .then(([modelRes, versionsRes]) => {
        setModel(modelRes.data.model);
        setVersions(versionsRes.data.versions);
        if (versionsRes.data.versions.length > 0 && !selectedVersionId) {
          setSelectedVersionId(versionsRes.data.versions[0]._id);
        }
      })
      .catch((err) => setError(extractError(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [id, refreshKey]);

  async function handleUpload(e) {
    e.preventDefault();
    setError("");
    if (!file) return setError("Please choose a file to upload");
    if (fileType !== "csv" && !datasetFile) {
      return setError("A companion dataset CSV is required for pickle/joblib uploads");
    }
    if (fileType === "csv" && latencyMs === "") {
      return setError("Please self-report a latency value (ms) for CSV uploads");
    }

    const form = new FormData();
    form.append("fileType", fileType);
    form.append("file", file);
    if (datasetFile) form.append("datasetFile", datasetFile);
    if (fileType === "csv") form.append("latencyMs", latencyMs);
    form.append("datasetNotes", datasetNotes);
    form.append("trainingNotes", trainingNotes);

    setUploading(true);
    try {
      const { data } = await api.post(`/models/${id}/versions`, form);
      setFile(null);
      setDatasetFile(null);
      setLatencyMs("");
      setDatasetNotes("");
      setTrainingNotes("");
      setShowForm(false);
      setSelectedVersionId(data.version._id);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setUploading(false);
    }
  }

  if (loading && !model) return <main className="page"><Loading /></main>;
  if (error && !model) return <main className="page"><ErrorBox>{error}</ErrorBox></main>;
  if (!model) return null;

  return (
    <main className="page">
      <Link to="/ml" className="back-link"><Icon name="back" /> Registry</Link>
      <PageHeader kicker="Governance record" title={model.name} description={model.description || "No description provided."}>
        <RiskBadge riskTier={model.latestRiskTier} />
      </PageHeader>
      {model.useCase && (
        <p className="use-case"><span className="kicker">Use case</span>{model.useCase}</p>
      )}

      <ErrorBox>{error}</ErrorBox>

      {user.role === "ml_engineer" && (
        <>
          <button onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
            {!showForm && <Icon name="plus" />}
            {showForm ? "Cancel" : "Upload new version"}
          </button>

          {showForm && (
            <form onSubmit={handleUpload} className="panel form-panel">
              <h2>Upload a version</h2>
              <fieldset className="segmented">
                <legend>File type</legend>
                {FILE_TYPES.map((t) => (
                  <label key={t}>
                    <input type="radio" name="fileType" value={t} checked={fileType === t} onChange={() => setFileType(t)} />
                    <span>{t}</span>
                  </label>
                ))}
              </fieldset>

              <label>
                {fileType === "csv" ? "Predictions CSV" : "Model file (.pkl / .joblib)"}
                <input type="file" required onChange={(e) => setFile(e.target.files[0])} />
              </label>

              {fileType !== "csv" && (
                <label>
                  Companion dataset CSV
                  <small className="hint">Features, actual and protected_attribute columns</small>
                  <input type="file" required onChange={(e) => setDatasetFile(e.target.files[0])} />
                </label>
              )}

              {fileType === "csv" && (
                <label>
                  Self-reported latency (ms)
                  <small className="hint">No real inference runs for a CSV upload, so latency is taken as reported</small>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={latencyMs}
                    onChange={(e) => setLatencyMs(e.target.value)}
                  />
                </label>
              )}

              <label>
                Dataset notes
                <textarea rows={3} value={datasetNotes} onChange={(e) => setDatasetNotes(e.target.value)} />
              </label>
              <label>
                Training notes
                <textarea rows={3} value={trainingNotes} onChange={(e) => setTrainingNotes(e.target.value)} />
              </label>

              <div className="btn-row">
                <button type="submit" disabled={uploading} aria-busy={uploading}>
                  {uploading ? "Scoring…" : "Upload & score"}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <section className="section">
        <div className="section-head"><h2>Versions</h2><span className="muted">{versions.length} registered</span></div>
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
                    <span className="mono muted">{v.metrics?.accuracy != null ? v.metrics.accuracy.toFixed(3) : "—"}</span>
                  </span>
                  <span className="queue-bottom">
                    <StatusBadge status={v.status} />
                    <RiskBadge riskTier={v.riskTier} />
                  </span>
                </button>
              ))}
            </nav>
            <div className="split-detail">
              {selectedVersionId && (
                <VersionDetail versionId={selectedVersionId} onChanged={() => setRefreshKey((k) => k + 1)} />
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
