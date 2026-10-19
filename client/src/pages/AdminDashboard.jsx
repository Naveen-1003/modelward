import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ADMIN_SECTIONS } from "../navConfig.js";
import { setNavCounts } from "../navCounts.js";
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

// platform sections work without an organization (the audit log then covers every one);
// the rest need one (the admin's own, or the one a platform admin selected).
const scopeOf = (sec) => (sec.platform || sec.id === "audit" ? "platform" : "org");

export default function AdminDashboard() {
  const { user, activeOrg: storedOrg, setActiveOrg } = useAuth();
  const isSuper = user?.role === "super_admin";
  const activeOrg = isSuper && storedOrg ? storedOrg : null;
  const orgId = activeOrg?.id || null;
  const needsOrg = isSuper && !orgId;
  // Everything org-scoped is keyed by this, so nothing from a previously selected organization survives a switch.
  const scopeKey = isSuper ? orgId || "none" : "own";

  const navigate = useNavigate();
  const section = useParams()["*"] || "";
  const defaultSection = isSuper ? "orgs" : "overview";
  const setActive = useCallback((id) => navigate(`/admin/${id}`), [navigate]);

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
    setNavCounts({ pending: needsOrg ? 0 : pendingCount });
  }, [pendingCount, needsOrg]);

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

  const current = ADMIN_SECTIONS.find((t) => t.id === section && (isSuper || !t.platform || t.id === "audit"));
  const currentId = current?.id;

  const panel = useMemo(() => {
    if (current && scopeOf(current) === "org" && needsOrg) {
      return (
        <div className="empty-state">
          <p><strong>Select an organization to view this section</strong></p>
          <p className="small">
            Choose one in the selector above, or open one from the{" "}
            <button type="button" className="link-btn" onClick={() => setActive("orgs")}>Organizations</button> page.
          </p>
        </div>
      );
    }
    switch (currentId) {
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
  }, [current, currentId, needsOrg, orgs, orgsLoading, orgsError, loadOrgs, openOrg, orgId, refreshPending]);

  if (!current) return <Navigate to={`/admin/${defaultSection}`} replace />;

  const orgName = user?.orgName;
  const scopeLabel = isSuper ? (activeOrg ? `${activeOrg.name} · Platform admin` : "Platform admin") : orgName ? `${orgName} · Admin` : "Admin";

  return (
    <main className="page">
      <PageHeader kicker={scopeLabel} title={current.title} description={current.description} />

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

      <div id="admin-panel">
        <React.Fragment key={`${current.id}:${scopeKey}`}>{panel}</React.Fragment>
      </div>
    </main>
  );
}
