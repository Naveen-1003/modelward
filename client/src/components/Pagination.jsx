import React from "react";

export default function Pagination({ page = 1, pages = 1, total = 0, onPage }) {
  if (!pages || pages <= 1) return null;
  const go = (p) => {
    if (p >= 1 && p <= pages && p !== page && onPage) onPage(p);
  };
  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" className="secondary" onClick={() => go(page - 1)} disabled={page <= 1}>
        Previous
      </button>
      <span className="pagination-info muted" aria-live="polite">
        Page {page} of {pages} · {total} total
      </span>
      <button type="button" className="secondary" onClick={() => go(page + 1)} disabled={page >= pages}>
        Next
      </button>
    </nav>
  );
}
