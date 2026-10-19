import React, { useCallback, useEffect, useRef, useState } from "react";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "./ConfirmDialog.jsx";
import StatusBadge from "./StatusBadge.jsx";
import RiskBadge from "./RiskBadge.jsx";
import MetricCard from "./MetricCard.jsx";
import CommentThread from "./CommentThread.jsx";
import MonitoringPanel from "./MonitoringPanel.jsx";
import DownloadButton from "./DownloadButton.jsx";
import { Icon, Loading, ErrorBox } from "./ui.jsx";
import { LIVE_STATUSES, MAX_COMMENT, MAX_NOTES, fmt, fmtDateTime, useMounted } from "./featureUtils.js";
import { isAdminRole } from "../roleHome.js";

const STEPS = [
  { key: "draft", label: "Draft" },
  { key: "submitted", label: "In review" },
  { key: "approved", label: "Approved" },
  { key: "deployed", label: "Deployed" },
];

// Where each status sits on the stepper, and how that step should look.
const POSITION = {
  draft: { at: 0, kind: "now" },
  upload_failed: { at: 0, kind: "bad", label: "Upload failed" },
  submitted: { at: 1, kind: "now" },
  changes_requested: { at: 1, kind: "warn", label: "Changes requested" },
  rejected: { at: 1, kind: "bad", label: "Rejected" },
  approved: { at: 2, kind: "now" },
  deployed: { at: 3, kind: "now" },
  needs_review: { at: 3, kind: "warn", label: "Needs review" },
  superseded: { at: 4, kind: "ended", label: "Superseded" },
  retired: { at: 4, kind: "ended", label: "Retired" },
};

