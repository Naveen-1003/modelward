import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { roleHome } from "../roleHome.js";

const ROLES = [
  { value: "ml_engineer", label: "ML Engineer / Data Scientist" },
  { value: "compliance_officer", label: "Compliance Officer / Reviewer" },
  { value: "admin", label: "Admin" },
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
    <main className="page" style={{ maxWidth: 420 }}>
      <h2>Create your ModelWard account</h2>
      <p className="muted">
        MVP shortcut: pick your role here directly, no invite flow.
      </p>
      {error && <div className="error-box">{error}</div>}
      <form onSubmit={handleSubmit}>
        <label>
          Full name
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          Email
          <input
            type="email"
            required
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
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </label>
        <label>
          Role
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={submitting} aria-busy={submitting}>
          Create account
        </button>
      </form>
      <p className="muted">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </main>
  );
}
