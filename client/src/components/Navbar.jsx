import React from "react";
import { NavLink, Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { Icon } from "./ui.jsx";

const NAV = {
  ml_engineer: { to: "/ml", label: "My Models", icon: "registry" },
  compliance_officer: { to: "/compliance", label: "Review Queue", icon: "queue" },
  admin: { to: "/admin", label: "Overview", icon: "overview" },
};

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const item = NAV[user?.role];

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <aside className="sidebar">
      <Link className="brand" to="/">
        <span className="brand-mark" aria-hidden="true">MW</span>
        <span>ModelWard</span>
      </Link>
      <nav aria-label="Main">
        {item && (
          <NavLink to={item.to} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        )}
      </nav>
      <div className="sidebar-user">
        <div className="who">
          <strong>{user.name}</strong>
          <span>{user.role.replace(/_/g, " ")}</span>
        </div>
        <button className="icon-btn" onClick={handleLogout} aria-label="Log out" title="Log out">
          <Icon name="logout" />
        </button>
      </div>
    </aside>
  );
}
