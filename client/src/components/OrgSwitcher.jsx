import React, { useId } from "react";

// Platform admin only: pick the organization the admin console works inside.
//   orgs       list from GET /orgs (null while it loads)
//   activeOrg  { id, name } | null
//   onSelect   called with { id, name } or null ("No organization selected")
export default function OrgSwitcher({ orgs, loading = false, error = "", activeOrg = null, onSelect, onRetry }) {
  const uid = useId();
  const selectId = `${uid}-org`;
  const list = orgs || [];
  const activeId = activeOrg?.id || "";
  // The stored selection may not be in the list (yet): keep it selectable so the control never lies.
  const missing = activeId && !list.some((o) => o.id === activeId);

  function change(e) {
    const id = e.target.value;
    if (!id) return onSelect(null);
    const found = list.find((o) => o.id === id);
    if (found) onSelect({ id: found.id, name: found.name });
    else if (activeOrg && activeOrg.id === id) onSelect(activeOrg);
  }

  return (
    <div className="org-switcher">
      <label htmlFor={selectId}>
        <span className="kicker inline">Working in</span>
      </label>
      <select id={selectId} value={activeId} onChange={change} aria-busy={loading && !orgs}>
        <option value="">No organization selected</option>
        {missing && <option value={activeId}>{activeOrg.name}</option>}
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
            {o.status === "suspended" ? " (suspended)" : ""}
          </option>
        ))}
      </select>
      {loading && !orgs && <span className="muted small">Loading organizations…</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}{" "}
          {onRetry && (
            <button type="button" className="link-btn" onClick={onRetry}>Retry</button>
          )}
        </span>
      )}
    </div>
  );
}
