import React from "react";
import { Link, useNavigate } from "react-router-dom";
import LinkPasswordPage from "./LinkPasswordPage.jsx";

const INVALID_LINKS = [
  { to: "/signup", label: "Sign up again" },
  { to: "/login", label: "Sign in" },
];

// /verify-email?token=...  Confirms the mailbox and sets the password in one step. The server
// issues no login token here: the person signs in normally once the account is active.
export default function VerifyEmail() {
  const navigate = useNavigate();

  function onSuccess(data) {
    const active = data?.status === "active";
    return (
      <>
        <h1>Email confirmed</h1>
        <div className="notice" role="status">
          {active
            ? "Email confirmed. You can sign in now."
            : "Email confirmed. Your organization's admin must approve your account before you can sign in."}
        </div>
        {active ? (
          <div className="auth-actions">
            <button type="button" onClick={() => navigate("/login")}>Sign in</button>
          </div>
        ) : (
          <p className="muted auth-switch">
            <Link to="/login">Back to sign in</Link>
          </p>
        )}
      </>
    );
  }

  return (
    <LinkPasswordPage
      title="Confirm your email"
      submitLabel="Confirm email"
      busyLabel="Confirming…"
      checkPath="/auth/verify-email/check"
      submitPath="/auth/verify-email"
      invalidTitle="This link can't be used"
      invalidLinks={INVALID_LINKS}
      onSuccess={onSuccess}
    />
  );
}
