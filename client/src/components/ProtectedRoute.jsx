import React from "react";
import { Navigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { roleHome } from "../roleHome.js";

export default function ProtectedRoute({ roles, children }) {
  const { user, loading } = useAuth();

  if (loading) return <p className="page muted" role="status">Loading...</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) {
    return (
      <main className="page">
        <div className="empty-state" role="alert">
          <p>Your role doesn't have access to this page.</p>
          <p style={{ marginTop: "0.75rem" }}>
            <Link to={roleHome(user.role)}>Go to your dashboard</Link>
          </p>
        </div>
      </main>
    );
  }

  return children;
}
