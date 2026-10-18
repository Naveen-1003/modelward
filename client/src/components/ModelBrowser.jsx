import React, { useEffect, useRef, useState } from "react";
import api, { extractError } from "../api/axios.js";
import ModelList from "./ModelList.jsx";
import Pagination from "./Pagination.jsx";
import { useDebounced, useKeyedPage } from "./featureUtils.js";
import { Loading, ErrorBox } from "./ui.jsx";

// Searchable, filterable, paginated list of every model (GET /models), for roles that
// have no registry page of their own (admin, compliance). Rows link to /models/:id.
export default function ModelBrowser({ limit = 12 }) {
  const reqId = useRef(0);
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [page, setPage] = useKeyedPage(`${q}|${tier}`);

  const [models, setModels] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    const params = { page, limit };
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
      reqId.current += 1; // drop the response if the filters change or we unmount
    };
  }, [page, q, tier, limit]);

  const filtering = !!(q || tier);

  return (
    <div className="model-browser">
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
            {filtering ? "No models match your search." : "No models have been registered yet."}
          </div>
        )
      ) : (
        <div aria-busy={loading}>
          <ModelList models={models} />
          <Pagination page={meta.page} pages={meta.pages} total={meta.total} limit={limit} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
