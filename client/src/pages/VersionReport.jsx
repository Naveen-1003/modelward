import React, { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import StatusBadge from "../components/StatusBadge.jsx";
import RiskBadge from "../components/RiskBadge.jsx";
import { fmt, fmtDateTime, roleLabel } from "../components/featureUtils.js";
import { Icon, Loading, ErrorBox } from "../components/ui.jsx";

const METRIC_ROWS = [
  { key: "accuracy", label: "Accuracy", note: "Share of rows predicted correctly" },
  { key: "fairnessGap", label: "Fairness gap", note: "Max − min per-group accuracy; lower is better" },
  { key: "precision", label: "Precision", note: "Predicted positives that were truly positive" },
  { key: "recall", label: "Recall", note: "True positives that were found" },
  { key: "f1", label: "F1", note: "Balance of precision and recall" },
  { key: "auc", label: "AUC", note: "Ranking quality of predicted probabilities" },
  { key: "demographicParityDiff", label: "Demographic parity difference", note: "Gap in positive-prediction rate between groups; closer to 0 is fairer" },
  { key: "equalOpportunityDiff", label: "Equal opportunity difference", note: "Gap in true-positive rate between groups; closer to 0 is fairer" },
  { key: "disparateImpactRatio", label: "Disparate impact ratio", note: "Lowest ÷ highest group positive rate; 80% rule: ≥ 0.80 is typical" },
];

const SOURCE_LABEL = { baseline: "Baseline", simulated: "Simulated", batch: "Batch upload" };

export default function VersionReport() {
  const { id } = useParams();
  const reqId = useRef(0);
  const [data, setData] = useState(null);
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [generatedAt, setGeneratedAt] = useState(() => new Date());

  useEffect(() => {
    const rid = ++reqId.current;
    setLoading(true);
    setData(null);
    setComments([]);
    setError("");
    setNotFound(false);
    Promise.all([
      api.get(`/versions/${id}`),
      // the discussion is a nice-to-have: never fail the whole report on it
      api.get(`/versions/${id}/comments`).catch(() => ({ data: { comments: [] } })),
    ])
      .then(([v, c]) => {
        if (rid !== reqId.current) return;
        setData(v.data);
        setComments(Array.isArray(c.data.comments) ? c.data.comments : []);
        setGeneratedAt(new Date());
      })
      .catch((err) => {
        if (rid !== reqId.current) return;
        if (err?.response?.status === 404) setNotFound(true);
        else setError(extractError(err));
      })
      .finally(() => {
        if (rid === reqId.current) setLoading(false);
      });
    return () => {
      reqId.current += 1;
    };
  }, [id]);

  if (loading) return <main className="page report-page"><Loading rows={5} /></main>;
  if (notFound) {
    return (
      <main className="page report-page">
        <div className="empty-state" role="status">
          <p><strong>This version could not be found.</strong></p>
          <p>It may have been archived or you may not have access to it.</p>
        </div>
      </main>
    );
  }
  if (error || !data) return <main className="page report-page"><ErrorBox>{error || "Could not load the report."}</ErrorBox></main>;

  const { version, compliance, snapshots } = data;
  const model = version.modelId && typeof version.modelId === "object" ? version.modelId : {};
  const metrics = version.metrics || {};
  const groups = Array.isArray(metrics.groups) ? metrics.groups : [];
  const th = version.thresholdsUsed;
  const checks = Array.isArray(compliance?.checks) ? compliance.checks : null;
  const warnings = Array.isArray(version.scoringWarnings) ? version.scoringWarnings.filter(Boolean) : [];
  const tierChanged = version.initialRiskTier && version.initialRiskTier !== version.riskTier;
  const reviewer = version.reviewedByName || "";
  const hasReview = version.reviewComment || version.reviewedAt;
  const latencyTag =
    metrics.latencyMs == null ? "" : metrics.computedBy === "microservice" ? "measured" : metrics.computedBy === "self_reported" ? "self-reported" : "";

  return (
    <main className="page report-page">
      <div className="report-toolbar no-print">
        {model._id ? (
          <Link to={`/models/${model._id}?version=${version._id}`} className="back-link"><Icon name="back" /> Back to model</Link>
        ) : <span />}
        <button type="button" onClick={() => window.print()}>
          <Icon name="print" /> Print / Save as PDF
        </button>
      </div>

      <article className="report">
        <header className="report-head">
          <span className="kicker">Model card &amp; compliance report</span>
          <h1>{model.name || "Model"}</h1>
          {model.description && <p className="report-desc">{model.description}</p>}
          {model.useCase && <p><span className="kicker inline">Use case</span> {model.useCase}</p>}
        </header>

        <section className="report-section" aria-labelledby="r-summary">
          <h2 id="r-summary">Version summary</h2>
          <dl className="report-grid">
            <div><dt>Version</dt><dd className="mono">v{version.versionNumber}</dd></div>
            <div><dt>Status</dt><dd><StatusBadge status={version.status} /></dd></div>
            <div>
              <dt>Risk tier</dt>
              <dd>
                {tierChanged ? (
                  <span className="tier-shift">
                    <RiskBadge riskTier={version.initialRiskTier} /> <span aria-label="changed to">→</span> <RiskBadge riskTier={version.riskTier} />
                  </span>
                ) : (
                  <RiskBadge riskTier={version.riskTier} />
                )}
                {tierChanged && <span className="small muted"> initial → current</span>}
              </dd>
            </div>
            <div><dt>Artifact type</dt><dd className="mono">{version.fileType}</dd></div>
            <div><dt>Uploaded</dt><dd>{fmtDateTime(version.createdAt)}{version.createdByName ? ` by ${version.createdByName}` : ""}</dd></div>
            <div><dt>Deployed</dt><dd>{version.deployedAt ? fmtDateTime(version.deployedAt) : "Not deployed"}</dd></div>
            <div><dt>Last updated</dt><dd>{fmtDateTime(version.updatedAt)}</dd></div>
            {metrics.rows != null && <div><dt>Rows scored</dt><dd className="mono">{Number(metrics.rows).toLocaleString()}</dd></div>}
          </dl>
        </section>

        <section className="report-section" aria-labelledby="r-metrics">
          <h2 id="r-metrics">Performance and fairness</h2>
          {metrics.accuracy == null ? (
            <p className="muted">No metrics were computed for this version.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Metric</th><th className="num">Value</th><th>What it means</th></tr>
                </thead>
                <tbody>
                  {METRIC_ROWS.filter((r) => metrics[r.key] != null).map((r) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td className="num mono">{fmt(metrics[r.key])}</td>
                      <td className="muted">{r.note}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>Latency</td>
                    <td className="num mono">{metrics.latencyMs != null ? `${fmt(metrics.latencyMs, 2)} ms` : "—"}</td>
                    <td className="muted">
                      {latencyTag === "measured" ? "Measured by ModelWard" : latencyTag === "self-reported" ? "Self-reported by the uploader" : "Not provided"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {groups.length > 0 && (
            <>
              <h3 className="mini-head">Per-group results</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Group</th><th className="num">Rows</th><th className="num">Accuracy</th>
                      <th className="num">Positive rate</th><th className="num">TPR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g, i) => (
                      <tr key={`${g.group}-${i}`}>
                        <td className="mono">{String(g.group ?? "—")}</td>
                        <td className="num mono">{g.count != null ? Number(g.count).toLocaleString() : "—"}</td>
                        <td className="num mono">{fmt(g.accuracy)}</td>
                        <td className="num mono">{fmt(g.positiveRate)}</td>
                        <td className="num mono">{fmt(g.tpr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {warnings.length > 0 && (
            <ul className="info-list" aria-label="Scoring notes">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </section>

        {th && (
          <section className="report-section" aria-labelledby="r-thresholds">
            <h2 id="r-thresholds">Thresholds this version was scored under</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tier</th><th className="num">Minimum accuracy</th><th className="num">Maximum fairness gap</th></tr></thead>
                <tbody>
                  <tr><td>Low risk</td><td className="num mono">{fmt(th.lowAccuracy, 2)}</td><td className="num mono">{fmt(th.lowFairnessGap, 2)}</td></tr>
                  <tr><td>Medium risk</td><td className="num mono">{fmt(th.mediumAccuracy, 2)}</td><td className="num mono">{fmt(th.mediumFairnessGap, 2)}</td></tr>
                </tbody>
              </table>
            </div>
            <p className="small muted">Anything outside the medium limits is high risk. Drift tolerance: ± {fmt(th.driftThreshold, 2)}.</p>
          </section>
        )}

        {compliance && (
          <section className="report-section" aria-labelledby="r-compliance">
            <h2 id="r-compliance">Compliance — {compliance.score}%</h2>
            {checks ? (
              <ul className="check-list">
                {checks.map((c) => (
                  <li key={c.key} className={c.passed ? "pass" : "fail"}>
                    <Icon name={c.passed ? "check" : "close"} size={14} />
                    <span className="sr-only">{c.passed ? "Met: " : "Not met: "}</span>
                    {c.label}
                    <span className="print-only"> — {c.passed ? "met" : "not met"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Required: {(compliance.required || []).join(", ") || "none"}</p>
            )}
          </section>
        )}

        {hasReview && (
          <section className="report-section" aria-labelledby="r-review">
            <h2 id="r-review">Review decision</h2>
            <p className="small muted">
              {version.reviewedAt ? `Reviewed ${fmtDateTime(version.reviewedAt)}` : "Reviewed"}
              {reviewer ? ` by ${reviewer}` : ""}
            </p>
            {version.reviewComment && <blockquote className="review-comment"><span className="pre">{version.reviewComment}</span></blockquote>}
          </section>
        )}

        {(version.datasetNotes || version.trainingNotes) && (
          <section className="report-section" aria-labelledby="r-notes">
            <h2 id="r-notes">Dataset and training notes</h2>
            {version.datasetNotes && <p className="pre"><strong>Dataset:</strong> {version.datasetNotes}</p>}
            {version.trainingNotes && <p className="pre"><strong>Training:</strong> {version.trainingNotes}</p>}
          </section>
        )}

        <section className="report-section" aria-labelledby="r-snap">
          <h2 id="r-snap">Monitoring history</h2>
          {!snapshots || snapshots.length === 0 ? (
            <p className="muted">No snapshots recorded.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th><th>Source</th><th className="num">Accuracy</th><th className="num">Fairness gap</th>
                    <th className="num">Drift Δ</th><th>Tier</th><th>Flagged</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={s._id}>
                      <td className="mono nowrap">{fmtDateTime(s.createdAt)}</td>
                      <td>{SOURCE_LABEL[s.source] || (s.isBaseline ? "Baseline" : s.source || "—")}</td>
                      <td className="num mono">{fmt(s.accuracy)}</td>
                      <td className="num mono">{fmt(s.fairnessGap)}</td>
                      <td className="num mono">{fmt(s.driftDelta)}</td>
                      <td>{s.riskTier ? <RiskBadge riskTier={s.riskTier} /> : "—"}</td>
                      <td>{s.flagged ? "Flagged" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {comments.length > 0 && (
          <section className="report-section" aria-labelledby="r-comments">
            <h2 id="r-comments">Discussion</h2>
            <ul className="comment-list">
              {comments.map((c) => (
                <li key={c._id} className="comment">
                  <div className="comment-meta">
                    <strong>{c.authorName}</strong>
                    <span className="muted small">{roleLabel(c.authorRole)}</span>
                    <span className="muted small mono">{fmtDateTime(c.createdAt)}</span>
                  </div>
                  <p className="comment-body">{c.body}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="report-foot small muted">
          Generated {fmtDateTime(generatedAt.toISOString())} by ModelWard · version ID <span className="mono">{version._id}</span>
        </footer>
      </article>
    </main>
  );
}
