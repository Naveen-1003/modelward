import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { roleHome } from "../roleHome.js";
import { ErrorBox } from "../components/ui.jsx";
import AuthAside from "./AuthAside.jsx";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const { data } = await api.post("/auth/login", form);
      login(data.token, data.user);
      navigate(roleHome(data.user.role));
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <AuthAside />
      <section className="auth-main">
        <div className="auth-card">
          <h1>Sign in</h1>
          <p className="muted">Pick up where your governance workflow left off.</p>
          <ErrorBox>{error}</ErrorBox>
          <form onSubmit={handleSubmit}>
            <label>
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                autoComplete="current-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <button type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="muted auth-switch">
            No account? <Link to="/signup">Create one</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
