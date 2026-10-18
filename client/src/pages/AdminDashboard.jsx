import React, { useRef, useState } from "react";
import { PageHeader } from "../components/ui.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";
import ModelBrowser from "../components/ModelBrowser.jsx";
import OverviewTab from "./admin/OverviewTab.jsx";
import UsersTab from "./admin/UsersTab.jsx";
import ThresholdsTab from "./admin/ThresholdsTab.jsx";
import TrashTab from "./admin/TrashTab.jsx";

const TABS = [
  { id: "overview", label: "Overview", Panel: OverviewTab },
  { id: "models", label: "Models", Panel: ModelBrowser },
  { id: "users", label: "Users", Panel: UsersTab },
  { id: "thresholds", label: "Thresholds", Panel: ThresholdsTab },
  { id: "trash", label: "Trash", Panel: TrashTab },
  { id: "audit", label: "Audit log", Panel: AuditLogTable },
];

export default function AdminDashboard() {
  const [active, setActive] = useState("overview");
  const tabRefs = useRef({});

  // WAI-ARIA tabs: arrows move between tabs, Home/End jump to the ends.
  function onKeyDown(e) {
    const i = TABS.findIndex((t) => t.id === active);
    let next = null;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    setActive(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  }

  const current = TABS.find((t) => t.id === active) || TABS[0];
  const Panel = current.Panel;

  return (
    <main className="page">
      <PageHeader
        kicker="Admin"
        title="Governance overview"
        description="Model risk, review status and deployment across the portfolio, plus users, thresholds and archived items."
      />

      <div className="tabs" role="tablist" aria-label="Admin sections" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`admin-tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls="admin-panel"
            tabIndex={active === t.id ? 0 : -1}
            className="tab"
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="admin-panel" aria-labelledby={`admin-tab-${current.id}`}>
        <Panel key={current.id} />
      </div>
    </main>
  );
}
