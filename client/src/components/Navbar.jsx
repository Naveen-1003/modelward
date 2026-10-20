import React, { useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { Icon } from "./ui.jsx";
import Logo from "./Logo.jsx";
import { navFor } from "../navConfig.js";
import { clearNavCounts, useNavCounts } from "../navCounts.js";

const ROLE_LABEL = { super_admin: "Platform admin" };

export default function Navbar() {
  const { user, logout, activeOrg } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const counts = useNavCounts();
  const groups = navFor(user?.role);
  // A super admin works inside one selected organization at a time; everyone else has their own.
  const orgLabel = user.role === "super_admin" ? (activeOrg ? activeOrg.name : "No organization selected") : user.orgName;

  // on mobile the nav is a scrolling strip: keep the current item visible
  useEffect(() => {
    document.querySelector(".sidebar .nav-item.active")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);

  function handleLogout() {
    logout();
    clearNavCounts();
    navigate("/login");
  }

  return (
    <aside className="sidebar">
      <Link className="brand" to="/" aria-label="ModelWard home">
        <Logo />
      </Link>
      <nav aria-label="Main">
        {groups.map((g, gi) => (
          <div className="nav-group" key={g.label || gi}>
            {g.label && <div className="nav-group-label">{g.label}</div>}
            {g.items.map((it) => {
              const active =
                (it.end ? pathname === it.to : pathname === it.to || pathname.startsWith(`${it.to}/`)) ||
                (it.also || []).some((p) => pathname === p || pathname.startsWith(`${p}/`));
              const n = it.badge ? counts[it.badge] || 0 : 0;
              return (
                <Link key={it.to} to={it.to} className={`nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                  <Icon name={it.icon} />
                  <span className="nav-label">{it.label}</span>
                  {n > 0 && (
                    <>
                      <span className="nav-badge" aria-hidden="true">{n > 99 ? "99+" : n}</span>
                      <span className="sr-only"> ({n} waiting)</span>
                    </>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-user">
        <div className="who">
          <strong>{user.name}</strong>
          <span>{ROLE_LABEL[user.role] || user.role.replace(/_/g, " ")}</span>
          {orgLabel && <span className="who-org" title={orgLabel}>{orgLabel}</span>}
        </div>
        <button className="icon-btn" onClick={handleLogout} aria-label="Log out" title="Log out">
          <Icon name="logout" />
        </button>
      </div>
    </aside>
  );
}
