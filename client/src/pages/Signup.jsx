import React, { useEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import api, { extractError, extractFields } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useConfig } from "../context/ConfigContext.jsx";
import { roleHome } from "../roleHome.js";
import { ErrorBox } from "../components/ui.jsx";
import AuthAside, { AuthLoading } from "./AuthAside.jsx";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_COOLDOWN_S = 30;

// The dev-only link comes from our own server, but is still only rendered as a link when it is http(s).
const isHttpUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

export default function Signup() {
  const { user, loading } = useAuth();
  const { config } = useConfig();
  const [form, setForm] = useState({ joinCode: "", name: "", email: "" });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Set once the server accepted the signup: { email, emailSent, devVerifyUrl }.
  const [sent, setSent] = useState(null);
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState("");
  const [resendError, setResendError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Client-side resend throttle (the server has its own per-IP / per-email limiter).
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  // Mirrors the server's checks so most mistakes never cost a round trip.
  function validate() {
    const e = {};
    if (!form.joinCode.trim()) e.joinCode = "Enter your join code.";
    else if (form.joinCode.trim().length > 64) e.joinCode = "Join code must be 64 characters or fewer.";
    if (!form.name.trim()) e.name = "Enter your full name.";
    else if (form.name.trim().length > 100) e.name = "Name must be 100 characters or fewer.";
    if (!EMAIL_RE.test(form.email.trim()) || form.email.trim().length > 254) e.email = "Enter a valid email address.";
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
      const email = form.email.trim();
      const { data } = await api.post("/auth/signup", {
        name: form.name.trim(),
        email,
        joinCode: form.joinCode.trim(),
      });
      if (!alive.current) return;
      const emailSent = data?.emailSent !== false;
      setSent({ email, emailSent, devVerifyUrl: isHttpUrl(data?.devVerifyUrl) ? data.devVerifyUrl : "" });
      setCooldown(emailSent ? RESEND_COOLDOWN_S : 0);
      setSubmitting(false);
    } catch (err) {
      if (!alive.current) return;
      setErrors(extractFields(err));
      setError(extractError(err));
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (!sent || resending || cooldown > 0) return;
    setResending(true);
    setResendMsg("");
    setResendError("");
    try {
      const { data } = await api.post("/auth/resend-verification", { email: sent.email });
      if (!alive.current) return;
      setResendMsg(data?.message || "If that address is waiting for verification, a new link has been sent.");
      setCooldown(RESEND_COOLDOWN_S);
    } catch (err) {
      if (alive.current) setResendError(extractError(err));
    } finally {
      if (alive.current) setResending(false);
    }
  }

  if (loading) return <AuthLoading />;
  if (user) return <Navigate to={roleHome(user.role)} replace />;

  function fieldProps(name) {
    return errors[name] ? { "aria-invalid": true, "aria-describedby": `signup-${name}-err` } : {};
  }
  const fieldError = (name) =>
    errors[name] ? <small className="field-error" id={`signup-${name}-err`}>{errors[name]}</small> : null;

  // Signup closed on this deployment (server answers 503 too, this just spares the form).
  if (config.signupEnabled === false) {
    return (
      <main className="auth-page">
        <AuthAside />
        <section className="auth-main">
          <div className="auth-card">
            <h1>Create your account</h1>
            <div className="notice" role="status">
              Self-registration is currently unavailable. Ask your organization admin to add you.
            </div>
            <p className="muted auth-switch">
              Already registered? <Link to="/login">Sign in</Link>
            </p>
          </div>
        </section>
      </main>
    );
  }

  if (sent) {
    return (
      <main className="auth-page">
        <AuthAside />
        <section className="auth-main">
          <div className="auth-card">
            <h1>Check your email</h1>
            {sent.emailSent ? (
              <p className="muted auth-lead">
                We sent a confirmation link to <strong>{sent.email}</strong>. Open it to confirm your address and
                choose your password. The link is valid for 7 days.
              </p>
            ) : (
              <>
                <p className="muted auth-lead">
                  Your account was created for <strong>{sent.email}</strong>, but the email could not be sent.
                </p>
                <ErrorBox>The confirmation email could not be sent. Use “Resend email” to try again.</ErrorBox>
              </>
            )}
            {sent.devVerifyUrl && (
              <div className="notice dev-link" role="note">
                <strong>Development only</strong>
                No real email is sent in this environment.{" "}
                <a href={sent.devVerifyUrl}>Open the verification link</a>
              </div>
            )}
            {resendMsg && <div className="notice" role="status">{resendMsg}</div>}
            <ErrorBox>{resendError}</ErrorBox>
            <div className="auth-actions">
              <button
                type="button"
                className="secondary"
                onClick={handleResend}
                disabled={resending || cooldown > 0}
                aria-busy={resending}
              >
                {resending ? "Sending…" : cooldown > 0 ? `Resend email (${cooldown}s)` : "Resend email"}
              </button>
            </div>
            <p className="muted auth-switch">
              Already confirmed? <Link to="/login">Sign in</Link>
            </p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <AuthAside />
      <section className="auth-main">
        <div className="auth-card">
          <h1>Create your account</h1>
          <p className="muted">Join your organization with the code your admin gave you. We'll email you a link to confirm your address and set your password.</p>
          <ErrorBox>{error}</ErrorBox>
          <form onSubmit={handleSubmit} noValidate>
            <label>
              <span>Join code <span className="req" aria-hidden="true">*</span></span>
              <input
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={64}
                required
                value={form.joinCode}
                onChange={(e) => set("joinCode", e.target.value)}
                {...fieldProps("joinCode")}
              />
              <small className="hint">Ask your organization admin for your join code. It decides your role.</small>
              {fieldError("joinCode")}
            </label>
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
                maxLength={254}
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                {...fieldProps("email")}
              />
              {fieldError("email")}
            </label>
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
