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
};

export function Icon({ name, size = 16 }) {
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
