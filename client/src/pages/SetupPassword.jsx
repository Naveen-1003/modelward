import React from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { roleHome } from "../roleHome.js";
import LinkPasswordPage from "./LinkPasswordPage.jsx";

const INVALID_LINKS = [{ to: "/login", label: "Sign in" }];

// /setup-password?token=...  For accounts created by an admin: choosing a password activates
// the account and signs the person in (the server returns { token, user }).
export default function SetupPassword() {
  const { login } = useAuth();
  const navigate = useNavigate();

  function onSuccess(data) {
    if (!data?.token || !data?.user) return undefined;
    login(data.token, data.user);
    navigate(roleHome(data.user.role), { replace: true });
    return null; // navigating away: nothing more to render
  }

  return (
    <LinkPasswordPage
      title="Set your password"
      submitLabel="Set password and sign in"
      busyLabel="Saving…"
      checkPath="/auth/setup-password/check"
      submitPath="/auth/setup-password"
      invalidTitle="This link can't be used"
      invalidLinks={INVALID_LINKS}
      onSuccess={onSuccess}
    />
  );
}
