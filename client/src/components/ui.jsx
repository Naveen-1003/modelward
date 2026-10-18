import React from "react";

const PATHS = {
  registry: "M4 5h16M4 12h16M4 19h10",
  queue: "M4 13l3-8h10l3 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
  overview: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  logout: "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10",
  plus: "M12 5v14M5 12h14",
  back: "M19 12H5M11 6l-6 6 6 6",
  alert: "M12 4l9 16H3L12 4zM12 10v4M12 17v.01",
  check: "M5 12l5 5 9-10",
  trash: "M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  restore: "M4 12a8 8 0 1 0 2.5-5.8M4 4v5h5",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20",
  print: "M7 9V4h10v5M7 17H4v-7h16v7h-3M7 14h10v6H7z",
  compare: "M8 4L4 8l4 4M4 8h16M16 20l4-4-4-4M20 16H4",
  upload: "M12 16V5M7 9l5-5 5 5M5 20h14",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.3c2 .8 3.5 2.6 3.5 5.7",
  settings: "M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6",
  refresh: "M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5",
  close: "M6 6l12 12M18 6L6 18",
  file: "M6 3h8l5 5v13H6zM14 3v5h5",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.01",
};

export function Icon({ name, size = 16 }) {
  if (!PATHS[name]) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function PageHeader({ kicker, title, description, children }) {
  return (
    <header className="page-header">
      <div>
        <div className="kicker">{kicker}</div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {children && <div className="page-header-actions">{children}</div>}
    </header>
  );
}

export function Loading({ rows = 3 }) {
  return (
    <div className="skel-list" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

export function ErrorBox({ children }) {
  return children ? <div className="error-box" role="alert">{children}</div> : null;
}
