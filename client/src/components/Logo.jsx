import React from "react";
import { useTheme } from "../context/ThemeContext.jsx";

// The ModelWard wordmark. Follows the chosen theme unless `dark` forces the light-on-dark version.
export default function Logo({ dark = false, className = "" }) {
  const { theme } = useTheme();
  const src = dark || theme === "dark" ? "/logo-header-dark.png" : "/logo-header.png";
  return <img className={`logo-img ${className}`.trim()} src={src} alt="ModelWard" width="110" height="30" />;
}
