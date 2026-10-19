import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api, { extractError, extractFields } from "../api/axios.js";
import { useConfig } from "../context/ConfigContext.jsx";
import { ErrorBox } from "../components/ui.jsx";
import AuthAside from "./AuthAside.jsx";

// Shared by /verify-email and /setup-password: a one-time link whose token is checked on load,
// then exchanged (together with a new password) for the next step.
//
// The token lives only in a ref. It is read from the URL once, removed from the address bar after
// the first successful check, sent to the two endpoints and never rendered, logged or stored.
//
// props:
//   title, submitLabel, busyLabel   copy
//   checkPath, submitPath           POST endpoints ({token} / {token,password})
//   invalidTitle, invalidLinks      what to show when the link is dead: [{ to, label }]
//   onSuccess(data)                 called with the submit response; returns a node to show
//                                   (the "done" state), or null when the caller navigates away
//                                   (undefined = unexpected answer, shown as an error).
export default function LinkPasswordPage({ title, submitLabel, busyLabel, checkPath, submitPath, invalidTitle, invalidLinks, onSuccess }) {
  const [params] = useSearchParams();
  const { config } = useConfig();
  const minLen = config.minPasswordLength || 8;

  const tokenRef = useRef((params.get("token") || "").trim());
  const started = useRef(false); // StrictMode runs mount effects twice: only one check may go out
  const mounted = useRef(true);

  const [phase, setPhase] = useState(tokenRef.current ? "checking" : "invalid");
  const [info, setInfo] = useState(null); // { name, email, orgName }
  const [message, setMessage] = useState(tokenRef.current ? "" : "This link is missing its token.");
  const [form, setForm] = useState({ password: "", confirm: "" });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);

  const runCheck = useCallback(async () => {
    setPhase("checking");
    setMessage("");
    try {
      const { data } = await api.post(checkPath, { token: tokenRef.current });
      if (!mounted.current) return;
      setInfo({ name: data?.name || "", email: data?.email || "", orgName: data?.orgName || "" });
      setPhase("ready");
      // The link has served its purpose in the address bar: keep it out of history, screenshots
      // and copy-paste. (history.state is preserved so react-router's bookkeeping stays intact.)
      try {
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.hash);
      } catch {
        /* ignore */
      }
    } catch (err) {
      if (!mounted.current) return;
      const status = err?.response?.status;
      setMessage(extractError(err));
      // 400 = unknown / expired / used link, 403 = account can't be activated (e.g. suspended org).
      setPhase(status === 400 || status === 403 ? "invalid" : "error");
    }
  }, [checkPath]);

  useEffect(() => {
    mounted.current = true;
    if (tokenRef.current && !started.current) {
      started.current = true;
      runCheck();
    }
    return () => {
      mounted.current = false;
    };
  }, [runCheck]);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  // Mirrors the server (min from /config, max 128 characters / 72 bytes) plus the confirmation.
  function validate() {
    const e = {};
    if (form.password.length < minLen) e.password = `Password must be at least ${minLen} characters.`;
    else if (form.password.length > 128) e.password = "Password must be 128 characters or fewer.";
    else if (new TextEncoder().encode(form.password).length > 72) e.password = "Password must be at most 72 bytes (some characters count as more than one).";
    if (!form.confirm) e.confirm = "Re-enter your password.";
    else if (form.confirm !== form.password) e.confirm = "The passwords don't match.";
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
      const { data } = await api.post(submitPath, { token: tokenRef.current, password: form.password });
      if (!mounted.current) return;
      const node = onSuccess(data);
      if (node === null) return; // the caller navigates away, the page is about to unmount
      if (node) {
        tokenRef.current = "";
        setForm({ password: "", confirm: "" });
        setDone(node);
      } else {
        setError("The server sent an unexpected answer. Please try again.");
      }
      setSubmitting(false);
    } catch (err) {
      if (!mounted.current) return;
      const fields = extractFields(err);
      const status = err?.response?.status;
      if (Object.keys(fields).length) {
        // Weak password: the server did not use up the link, the person can just try again.
        setErrors(fields);
        setError(extractError(err));
      } else if (status === 400 || status === 403) {
        setMessage(extractError(err));
        setPhase("invalid");
      } else {
        setError(extractError(err));
      }
      setSubmitting(false);
    }
  }

  function fieldProps(name) {
    return errors[name] ? { "aria-invalid": true, "aria-describedby": `lp-${name}-err` } : {};
  }
  const fieldError = (name) =>
    errors[name] ? <small className="field-error" id={`lp-${name}-err`}>{errors[name]}</small> : null;

  let body;
  if (done) {
    body = done;
  } else if (phase === "checking") {
    body = (
      <>
        <h1>{title}</h1>
        <p className="muted auth-lead" role="status">Checking your link…</p>
      </>
    );
  } else if (phase === "invalid") {
    body = (
      <>
        <h1>{invalidTitle}</h1>
        <ErrorBox>{message}</ErrorBox>
        <p className="muted auth-switch">
          {invalidLinks.map((l, i) => (
            <React.Fragment key={l.to}>
              {i > 0 && " · "}
              <Link to={l.to}>{l.label}</Link>
            </React.Fragment>
          ))}
        </p>
      </>
    );
  } else if (phase === "error") {
    body = (
      <>
        <h1>{title}</h1>
        <ErrorBox>{message}</ErrorBox>
        <div className="auth-actions">
          <button type="button" className="secondary" onClick={runCheck}>Try again</button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h1>{title}</h1>
        <dl className="auth-identity">
          {info.name && (<><dt>Name</dt><dd>{info.name}</dd></>)}
          {info.email && (<><dt>Email</dt><dd>{info.email}</dd></>)}
          {info.orgName && (<><dt>Organization</dt><dd>{info.orgName}</dd></>)}
        </dl>
        <ErrorBox>{error}</ErrorBox>
        <form onSubmit={handleSubmit} noValidate>
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
          <label>
            Confirm password
            <input
              type="password"
              maxLength={128}
              autoComplete="new-password"
              value={form.confirm}
              onChange={(e) => set("confirm", e.target.value)}
              {...fieldProps("confirm")}
            />
            {fieldError("confirm")}
          </label>
          <button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? busyLabel : submitLabel}
          </button>
        </form>
      </>
    );
  }

  return (
    <main className="auth-page">
      <AuthAside />
      <section className="auth-main">
        <div className="auth-card">{body}</div>
      </section>
    </main>
  );
}
