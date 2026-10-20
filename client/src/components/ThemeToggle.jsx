import React from "react";
import { Icon } from "./ui.jsx";
import { useTheme } from "../context/ThemeContext.jsx";

// Fixed in the top-right corner of every page.
export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button type="button" className="theme-toggle no-print" onClick={toggle} aria-label={label} title={label}>
      <Icon name={dark ? "sun" : "moon"} size={18} />
    </button>
  );
}
