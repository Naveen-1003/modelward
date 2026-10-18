import React, { useEffect, useMemo, useRef, useState } from "react";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import Pagination from "./Pagination.jsx";
import { Icon, ErrorBox, Loading } from "./ui.jsx";
import {
  AUDIT_ACTIONS,
  actionLabel,
  blobErrorMessage,
  downloadBlob,
  fmtDateTime,
  roleLabel,
  useDebounced,
  useKeyedPage,
  useMounted,
} from "./featureUtils.js";

const ACTOR_ROLES = ["ml_engineer", "compliance_officer", "admin", "none"];
const TARGET_TYPES = ["Model", "Version", "User", "Settings"];
const EMPTY = { action: "", actorRole: "", targetType: "", q: "", from: "", to: "" };

// Self-fetching, read-only audit trail with filters, pagination, CSV export and (admin) chain verification.
// `limit` and `refreshKey` are optional: pages bump refreshKey after they change something.
export default function AuditLogTable({ limit = 25, refreshKey }) {
  const { user } = useAuth();
  const toast = useToast();
  const mounted = useMounted();
  const reqId = useRef(0);

  const [filters, setFilters] = useState(EMPTY);
  const [logs, setLogs] = useState([]);
  const [meta, setMeta] = useState({ pages: 1, total: 0, scoped: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);

  const role = user?.role;
  const canExport = role === "compliance_officer" || role === "admin";
  const isAdmin = role === "admin";

  const q = useDebounced(filters.q.trim(), 300);
  // Filters that go to the server (free text is debounced).
  const query = useMemo(() => {
    const out = {};
    if (filters.action) out.action = filters.action;
    if (filters.actorRole) out.actorRole = filters.actorRole;
    if (filters.targetType) out.targetType = filters.targetType;
    if (q) out.q = q;
    if (filters.from) out.from = filters.from;
    if (filters.to) out.to = filters.to;
    return out;
  }, [filters.action, filters.actorRole, filters.targetType, filters.from, filters.to, q]);
  const queryKey = JSON.stringify(query);
  // New filters -> page 1, in the same render (no second request).
  const [page, setPage] = useKeyedPage(queryKey);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    api
      .get("/audit-log", { params: { ...query, page, limit } })
      .then(({ data }) => {
        if (id !== reqId.current) return;
        setLogs(Array.isArray(data.logs) ? data.logs : []);
        setMeta({ pages: data.pages || 1, total: data.total ?? 0, scoped: !!data.scoped });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, page, limit, refreshKey]);

  function setFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadBlob("/audit-log/export", { params: query, fallbackName: "audit-log.csv" });
      toast.success("Audit log exported");
    } catch (err) {
      toast.error(await blobErrorMessage(err));
    } finally {
      if (mounted.current) setExporting(false);
    }
  }

  async function verify() {
    if (verifying) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const { data } = await api.get("/audit-log/verify");
      if (mounted.current) setVerifyResult(data);
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      if (mounted.current) setVerifying(false);
    }
  }

  const filtered = Object.keys(query).length > 0;

  return (
    <section className="section">
      <div className="section-head">
        <h2>Audit trail</h2>
        <span className="muted">Read-only record of every governance action</span>
      </div>

      {meta.scoped && <p className="note">Showing activity on your models.</p>}

      <form className="filter-bar" onSubmit={(e) => e.preventDefault()} aria-label="Filter audit log">
        <label>
          Action
          <select value={filters.action} onChange={(e) => setFilter("action", e.target.value)}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>{actionLabel(a)}</option>
            ))}
          </select>
        </label>
        <label>
          Actor role
          <select value={filters.actorRole} onChange={(e) => setFilter("actorRole", e.target.value)}>
            <option value="">Any role</option>
            {ACTOR_ROLES.map((r) => (
              <option key={r} value={r}>{r === "none" ? "Anonymous" : roleLabel(r)}</option>
            ))}
          </select>
        </label>
        <label>
          Target
          <select value={filters.targetType} onChange={(e) => setFilter("targetType", e.target.value)}>
            <option value="">Any target</option>
            {TARGET_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            maxLength={100}
            placeholder="Actor or details"
            value={filters.q}
            onChange={(e) => setFilter("q", e.target.value)}
          />
        </label>
        <label>
          From
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter("from", e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter("to", e.target.value)} />
        </label>
        <div className="filter-actions">
          {filtered || filters.q ? (
            <button type="button" className="secondary" onClick={() => setFilters(EMPTY)}>
              <Icon name="close" /> Clear
            </button>
          ) : null}
          {canExport && (
            <button type="button" className="secondary" onClick={exportCsv} disabled={exporting} aria-busy={exporting}>
              <Icon name="download" /> {exporting ? "Exporting…" : "Export CSV"}
            </button>
          )}
          {isAdmin && (
            <button type="button" className="secondary" onClick={verify} disabled={verifying} aria-busy={verifying}>
              {verifying ? "Verifying…" : "Verify integrity"}
            </button>
          )}
        </div>
      </form>

      <div aria-live="polite">
        {verifyResult && (
          <div className={`verify-result ${verifyResult.ok ? "ok" : "bad"}`}>
            <Icon name={verifyResult.ok ? "check" : "alert"} />
            <span>
              {verifyResult.ok
                ? `Chain intact — ${verifyResult.checked ?? 0} chained entries verified.`
                : `Chain broken at entry #${verifyResult.brokenAtSeq ?? "?"} — the log may have been tampered with.`}
              {verifyResult.legacyUnchained > 0 &&
                ` ${verifyResult.legacyUnchained} older entries pre-date the chain and cannot be verified.`}
            </span>
          </div>
        )}
      </div>

      <ErrorBox>{error}</ErrorBox>
      {loading && logs.length === 0 ? (
        <Loading />
      ) : logs.length === 0 ? (
        !error && <div className="empty-state">{filtered ? "No entries match these filters." : "No activity yet."}</div>
      ) : (
        <>
          <div className="table-wrap scroll" aria-busy={loading}>
            <table className="audit-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Role</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log._id}>
                    <td className="mono muted nowrap">{fmtDateTime(log.createdAt)}</td>
                    <td>{log.actorName}</td>
                    <td className="muted nowrap">{log.actorRole === "none" ? "anonymous" : roleLabel(log.actorRole)}</td>
                    <td className="nowrap">
                      <span className="badge badge-status-draft">{actionLabel(log.action)}</span>
                    </td>
                    <td className="muted">{log.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pages={meta.pages} total={meta.total} limit={limit} onPage={setPage} />
        </>
      )}
    </section>
  );
}
