import React, { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import api, { extractError } from "../api/axios.js";
import { useAuth } from "../context/AuthContext.jsx";
import { roleHome } from "../roleHome.js";
import { ErrorBox } from "../components/ui.jsx";
import PasswordInput from "../components/PasswordInput.jsx";
import AuthAside, { AuthLoading } from "./AuthAside.jsx";

const FLASH_KEY = "modelward_flash";

function readFlash() {
  try {
    return sessionStorage.getItem(FLASH_KEY) || "";
  } catch {
    return "";
  }
}

function clearFlash() {
  try {
    sessionStorage.removeItem(FLASH_KEY);
  } catch {
    /* ignore */
  }
}

export default function Login() {
  const { user, login, loading } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // The "session expired" / "server unreachable" notice is written while the boot-time
  // /auth/me check runs, so read it only once that has finished, then clear it so it is
  // shown once and never leaks into a later, unrelated visit. (Only a non-empty read
  // sets state: StrictMode runs this effect twice and the second read is empty.)
  useEffect(() => {
    if (loading) return;
    const msg = readFlash();
    if (msg) {
      setFlash(msg);
      clearFlash();
    }
  }, [loading]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const { data } = await api.post("/auth/login", { email: form.email.trim(), password: form.password });
      login(data.token, data.user);
      navigate(roleHome(data.user.role));
    } catch (err) {
      // 403 = deactivated, 429 = throttled: the server's wording is the useful part.
      setError(extractError(err));
      setSubmitting(false);
    }
  }

  if (loading) return <AuthLoading />;
  if (user) return <Navigate to={roleHome(user.role)} replace />;

  return (
    <main className="auth-page">
      <AuthAside />
      <section className="auth-main">
        <div className="auth-card">
          <h1>Sign in</h1>
          <p className="muted">Pick up where your governance workflow left off.</p>
          {flash && !error && <div className="notice" role="status">{flash}</div>}
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
              <PasswordInput
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
