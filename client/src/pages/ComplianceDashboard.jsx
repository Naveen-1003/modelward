import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import RiskBadge from "../components/RiskBadge.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import VersionDetail from "../components/VersionDetail.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";
import ModelBrowser from "../components/ModelBrowser.jsx";
import Pagination from "../components/Pagination.jsx";
import { fmtDate, useDebounced, useKeyedPage } from "../components/featureUtils.js";
import { Icon, PageHeader, Loading, ErrorBox } from "../components/ui.jsx";

const EMPTY = { items: [], page: 1, pages: 1, total: 0, loading: true, error: "" };

// Paginated read of GET /versions for one status (stale responses are dropped).
function useVersions(status, { page, limit, q, refreshKey }) {
  const [state, setState] = useState(EMPTY);
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true }));
    const params = { status, page, limit };
    if (q) params.q = q;
    api
      .get("/versions", { params })
      .then(({ data }) => {
        if (id !== reqId.current) return;
        setState({
          items: Array.isArray(data.versions) ? data.versions : [],
          page: data.page || 1,
          pages: data.pages || 1,
          total: data.total ?? 0,
          loading: false,
          error: "",
        });
      })
      .catch((err) => {
        if (id === reqId.current) setState((s) => ({ ...s, loading: false, error: extractError(err) }));
      });
    return () => {
      reqId.current += 1;
    };
  }, [status, page, limit, q, refreshKey]);
  return state;
}

const modelNameOf = (v) => v.modelId?.name || "Unknown model";

