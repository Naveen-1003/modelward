import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { PageHeader } from "../components/ui.jsx";
import AuditLogTable from "../components/AuditLogTable.jsx";
import ModelBrowser from "../components/ModelBrowser.jsx";
import OrgSwitcher from "../components/OrgSwitcher.jsx";
import OverviewTab from "./admin/OverviewTab.jsx";
import OrganizationsTab from "./admin/OrganizationsTab.jsx";
import UsersTab from "./admin/UsersTab.jsx";
import PendingTab from "./admin/PendingTab.jsx";
import OrgSettingsTab from "./admin/OrgSettingsTab.jsx";
import ThresholdsTab from "./admin/ThresholdsTab.jsx";
import TrashTab from "./admin/TrashTab.jsx";

// scope "org": needs an organization (the admin's own, or the one a platform admin selected).
// scope "platform": works without one (the audit log then covers every organization).
const ORG_TABS = [
  { id: "overview", label: "Overview", scope: "org" },
  { id: "models", label: "Models", scope: "org" },
  { id: "users", label: "Users", scope: "org" },
  { id: "pending", label: "Pending", scope: "org" },
  { id: "organization", label: "Organization", scope: "org" },
  { id: "thresholds", label: "Thresholds", scope: "org" },
  { id: "trash", label: "Trash", scope: "org" },
  { id: "audit", label: "Audit log", scope: "platform" },
];
const PLATFORM_TABS = [{ id: "orgs", label: "Organizations", scope: "platform" }, ...ORG_TABS];

export default function AdminDashboard() {
  const { user, activeOrg: storedOrg, setActiveOrg } = useAuth();
  const isSuper = user?.role === "super_admin";
  const activeOrg = isSuper && storedOrg ? storedOrg : null;
  const orgId = activeOrg?.id || null;
  const needsOrg = isSuper && !orgId;
  // Everything org-scoped is keyed by this, so nothing from a previously selected organization survives a switch.
  const scopeKey = isSuper ? orgId || "none" : "own";

  const TABS = isSuper ? PLATFORM_TABS : ORG_TABS;
  const [active, setActive] = useState(isSuper ? "orgs" : "overview");
  const tabRefs = useRef({});

  // --- organizations (platform admin only) -------------------------------------------------
  const [orgs, setOrgs] = useState(null);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState("");
  const orgsReq = useRef(0);

  const loadOrgs = useCallback(() => {
    if (!isSuper) return undefined;
    const id = ++orgsReq.current;
    setOrgsLoading(true);
    return api
      .get("/orgs")
      .then(({ data }) => {
        if (id !== orgsReq.current) return;
        setOrgs(Array.isArray(data.orgs) ? data.orgs : []);
        setOrgsError("");
      })
      .catch((err) => {
        if (id === orgsReq.current) setOrgsError(extractError(err));
      })
      .finally(() => {
        if (id === orgsReq.current) setOrgsLoading(false);
      });
  }, [isSuper]);

  useEffect(() => {
    loadOrgs();
    return () => {
      orgsReq.current += 1; // drop a late answer after unmount
    };
  }, [loadOrgs]);

  // A rename made on the Organizations tab must reach the stored selection too.
  const listedName = orgs && orgId ? orgs.find((o) => o.id === orgId)?.name : undefined;
  useEffect(() => {
    if (listedName && activeOrg && listedName !== activeOrg.name && typeof setActiveOrg === "function") {
      setActiveOrg({ id: activeOrg.id, name: listedName });
    }
  }, [listedName, activeOrg, setActiveOrg]);

  // --- pending sign-ups badge --------------------------------------------------------------
  const [pendingCount, setPendingCount] = useState(0);
  const pendingReq = useRef(0);

  const refreshPending = useCallback(() => {
    if (needsOrg) return;
    const id = ++pendingReq.current;
    api
      .get("/users/pending")
      .then(({ data }) => {
        if (id === pendingReq.current) setPendingCount(Number.isFinite(data.total) ? data.total : 0);
      })
      .catch(() => {
        /* the badge is a convenience: a failure just leaves the old number */
      });
  }, [needsOrg]);

  useEffect(() => {
    setPendingCount(0);
    refreshPending();
    // coming back to this browser tab: somebody may have signed up meanwhile
    window.addEventListener("focus", refreshPending);
    return () => {
      pendingReq.current += 1;
      window.removeEventListener("focus", refreshPending);
    };
    // scopeKey: a different organization means a different queue
  }, [refreshPending, scopeKey]);

  // --- actions -----------------------------------------------------------------------------
  const selectOrg = useCallback(
    (org) => {
      if (typeof setActiveOrg === "function") setActiveOrg(org);
    },
    [setActiveOrg]
  );

  const openOrg = useCallback(
    (org) => {
      selectOrg(org);
      setActive("overview");
    },
    [selectOrg]
  );

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

  const panel = useMemo(() => {
    if (current.scope === "org" && needsOrg) {
      return (
        <div className="empty-state">
          <p><strong>Select an organization to view this section</strong></p>
          <p className="small">
            Choose one in the selector above, or open one from the{" "}
            <button type="button" className="link-btn" onClick={() => setActive("orgs")}>Organizations</button> tab.
          </p>
        </div>
      );
    }
    switch (current.id) {
      case "orgs":
        return (
          <OrganizationsTab
            orgs={orgs}
            loading={orgsLoading}
            error={orgsError}
            onReload={loadOrgs}
            onOpenOrg={openOrg}
            activeOrgId={orgId}
          />
        );
      case "overview":
        return <OverviewTab onOpenPending={() => setActive("pending")} />;
      case "models":
        return <ModelBrowser />;
      case "users":
        return <UsersTab />;
      case "pending":
        return <PendingTab onChanged={refreshPending} />;
      case "organization":
        return <OrgSettingsTab />;
      case "thresholds":
        return <ThresholdsTab />;
      case "trash":
        return <TrashTab />;
      case "audit":
        return <AuditLogTable />;
      default:
        return null;
    }
  }, [current, needsOrg, orgs, orgsLoading, orgsError, loadOrgs, openOrg, orgId, refreshPending]);

  const orgName = user?.orgName;
  const header = isSuper
    ? {
        kicker: "Platform admin",
        title: "Platform overview",
        description: activeOrg
          ? `Working inside ${activeOrg.name}. Manage organizations, or switch to another one above.`
          : "Create and manage organizations, then open one to see its models, users and settings. The audit log covers every organization.",
      }
    : {
        kicker: orgName ? `${orgName} · Admin` : "Admin",
        title: "Governance overview",
        description: "Model risk, review status and deployment across your organization, plus users, sign-ups, thresholds and archived items.",
      };

  return (
    <main className="page">
      <PageHeader kicker={header.kicker} title={header.title} description={header.description} />

      {isSuper && (
        <OrgSwitcher
          orgs={orgs}
          loading={orgsLoading}
          error={orgsError}
          activeOrg={activeOrg}
          onSelect={selectOrg}
          onRetry={loadOrgs}
        />
      )}

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
            {t.id === "pending" && pendingCount > 0 && !needsOrg && (
              <>
                <span className="count-pill count-pill-attn" aria-hidden="true">{pendingCount > 99 ? "99+" : pendingCount}</span>
                <span className="sr-only"> ({pendingCount} waiting)</span>
              </>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="admin-panel" aria-labelledby={`admin-tab-${current.id}`}>
        <React.Fragment key={`${current.id}:${scopeKey}`}>{panel}</React.Fragment>
      </div>
    </main>
  );
}
