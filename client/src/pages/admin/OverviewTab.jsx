import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { extractError } from "../../api/axios.js";
import { Loading, ErrorBox } from "../../components/ui.jsx";
import RiskBadge from "../../components/RiskBadge.jsx";
import { STATUS_LABELS } from "../../components/StatusBadge.jsx";
import { formatDate, roleLabel } from "./format.js";

const TIERS = ["low", "medium", "high", "unrated"];

function Tile({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="mono">{value ?? 0}</dd>
    </div>
  );
}

// Plain CSS bars: widths are relative to the largest bucket.
function Bars({ rows, tierClass }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul>
      {rows.map((r) => (
        <li className="bar-row" key={r.key}>
          <span>{r.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span className={`bar-fill${tierClass ? ` seg-${r.key}` : ""}`} style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <b className="mono">{r.count}</b>
        </li>
      ))}
    </ul>
  );
}

function ItemList({ items, empty }) {
  if (!items?.length) return <div className="empty-state">{empty}</div>;
  return (
    <ul className="model-list">
      {items.map((it) => (
        <li key={it.versionId}>
          <Link className={`model-row tier-${it.riskTier || "unrated"}`} to={`/models/${it.modelId}`}>
            <span className="model-row-main">
              <strong>{it.modelName}</strong>
              <span className="muted">Updated {formatDate(it.updatedAt)}</span>
            </span>
            <span className="model-row-ver mono">v{it.versionNumber}</span>
            <span className="model-row-badges">
              <RiskBadge riskTier={it.riskTier} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function OverviewTab() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get("/stats")
      .then(({ data }) => {
        if (!cancelled) setStats(data);
      })
      .catch((err) => {
        if (!cancelled) setError(extractError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!stats) return <Loading />;

  const t = stats.totals || {};
  const statusRows = Object.keys(STATUS_LABELS)
    .map((k) => ({ key: k, label: STATUS_LABELS[k], count: stats.byStatus?.[k] || 0 }))
    .filter((r) => r.count > 0);
  const tierRows = TIERS.map((k) => ({
    key: k,
    label: k === "unrated" ? "Unrated" : `${k} risk`,
    count: stats.byTier?.[k] || 0,
  }));
  const users = stats.users;

  return (
    <>
      <dl className="metrics" aria-label="Summary">
        <Tile label="Models" value={t.models} />
        <Tile label="Versions" value={t.versions} />
        <Tile label="Live" value={t.live} />
        <Tile label="Awaiting review" value={t.awaitingReview} />
        <Tile label="Needs review" value={t.needsReview} />
      </dl>

      <div className="grid-2">
        <section aria-label="Versions by status">
          <div className="section-head"><h2>Versions by status</h2></div>
          {statusRows.length ? <Bars rows={statusRows} /> : <div className="empty-state">No versions yet.</div>}
        </section>
        <section aria-label="Models by risk tier">
          <div className="section-head"><h2>Models by risk tier</h2><span className="muted">Live version, else latest</span></div>
          {tierRows.some((r) => r.count > 0) ? <Bars rows={tierRows} tierClass /> : <div className="empty-state">No models yet.</div>}
        </section>
      </div>

      <section className="section" aria-label="Needs review">
        <div className="section-head">
          <h2>Needs review</h2>
          <span className="muted">Live versions flagged by drift or a worse risk tier</span>
        </div>
        <ItemList items={stats.needsReview} empty="Nothing flagged. All live versions are within thresholds." />
      </section>

      <section className="section" aria-label="Awaiting review">
        <div className="section-head">
          <h2>Awaiting review</h2>
          <span className="muted">Submitted and waiting for a compliance decision</span>
        </div>
        <ItemList items={stats.awaitingReview} empty="No versions are waiting for review." />
      </section>

      {users && (
        <section className="section" aria-label="Users">
          <div className="section-head"><h2>Users</h2></div>
          <dl className="metrics">
            <Tile label="Total" value={users.total} />
            <Tile label="Active" value={users.active} />
            {Object.entries(users.byRole || {}).map(([role, n]) => (
              <Tile key={role} label={roleLabel(role)} value={n} />
            ))}
          </dl>
        </section>
      )}
    </>
  );
}