// Rows that jump to the model page with the version preselected.
function AttentionList({ items }) {
  return (
    <ul className="model-list">
      {items.map((v) => {
        const body = (
          <>
            <span className="model-row-main">
              <strong>{modelNameOf(v)}</strong>
              <span className="muted">Updated {fmtDate(v.updatedAt || v.createdAt)}</span>
            </span>
            <span className="model-row-ver mono">v{v.versionNumber}</span>
            <span className="model-row-badges">
              {v.status === "needs_review" && <Icon name="alert" size={16} />}
              <RiskBadge riskTier={v.riskTier} />
              <StatusBadge status={v.status} />
            </span>
          </>
        );
        const cls = `model-row tier-${v.riskTier || "unrated"}`;
        return (
          <li key={v._id}>
            {v.modelId?._id ? (
              <Link to={`/models/${v.modelId._id}?version=${v._id}`} className={cls}>{body}</Link>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AttentionSection({ title, description, data, onPage, emptyText, id }) {
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id}>{title} <span className="count-pill mono">{data.total}</span></h2>
        <span className="muted">{description}</span>
      </div>
      <ErrorBox>{data.error}</ErrorBox>
      {data.loading && data.items.length === 0 ? (
        <Loading rows={2} />
      ) : data.items.length === 0 ? (
        !data.error && <div className="empty-state">{emptyText}</div>
      ) : (
        <div aria-busy={data.loading}>
          <AttentionList items={data.items} />
          <Pagination page={data.page} pages={data.pages} total={data.total} limit={10} onPage={onPage} />
        </div>
      )}
    </section>
  );
}

export default function ComplianceDashboard() {
  // The selected queue item is remembered with its model, so the right-hand panel (and its
  // "Open model page" link) keeps working after a decision moves the version out of the queue.
  const [selection, setSelection] = useState(null); // { versionId, modelId, modelName }
  const [recordedFor, setRecordedFor] = useState(null); // versionId an action was just taken on
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [queuePage, setQueuePage] = useKeyedPage(q); // a new search resets it in the same render
  const [attnPage, setAttnPage] = useState(1);
  const [deployPage, setDeployPage] = useState(1);

  const queue = useVersions("submitted", { page: queuePage, limit: 10, q, refreshKey });
  const attention = useVersions("needs_review", { page: attnPage, limit: 10, q: "", refreshKey });
  const deployable = useVersions("approved", { page: deployPage, limit: 10, q: "", refreshKey });

  // Acting on the last item of a later page leaves it empty: fall back to page 1.
  useEffect(() => {
    if (!queue.loading && queue.items.length === 0 && queue.total > 0 && queuePage > 1) setQueuePage(1);
  }, [queue.loading, queue.items.length, queue.total, queuePage]);
  useEffect(() => {
    if (!attention.loading && attention.items.length === 0 && attention.total > 0 && attnPage > 1) setAttnPage(1);
  }, [attention.loading, attention.items.length, attention.total, attnPage]);
  useEffect(() => {
    if (!deployable.loading && deployable.items.length === 0 && deployable.total > 0 && deployPage > 1) setDeployPage(1);
  }, [deployable.loading, deployable.items.length, deployable.total, deployPage]);

  const select = (v) => {
    setSelection({ versionId: v._id, modelId: v.modelId?._id || null, modelName: v.modelId?.name || "this" });
    setRecordedFor(null);
  };

  // Preselect the first queue item once, like before; later selections are the user's.
  useEffect(() => {
    if (queue.items.length > 0) {
      const v = queue.items[0];
      setSelection((prev) =>
        prev || { versionId: v._id, modelId: v.modelId?._id || null, modelName: v.modelId?.name || "this" }
      );
    }
  }, [queue.items]);

  const selectedVersionId = selection?.versionId || null;
  const leftQueue = !!selection && !queue.items.some((v) => v._id === selection.versionId);
  const showRecorded = leftQueue && recordedFor === selection.versionId && !queue.loading;

  return (
    <main className="page">
      <PageHeader
        kicker="Compliance"
        title="Review queue"
        description="Versions awaiting review, newest first, plus anything that needs a decision."
      >
        <div className="count"><b className="mono">{queue.total}</b> awaiting</div>
      </PageHeader>

      {attention.total > 0 && (
        <p className="banner banner-warn banner-inline" role="status">
          <Icon name="alert" size={18} />
          <span>{attention.total} live {attention.total === 1 ? "version needs" : "versions need"} a compliance decision after drift.</span>
        </p>
      )}

      <section aria-labelledby="queue-h">
        <div className="section-head">
          <h2 id="queue-h">Awaiting review <span className="count-pill mono">{queue.total}</span></h2>
          <form className="inline-search" role="search" onSubmit={(e) => e.preventDefault()}>
            <label>
              <span className="sr-only">Search review queue</span>
              <input
                type="search"
                placeholder="Search by model name"
                maxLength={120}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </form>
        </div>

        <ErrorBox>{queue.error}</ErrorBox>

        {queue.loading && queue.items.length === 0 ? (
          <Loading />
        ) : queue.items.length === 0 && !selectedVersionId ? (
          !queue.error && (
            <div className="empty-state">
              {q ? "No versions in the queue match your search." : "Nothing waiting for review right now."}
            </div>
          )
        ) : (
          <div className="split">
            <div>
              <nav className="queue" aria-label="Review queue" aria-busy={queue.loading}>
                {queue.items.length === 0 && <div className="empty-state">{q ? "No matches." : "Queue cleared."}</div>}
                {queue.items.map((v) => (
                  <button
                    key={v._id}
                    className={`queue-item${v._id === selectedVersionId ? " is-selected" : ""}`}
                    aria-current={v._id === selectedVersionId ? "true" : undefined}
                    onClick={() => select(v)}
                  >
                    <span className="queue-top">
                      <strong>{modelNameOf(v)}</strong>
                      <span className="mono">v{v.versionNumber}</span>
                    </span>
                    <span className="queue-bottom">
                      <RiskBadge riskTier={v.riskTier} />
                      <span className="muted small">{fmtDate(v.createdAt)}</span>
                    </span>
                  </button>
                ))}
              </nav>
              <Pagination page={queue.page} pages={queue.pages} total={queue.total} limit={10} onPage={setQueuePage} />
            </div>
            <div className="split-detail">
              {selectedVersionId && (
                <>
                  {selection.modelId && (
                    <Link className="back-link" to={`/models/${selection.modelId}?version=${selection.versionId}`}>
                      Open {selection.modelName} model page
                    </Link>
                  )}
                  {showRecorded && (
                    <p className="note" role="status">
                      Decision recorded. This version has left the review queue; you can still open its model page.
                    </p>
                  )}
                  <VersionDetail
                    versionId={selectedVersionId}
                    onChanged={() => {
                      setRecordedFor(selectedVersionId);
                      setRefreshKey((k) => k + 1);
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <AttentionSection
        id="attention-h"
        title="Needs attention"
        description="Live versions flagged by drift monitoring"
        data={attention}
        onPage={setAttnPage}
        emptyText="No live versions are waiting on a drift decision."
      />

      <AttentionSection
        id="deploy-h"
        title="Awaiting deployment"
        description="Approved versions that are not live yet"
        data={deployable}
        onPage={setDeployPage}
        emptyText="No approved versions are waiting to be deployed."
      />

      <section className="section" aria-labelledby="models-h">
        <div className="section-head">
          <h2 id="models-h">All models</h2>
          <span className="muted">Browse the full registry</span>
        </div>
        <ModelBrowser />
      </section>

      <AuditLogTable refreshKey={refreshKey} />
    </main>
  );
}