function Lifecycle({ status }) {
  const pos = POSITION[status] || { at: 0, kind: "now" };
  const steps = pos.kind === "ended" ? [...STEPS, { key: status, label: pos.label }] : STEPS;
  return (
    <ol className="lifecycle" aria-label="Version lifecycle">
      {steps.map((s, i) => {
        const state = i < pos.at ? "done" : i === pos.at ? pos.kind : "";
        const label = i === pos.at && pos.label ? pos.label : s.label;
        return (
          <li key={s.key} className={state} aria-current={i === pos.at ? "step" : undefined}>
            <span className="dot">{state === "done" ? <Icon name="check" size={11} /> : i + 1}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

const CLONEABLE = ["rejected", "changes_requested", "upload_failed", "superseded", "retired"];
const ARCHIVABLE = ["draft", "changes_requested", "rejected", "upload_failed", "superseded", "retired"];
const SOURCE_LABEL = { baseline: "Baseline", simulated: "Simulated", batch: "Batch upload" };

export default function VersionDetail({ versionId, onChanged, onClone }) {
  const { user } = useAuth();
  const { config } = useConfig();
  const toast = useToast();
  const confirm = useConfirm();
  const mounted = useMounted();

  const reqId = useRef(0);
  const busyRef = useRef("");
  const idRef = useRef(versionId);
  idRef.current = versionId;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const [simDone, setSimDone] = useState(false);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const [gone, setGone] = useState("");
  const [comment, setComment] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState({ datasetNotes: "", trainingNotes: "" });

  const load = useCallback(
    async (silent = false) => {
      const id = ++reqId.current;
      if (!silent) {
        setLoading(true);
        setLoadError("");
      }
      try {
        const res = await api.get(`/versions/${versionId}`);
        if (id === reqId.current) {
          setData(res.data);
          setLoadError("");
        }
      } catch (err) {
        if (id === reqId.current) setLoadError(extractError(err));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [versionId]
  );

  useEffect(() => {
    // never show another version's actions while the new one loads
    setData(null);
    setSimDone(false);
    setComment("");
    setGone("");
    setActionError("");
    setEditingNotes(false);
    load();
    return () => {
      reqId.current += 1; // ignore responses that arrive after a switch/unmount
    };
  }, [load]);

  // Live monitoring: while a logged-in user has this deployed version open (and the tab is
  // visible) the client asks the server for the next simulated snapshot every 2.5 s. Leaving
  // the page or logging out unmounts this and the stream stops; opening it again resumes the
  // run until the server says the fixed run is complete.
  const liveStatus = data?.version?.status;
  const simulating = config.enableDriftSimulation && liveStatus === "deployed" && !simDone;
  useEffect(() => {
    if (!simulating) return undefined;
    let stopped = false;
    let timer;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden && !busyRef.current) {
        try {
          const res = await api.post(`/versions/${versionId}/simulate-drift`);
          if (stopped) return;
          const d = res.data || {};
          if (d.simulation?.done) setSimDone(true);
          if (d.snapshot?.flagged) {
            toastRef.current.error("Drift flagged on live monitoring: the version needs review");
            onChangedRef.current?.();
          }
          await load(true);
        } catch (err) {
          if (stopped) return;
          const code = err?.response?.status;
          if (code === 409 && err.response.data?.done) setSimDone(true);
          if (code !== 429) return; // finished, disabled, no longer live or gone: stop quietly
        }
      }
      if (!stopped) timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [simulating, versionId, load]);

  // One helper for every mutation: single-flight, toast, reload, tell the parent.
  async function runAction(key, fn, successMsg, opts = {}) {
    if (busyRef.current) return { ok: false };
    busyRef.current = key;
    setBusy(key);
    setActionError("");
    const startId = idRef.current;
    try {
      const result = await fn();
      const msg = typeof successMsg === "function" ? successMsg(result) : successMsg;
      if (msg) toast.success(msg);
      if (mounted.current && idRef.current === startId && opts.reload !== false) await load(true);
      onChanged?.();
      return { ok: true, result };
    } catch (err) {
      const msg = extractError(err);
      toast.error(msg);
      if (mounted.current && idRef.current === startId) {
        setActionError(msg);
        load(true); // the state may have moved under us; refresh the action matrix
      }
      return { ok: false };
    } finally {
      busyRef.current = "";
      if (mounted.current) setBusy("");
    }
  }

  if (gone) return <div className="empty-state" role="status">{gone}</div>;
  if (loading && !data) return <Loading rows={4} />;
  if (!data) return loadError ? <ErrorBox>{loadError}</ErrorBox> : null;

  const { version, compliance, snapshots } = data;
  const role = user?.role;
  const isML = role === "ml_engineer";
  const isCompliance = role === "compliance_officer";
  const isAdmin = isAdminRole(role); // super_admin: admin powers, never a reviewer
  const canDecide = isCompliance || isAdmin; // deploy / retire / resolve review
  const isOwner = !!user && version.createdBy === user.id;
  const status = version.status;
  const isLive = LIVE_STATUSES.includes(status);
  // Mirrors the server: an unrated/unknown tier is treated as high.
  const isHighRisk = !["low", "medium"].includes(version.riskTier);
  const modelName = version.modelId?.name;
  const working = busy !== "";

  // Mirrors the server: only the engineer who uploaded a version may edit, submit, withdraw or retry it.
  const ownsML = isML && isOwner;
  const canSubmit = ownsML && (status === "draft" || status === "changes_requested");
  const canWithdraw = ownsML && status === "submitted";
  const canRetry = ownsML && status === "upload_failed" && version.retryable && version.hasFile;
  const canEditNotes = ownsML && (status === "draft" || status === "changes_requested");
  const canClone = isML && !!onClone && CLONEABLE.includes(status);
  const canArchive = ((isML && isOwner) || isAdmin) && ARCHIVABLE.includes(status);
  const canReview = isCompliance && status === "submitted";
  const canDeploy = canDecide && status === "approved";
  const canRetire = canDecide && status === "deployed";
  const canResolve = canDecide && status === "needs_review";
  const hasNotes = !!(version.datasetNotes || version.trainingNotes);

  // Server rule: comment required for reject / request changes, and for approving a high-risk version.
  const trimmed = comment.trim();
  const approveNeedsComment = isHighRisk;
  const approveBlocked = approveNeedsComment && !trimmed;
  const otherBlocked = !trimmed;
  const hint = !trimmed
    ? approveNeedsComment
      ? "A comment is required to approve a high-risk version, and to reject or request changes."
      : "A comment is required to reject or request changes."
    : "";

  const id = version._id || versionId;
  const post = (path, body) => api.post(`/versions/${id}/${path}`, body);

  async function review(decision) {
    const labels = { approve: "Version approved", reject: "Version rejected", request_changes: "Changes requested" };
    const res = await runAction("review", () => post("review", { decision, ...(trimmed ? { comment: trimmed } : {}) }), labels[decision]);
    if (res.ok && mounted.current) setComment("");
  }

  async function deploy() {
    const ok = await confirm({
      title: `Deploy version ${version.versionNumber}?`,
      message: "Any other live version of this model will be marked superseded.",
      confirmLabel: "Deploy",
    });
    if (!ok) return;
    runAction("deploy", () => post("deploy"), "Version deployed");
  }

  async function retire() {
    const reason = await confirm({
      title: `Retire version ${version.versionNumber}?`,
      message: "The version stops being live. This is recorded in the audit trail.",
      confirmLabel: "Retire",
      danger: true,
      requireReason: true,
      reasonLabel: "Reason for retiring",
    });
    if (!reason) return;
    runAction("retire", () => post("retire", { comment: reason }), "Version retired");
  }

  async function resolveReview(decision) {
    const keep = decision === "keep";
    const reason = await confirm({
      title: keep ? "Keep this version live?" : `Retire version ${version.versionNumber}?`,
      message: keep
        ? "You are accepting the drift. The version returns to Deployed and your decision is recorded."
        : "The drifted version stops being live. This is recorded in the audit trail.",
      confirmLabel: keep ? "Keep live" : "Retire",
      danger: !keep,
      requireReason: true,
      reasonLabel: "Your decision comment",
    });
    if (!reason) return;
    runAction("resolve", () => post("resolve-review", { decision, comment: reason }), keep ? "Kept live" : "Version retired");
  }

  async function archive() {
    const ok = await confirm({
      title: `Archive version ${version.versionNumber}?`,
      message: "It disappears from the version list. An admin can restore it from Trash.",
      confirmLabel: "Archive",
      danger: true,
      requireReason: false,
    });
    if (!ok) return;
    const res = await runAction(
      "archive",
      () => api.delete(`/versions/${id}`),
      "Version archived",
      { reload: false }
    );
    if (res.ok && mounted.current) {
      reqId.current += 1; // the version is gone; discard any pending reads
      setGone("This version was archived.");
    }
  }

  function startEditNotes() {
    setNotesDraft({ datasetNotes: version.datasetNotes || "", trainingNotes: version.trainingNotes || "" });
    setEditingNotes(true);
  }

  async function saveNotes(e) {
    e.preventDefault();
    const res = await runAction(
      "notes",
      () => api.patch(`/versions/${id}/notes`, notesDraft),
      "Notes saved"
    );
    if (res.ok && mounted.current) setEditingNotes(false);
  }

  const tierChanged = version.initialRiskTier && version.initialRiskTier !== version.riskTier;
  const th = version.thresholdsUsed;
  const checks = Array.isArray(compliance?.checks) ? compliance.checks : null;

  return (
    <article className="panel version-panel" aria-busy={loading}>
      <div className="panel-head">
        <div>
          <h2>Version {version.versionNumber}</h2>
          <p className="muted mono small">
            {modelName ? `${modelName} · ` : ""}
            {version.fileType} · uploaded {fmtDateTime(version.createdAt)}
            {version.createdByName ? ` by ${version.createdByName}` : ""}
          </p>
        </div>
        <div className="badge-row">
          <StatusBadge status={status} />
          {tierChanged ? (
            <span className="tier-shift" title="Risk tier at upload, then as re-evaluated on the latest snapshot">
              <span className="kicker">Tier</span>
              <RiskBadge riskTier={version.initialRiskTier} />
              <span aria-label="changed to">→</span>
              <RiskBadge riskTier={version.riskTier} />
            </span>
          ) : (
            <RiskBadge riskTier={version.riskTier} />
          )}
        </div>
      </div>

      <Lifecycle status={status} />

      {status === "needs_review" && (
        <section className="banner banner-warn" aria-label="Drift review required">
          <div className="banner-main">
            <Icon name="alert" size={20} />
            <div>
              <strong>Drift flagged — this version needs a compliance decision</strong>
              <p className="small">
                Monitoring found this live version moved outside its tolerance. Keep it live or retire it; either choice needs a comment and is
                recorded in the audit trail.
              </p>
              {!canResolve && <p className="small muted">Only a compliance officer or admin can resolve this.</p>}
            </div>
          </div>
          {canResolve && (
            <div className="btn-row">
              <button type="button" disabled={working} aria-busy={busy === "resolve"} onClick={() => resolveReview("keep")}>
                Keep live
              </button>
              <button type="button" className="danger" disabled={working} onClick={() => resolveReview("retire")}>
                Retire
              </button>
            </div>
          )}
        </section>
      )}

      {status === "upload_failed" && (
        <ErrorBox>
          Upload failed: {version.uploadError || "scoring did not complete"}
          {version.retryable && !version.hasFile ? " (the file was not retained, so scoring can't be retried)" : ""}
        </ErrorBox>
      )}

      <MetricCard metrics={version.metrics} scoringWarnings={version.scoringWarnings} />

      {th && (
        <details className="notes thresholds">
          <summary>Scored under thresholds</summary>
          <dl className="kv">
            <div><dt>Low risk</dt><dd className="mono">accuracy ≥ {fmt(th.lowAccuracy, 2)}, gap ≤ {fmt(th.lowFairnessGap, 2)}</dd></div>
            <div><dt>Medium risk</dt><dd className="mono">accuracy ≥ {fmt(th.mediumAccuracy, 2)}, gap ≤ {fmt(th.mediumFairnessGap, 2)}</dd></div>
            <div><dt>Drift tolerance</dt><dd className="mono">± {fmt(th.driftThreshold, 2)}</dd></div>
          </dl>
          <p className="small muted">Anything outside the medium limits is high risk. Admins can change thresholds; this version keeps the ones it was scored under.</p>
        </details>
      )}

      {compliance && (
        <div className="compliance">
          <span className="score mono">{compliance.score}%</span>
          <div>
            <strong>Compliance score</strong>
            {checks ? (
              <ul className="check-list">
                {checks.map((c) => (
                  <li key={c.key} className={c.passed ? "pass" : "fail"}>
                    <Icon name={c.passed ? "check" : "close"} size={14} />
                    <span className="sr-only">{c.passed ? "Met: " : "Not met: "}</span>
                    {c.label}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted"> Required: {(compliance.required || []).join(", ") || "none"}</span>
            )}
            <div className="meter" aria-hidden="true"><span style={{ width: `${Number(compliance.score) || 0}%` }} /></div>
          </div>
        </div>
      )}

      {(hasNotes || canEditNotes) &&
        (editingNotes ? (
          <form className="notes-edit" onSubmit={saveNotes}>
            <label>
              Dataset notes
              <textarea
                rows={3}
                maxLength={MAX_NOTES}
                value={notesDraft.datasetNotes}
                onChange={(e) => setNotesDraft({ ...notesDraft, datasetNotes: e.target.value })}
              />
              <span className="hint mono">{notesDraft.datasetNotes.length}/{MAX_NOTES}</span>
            </label>
            <label>
              Training notes
              <textarea
                rows={3}
                maxLength={MAX_NOTES}
                value={notesDraft.trainingNotes}
                onChange={(e) => setNotesDraft({ ...notesDraft, trainingNotes: e.target.value })}
              />
              <span className="hint mono">{notesDraft.trainingNotes.length}/{MAX_NOTES}</span>
            </label>
            <div className="btn-row">
              <button type="submit" disabled={working} aria-busy={busy === "notes"}>Save notes</button>
              <button type="button" className="secondary" disabled={working} onClick={() => setEditingNotes(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <details className="notes" open={canEditNotes && hasNotes ? true : undefined}>
            <summary>Dataset &amp; training notes</summary>
            {version.datasetNotes && <p className="pre"><strong>Dataset:</strong> {version.datasetNotes}</p>}
            {version.trainingNotes && <p className="pre"><strong>Training:</strong> {version.trainingNotes}</p>}
            {!hasNotes && <p className="muted">No notes yet.</p>}
            {canEditNotes && (
              <button type="button" className="secondary" disabled={working} onClick={startEditNotes}>Edit notes</button>
            )}
          </details>
        ))}

      {version.reviewComment && (
        <blockquote className="review-comment">
          <span className="kicker">Reviewer comment</span>
          <span className="pre">{version.reviewComment}</span>
        </blockquote>
      )}

      <ErrorBox>{actionError || loadError}</ErrorBox>

      {/* ML engineer: lifecycle actions on their own versions */}
      {(canSubmit || canWithdraw || canRetry || canClone || canArchive) && (
        <div className="action-bar">
          <div className="btn-row">
            {canSubmit && (
              <button type="button" disabled={working} aria-busy={busy === "submit"} onClick={() => runAction("submit", () => post("submit"), "Submitted for review")}>
                Submit for review
              </button>
            )}
            {canWithdraw && (
              <button type="button" className="secondary" disabled={working} aria-busy={busy === "withdraw"} onClick={() => runAction("withdraw", () => post("withdraw"), "Withdrawn to draft")}>
                Withdraw to draft
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                disabled={working}
                aria-busy={busy === "retry"}
                onClick={() =>
                  runAction("retry", () => post("retry"), (r) =>
                    r?.data?.version?.status === "upload_failed" ? "Scoring retried — it failed again, see the error above" : "Scoring retried"
                  )
                }
              >
                <Icon name="refresh" /> Retry scoring
              </button>
            )}
            {canClone && (
              <button type="button" className="secondary" disabled={working} onClick={() => onClone(version)}>
                Clone as new version
              </button>
            )}
            {canArchive && (
              <button type="button" className="danger" disabled={working} aria-busy={busy === "archive"} onClick={archive}>
                <Icon name="trash" /> Archive
              </button>
            )}
          </div>
        </div>
      )}

      {/* Compliance officer: decide on a submitted version */}
      {canReview && (
        <div className="action-bar review">
          <label>
            Reviewer comment{" "}
            {isHighRisk ? <strong className="req">Required for high-risk versions</strong> : <span className="hint">Required to reject or request changes</span>}
            <textarea
              rows={3}
              value={comment}
              maxLength={MAX_COMMENT}
              onChange={(e) => setComment(e.target.value)}
              aria-describedby={`rv-hint-${id}`}
            />
          </label>
          <div className="form-foot">
            <span id={`rv-hint-${id}`} className="hint" aria-live="polite">{hint}</span>
            <span className="hint mono">{comment.length}/{MAX_COMMENT}</span>
          </div>
          <div className="btn-row">
            <button type="button" disabled={working || approveBlocked} aria-busy={busy === "review"} onClick={() => review("approve")}>
              Approve
            </button>
            <button type="button" className="secondary" disabled={working || otherBlocked} onClick={() => review("request_changes")}>
              Request changes
            </button>
            <button type="button" className="danger" disabled={working || otherBlocked} onClick={() => review("reject")}>
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Compliance officer or admin: deploy / retire */}
      {(canDeploy || canRetire) && (
        <div className="action-bar">
          <div className="btn-row">
            {canDeploy && (
              <button type="button" disabled={working} aria-busy={busy === "deploy"} onClick={deploy}>
                Deploy
              </button>
            )}
            {canRetire && (
              <button type="button" className="danger" disabled={working} aria-busy={busy === "retire"} onClick={retire}>
                Retire
              </button>
            )}
          </div>
        </div>
      )}

      {/* Any role: monitoring on live versions */}
      {isLive && (
        <div className="action-bar monitoring">
          <MonitoringPanel versionId={id} run={runAction} disabled={working} />
        </div>
      )}

      {/* Files and report: every role */}
      <div className="action-bar">
        <div className="btn-row">
          {version.hasFile && (
            <DownloadButton
              url={`/versions/${id}/file`}
              params={{ which: "model" }}
              fileName={version.fileName}
              fallbackName={`version-${version.versionNumber}-${version.fileType}`}
              label={version.fileType === "csv" ? "Download predictions CSV" : "Download model file"}
            />
          )}
          {version.hasDataset && (
            <DownloadButton
              url={`/versions/${id}/file`}
              params={{ which: "dataset" }}
              fileName={version.datasetFileName}
              fallbackName={`version-${version.versionNumber}-dataset.csv`}
              label="Download dataset"
            />
          )}
          <a className="btn-link secondary" href={`/report/versions/${id}`} target="_blank" rel="noopener noreferrer">
            <Icon name="print" /> Open printable report
          </a>
        </div>
        {!version.hasFile && !version.hasDataset && (
          <p className="small muted">Source files were not retained for this version.</p>
        )}
      </div>

      {snapshots && snapshots.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h3>Live monitoring</h3>
            {simulating && <span className="muted small" role="status">Live: simulated data streaming in</span>}
            {config.enableDriftSimulation && isLive && simDone && <span className="muted small">Simulated run complete</span>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th className="num">Accuracy</th>
                  <th className="num">Fairness gap</th>
                  <th className="num">Drift Δ</th>
                  <th>Tier</th>
                  <th>Flagged</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s._id}>
                    <td className="muted mono nowrap">{fmtDateTime(s.createdAt)}</td>
                    <td className="nowrap">
                      {SOURCE_LABEL[s.source] || (s.isBaseline ? "Baseline" : s.source || "—")}
                      {s.createdByName && <span className="sub">{s.createdByName}</span>}
                    </td>
                    <td className="num mono">{fmt(s.accuracy)}</td>
                    <td className="num mono">{fmt(s.fairnessGap)}</td>
                    <td className="num mono">{fmt(s.driftDelta)}</td>
                    <td>{s.riskTier ? <RiskBadge riskTier={s.riskTier} /> : <span className="muted">—</span>}</td>
                    <td>
                      {s.flagged ? (
                        <span className="flag"><Icon name="alert" size={14} /> Flagged</span>
                      ) : (
                        <span className="muted">No</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <CommentThread versionId={id} />
    </article>
  );
}
