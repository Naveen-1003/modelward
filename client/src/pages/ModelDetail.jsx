import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import RiskBadge from "../components/RiskBadge.jsx";
import VersionDetail from "../components/VersionDetail.jsx";

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

  if (loading && !model) return <p className="page muted">Loading...</p>;
  if (error && !model) return <main className="page"><div className="error-box">{error}</div></main>;
  if (!model) return null;

  return (
    <main className="page">
      <p><Link to="/ml" className="btn-link">&larr; Back to registry</Link></p>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>{model.name}</h2>
        <RiskBadge riskTier={model.latestRiskTier} />
      </div>
      <p className="muted">{model.description}</p>
      {model.useCase && <p className="muted">Use case: {model.useCase}</p>}

      {error && <div className="error-box">{error}</div>}

      {user.role === "ml_engineer" && (
        <>
          <button onClick={() => setShowForm((s) => !s)} style={{ marginTop: "0.5rem" }}>
            {showForm ? "Cancel" : "+ Upload New Version"}
          </button>

          {showForm && (
            <form onSubmit={handleUpload} className="card" style={{ marginTop: "1rem" }}>
              <label>
                File type
                <select value={fileType} onChange={(e) => setFileType(e.target.value)}>
                  {FILE_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>

              <label>
                {fileType === "csv" ? "Predictions CSV" : "Model file (.pkl / .joblib)"}
                <input
                  type="file"
                  required
                  onChange={(e) => setFile(e.target.files[0])}
                />
              </label>

              {fileType !== "csv" && (
                <label>
                  Companion dataset CSV (features + actual + protected_attribute)
                  <input type="file" required onChange={(e) => setDatasetFile(e.target.files[0])} />
                </label>
              )}

              {fileType === "csv" && (
                <label>
                  Self-reported latency (ms) -- no real inference happens for a CSV upload
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
                <textarea value={datasetNotes} onChange={(e) => setDatasetNotes(e.target.value)} />
              </label>
              <label>
                Training notes
                <textarea value={trainingNotes} onChange={(e) => setTrainingNotes(e.target.value)} />
              </label>

              <button type="submit" disabled={uploading} aria-busy={uploading}>
                Upload & Score
              </button>
            </form>
          )}
        </>
      )}

      <h3 style={{ marginTop: "2rem" }}>Versions</h3>
      {versions.length === 0 ? (
        <p className="muted">No versions uploaded yet.</p>
      ) : (
        <table className="compact">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Risk</th>
              <th>Accuracy</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v._id} style={{ background: v._id === selectedVersionId ? "#F5F7F8" : "transparent" }}>
                <td>v{v.versionNumber}</td>
                <td><StatusBadge status={v.status} /></td>
                <td><RiskBadge riskTier={v.riskTier} /></td>
                <td>{v.metrics?.accuracy != null ? v.metrics.accuracy.toFixed(3) : "—"}</td>
                <td>
                  <button className="btn-link" onClick={() => setSelectedVersionId(v._id)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedVersionId && (
        <div style={{ marginTop: "1.5rem" }}>
          <VersionDetail versionId={selectedVersionId} onChanged={() => setRefreshKey((k) => k + 1)} />
        </div>
      )}
    </main>
  );
}
