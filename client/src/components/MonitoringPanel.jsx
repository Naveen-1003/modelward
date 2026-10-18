import React, { useRef, useState } from "react";
import api from "../api/axios.js";
import { useConfig } from "../context/ConfigContext.jsx";
import { Icon, ErrorBox } from "./ui.jsx";
import { extOf, useMounted } from "./featureUtils.js";

// Real monitoring: re-score a fresh batch of predictions for a live version.
// `run` is VersionDetail's action helper (busy state, toasts, reload).
export default function MonitoringPanel({ versionId, run, disabled }) {
  const { config } = useConfig();
  const mounted = useMounted();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [latency, setLatency] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null); // null = idle, 0..100 uploading

  function validate() {
    if (!file) return "Choose a predictions CSV to upload";
    if (extOf(file.name) !== ".csv") return "The batch must be a .csv file";
    if (file.size > config.maxUploadMb * 1024 * 1024) return `File is larger than ${config.maxUploadMb} MB`;
    if (latency.trim() !== "") {
      const n = Number(latency);
      if (!Number.isFinite(n) || n < 0 || n > 600000) return "Latency must be a number between 0 and 600000 ms";
    }
    return "";
  }

  async function submit(e) {
    e.preventDefault();
    if (progress !== null) return;
    const problem = validate();
    setError(problem);
    if (problem) return;
    const fd = new FormData();
    fd.append("file", file);
    if (latency.trim() !== "") fd.append("latencyMs", String(Number(latency)));
    setProgress(0);
    const res = await run(
      "monitor",
      () =>
        api.post(`/versions/${versionId}/monitoring-batch`, fd, {
          onUploadProgress: (ev) => {
            if (mounted.current && ev.total) setProgress(Math.round((ev.loaded / ev.total) * 100));
          },
        }),
      (r) => {
        const d = r?.data || {};
        if (d.escalated) return "Snapshot added — risk tier escalated and drift flagged";
        if (d.snapshot?.flagged) return "Snapshot added — drift flagged";
        return "Snapshot added — within tolerance";
      }
    );
    if (!mounted.current) return;
    setProgress(null);
    if (res.ok) {
      setFile(null);
      setLatency("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const uploading = progress !== null;

  return (
    <details className="monitor-panel">
      <summary><Icon name="upload" /> Upload monitoring batch</summary>
      <form onSubmit={submit} noValidate>
        <p className="muted small">
          Re-scores this live version on fresh data and adds a snapshot. The CSV needs the columns{" "}
          <code className="mono">predicted</code>, <code className="mono">actual</code>,{" "}
          <code className="mono">protected_attribute</code> and optionally <code className="mono">probability</code>.
          The file is discarded after scoring.
        </p>
        <label>
          Predictions CSV
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            disabled={uploading || disabled}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <label>
          Latency (ms), optional
          <input
            type="number"
            step="0.01"
            min="0"
            max="600000"
            value={latency}
            disabled={uploading || disabled}
            onChange={(e) => setLatency(e.target.value)}
          />
        </label>
        <ErrorBox>{error}</ErrorBox>
        {uploading && (
          <div className="progress-wrap" role="status" aria-live="polite">
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-label="Upload progress"
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <span className="small muted">{progress >= 100 ? "Scoring…" : `Uploading ${progress}%`}</span>
          </div>
        )}
        <div className="btn-row">
          <button type="submit" disabled={uploading || disabled} aria-busy={uploading}>
            {uploading ? (progress >= 100 ? "Scoring…" : "Uploading…") : "Upload & score batch"}
          </button>
        </div>
      </form>
    </details>
  );
}
