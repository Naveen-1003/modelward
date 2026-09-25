import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="navbar">
      <a className="brand" href="/">ModelWard</a>
      <nav>
        {user?.role === "ml_engineer" && (
          <NavLink to="/ml" className={({ isActive }) => (isActive ? "active" : "")}>
            My Models
          </NavLink>
        )}
        {user?.role === "compliance_officer" && (
          <NavLink to="/compliance" className={({ isActive }) => (isActive ? "active" : "")}>
            Review Queue
          </NavLink>
        )}
        {user?.role === "admin" && (
          <NavLink to="/admin" className={({ isActive }) => (isActive ? "active" : "")}>
            Overview
          </NavLink>
        )}
        {user && (
          <>
            <span className="role-chip">{user.name} · {user.role.replace("_", " ")}</span>
            <button onClick={handleLogout}>Log out</button>
          </>
        )}
      </nav>
    </div>
  );
}
