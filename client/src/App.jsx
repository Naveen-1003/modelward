import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import { roleHome } from "./roleHome.js";

import Navbar from "./components/Navbar.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";

import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import MLDashboard from "./pages/MLDashboard.jsx";
import ModelDetail from "./pages/ModelDetail.jsx";
import ComplianceDashboard from "./pages/ComplianceDashboard.jsx";
import AdminDashboard from "./pages/AdminDashboard.jsx";

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <p className="page muted">Loading...</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={roleHome(user.role)} replace />;
}

export default function App() {
  const { user } = useAuth();

  return (
    <div className="app-shell">
      {user && <Navbar />}
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />

        <Route
          path="/ml"
          element={
            <ProtectedRoute roles={["ml_engineer"]}>
              <MLDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/models/:id"
          element={
            <ProtectedRoute>
              <ModelDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="/compliance"
          element={
            <ProtectedRoute roles={["compliance_officer"]}>
              <ComplianceDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute roles={["admin"]}>
              <AdminDashboard />
            </ProtectedRoute>
          }
        />

        <Route path="/" element={<Home />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </div>
  );
}
