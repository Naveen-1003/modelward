import React, { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import api, { extractError, extractFields } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useConfig } from "../context/ConfigContext.jsx";
import { roleHome } from "../roleHome.js";
import { ErrorBox } from "../components/ui.jsx";
import AuthAside, { AuthLoading } from "./AuthAside.jsx";

const ROLES = [
  { value: "ml_engineer", label: "ML Engineer", note: "Register models, upload versions" },
  { value: "compliance_officer", label: "Compliance Officer", note: "Review, approve and deploy" },
  { value: "admin", label: "Admin", note: "Portfolio overview and deploys" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Signup() {
  const { user, login, loading } = useAuth();
  const { config } = useConfig();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "ml_engineer", inviteCode: "" });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const needsCode = (config.signupRolesRequiringCode || []).includes(form.role);
  const minLen = config.minPasswordLength || 8;

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  // Mirrors the server's checks so most mistakes never cost a round trip.
  function validate() {
    const e = {};
    if (!form.name.trim()) e.name = "Enter your full name.";
    else if (form.name.trim().length > 100) e.name = "Name must be 100 characters or fewer.";
    if (!EMAIL_RE.test(form.email.trim())) e.email = "Enter a valid email address.";
    if (form.password.length < minLen) e.password = `Password must be at least ${minLen} characters.`;
    else if (form.password.length > 128) e.password = "Password must be 128 characters or fewer.";
    if (needsCode && !form.inviteCode.trim()) e.inviteCode = "Enter the invite code for this role.";
    return e;
  }

  async function handleSubmit(ev) {
    ev.preventDefault();
    setError("");
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    setSubmitting(true);
    try {
      const body = { name: form.name.trim(), email: form.email.trim(), password: form.password, role: form.role };
      if (needsCode) body.inviteCode = form.inviteCode.trim();
      const { data } = await api.post("/auth/signup", body);
      login(data.token, data.user);
      navigate(roleHome(data.user.role));
    } catch (err) {
      setErrors(extractFields(err));
      setError(extractError(err));
      setSubmitting(false);
    }
  }

  if (loading) return <AuthLoading />;
  if (user) return <Navigate to={roleHome(user.role)} replace />;

  function fieldProps(name) {
    return errors[name] ? { "aria-invalid": true, "aria-describedby": `signup-${name}-err` } : {};
  }
  const fieldError = (name) =>
    errors[name] ? <small className="field-error" id={`signup-${name}-err`}>{errors[name]}</small> : null;

  return (
    <main className="auth-page">
      <AuthAside />
      <section className="auth-main">
        <div className="auth-card">
          <h1>Create your account</h1>
          <p className="muted">Choose the role you'll work in. Admin and compliance roles need an invite code.</p>
          <ErrorBox>{error}</ErrorBox>
          <form onSubmit={handleSubmit} noValidate>
            <label>
              Full name
              <input
                autoComplete="name"
                maxLength={100}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                {...fieldProps("name")}
              />
              {fieldError("name")}
            </label>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                {...fieldProps("email")}
              />
              {fieldError("email")}
            </label>
            <label>
              Password
              <input
                type="password"
                maxLength={128}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                {...fieldProps("password")}
              />
              <small className="hint">At least {minLen} characters</small>
              {fieldError("password")}
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
                    onChange={() => {
                      set("role", r.value);
                      setErrors((e) => ({ ...e, role: undefined, inviteCode: undefined }));
                    }}
                  />
                  <span>
                    <strong>{r.label}</strong>
                    <small>{r.note}</small>
                  </span>
                </label>
              ))}
              {fieldError("role")}
            </fieldset>
            {needsCode && (
              <label>
                <span>Invite code <span className="req" aria-hidden="true">*</span></span>
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={form.inviteCode}
                  onChange={(e) => set("inviteCode", e.target.value)}
                  {...fieldProps("inviteCode")}
                />
                <small className="hint">Ask your administrator for the invite code</small>
                {fieldError("inviteCode")}
              </label>
            )}
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
