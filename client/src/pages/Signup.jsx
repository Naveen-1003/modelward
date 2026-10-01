import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { roleHome } from "../roleHome.js";
import { ErrorBox } from "../components/ui.jsx";
import AuthAside from "./AuthAside.jsx";

const ROLES = [
  { value: "ml_engineer", label: "ML Engineer", note: "Register models, upload versions" },
  { value: "compliance_officer", label: "Compliance Officer", note: "Review, approve and deploy" },
  { value: "admin", label: "Admin", note: "Portfolio overview and deploys" },
];

export default function Signup() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "ml_engineer" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const { data } = await api.post("/auth/signup", form);
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
          <h1>Create your account</h1>
          <p className="muted">Choose the role you'll work in. There's no invite flow yet.</p>
          <ErrorBox>{error}</ErrorBox>
          <form onSubmit={handleSubmit}>
            <label>
              Full name
              <input
                required
                autoComplete="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
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
                minLength={6}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
              <small className="hint">At least 6 characters</small>
            </label>
            <fieldset className="choice-group">
              <legend>Role</legend>
              {ROLES.map((r) => (
                <label key={r.value} className="choice">
                  <input
                    type="radio"
                    name="role"
                    value={r.value}
                    checked={form.role === r.value}
                    onChange={() => setForm({ ...form, role: r.value })}
                  />
                  <span>
                    <strong>{r.label}</strong>
                    <small>{r.note}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <button type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? "Creating account…" : "Create account"}
            </button>
          </form>
          <p className="muted auth-switch">
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
