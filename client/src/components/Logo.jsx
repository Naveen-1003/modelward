import React from "react";

// The ModelWard wordmark. Follows the system light/dark theme unless `dark` forces the light-on-dark version.
export default function Logo({ dark = false, className = "" }) {
  const img = <img className="logo-img" src={dark ? "/logo-header-dark.png" : "/logo-header.png"} alt="ModelWard" width="110" height="30" />;
  if (dark) return <span className={className}>{img}</span>;
  return (
    <picture className={className}>
      <source media="(prefers-color-scheme: dark)" srcSet="/logo-header-dark.png" />
      {img}
    </picture>
  );
}
