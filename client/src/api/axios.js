import axios from "axios";

// Unset VITE_API_URL => same-origin "/api" (Vite proxy in dev, a rewrite on the host in prod).
// A value that already ends in "/api" (or "/api/") is accepted too, so we never build "/api/api".
const ORIGIN = (import.meta.env.VITE_API_URL || "")
  .trim()
  .replace(/\/+$/, "")
  .replace(/\/api$/i, "")
  .replace(/\/+$/, "");
export const API_BASE = ORIGIN ? `${ORIGIN}/api` : "/api";

const TOKEN_KEY = "modelward_token";
const FLASH_KEY = "modelward_flash";
const SESSION_EXPIRED = "Your session expired — please sign in again.";

// The guard answers 401 for a suspended organization or a deactivated account; say so instead of
// the generic "session expired" (the server wording is matched loosely, anything else falls back).
function signOutNotice(err) {
  const msg = String(err?.response?.data?.error || "");
  if (/suspended/i.test(msg)) return "Your organization is suspended. Contact the platform administrator.";
  if (/deactivated/i.test(msg)) return "Your account has been deactivated. Contact your organization admin.";
  return SESSION_EXPIRED;
}

const api = axios.create({ baseURL: API_BASE });

// The organization a super admin is currently working in. The interceptor cannot read React
// state, so AuthContext pushes the value here (and clears it on logout / user change). It stays
// null for every non-super-admin, so no other user can ever send an X-Org-Id header.
let orgHeaderId = null;
export function setOrgHeader(id) {
  orgHeaderId = typeof id === "string" && id ? id : null;
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (token && orgHeaderId) config.headers["X-Org-Id"] = orgHeaderId;
  return config;
});

// Credentials or one-time links being wrong on these is a normal 4xx, not an expired session.
const AUTH_ATTEMPT_PATHS = [
  "/auth/login",
  "/auth/signup",
  "/auth/verify-email",
  "/auth/verify-email/check",
  "/auth/setup-password",
  "/auth/setup-password/check",
  "/auth/resend-verification",
];
function isAuthAttempt(url = "") {
  const path = String(url).split("?")[0];
  return AUTH_ATTEMPT_PATHS.includes(path);
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401 && !isAuthAttempt(err.config?.url)) {
      // Only the first 401 of a burst sees a token: it is removed here, so the
      // rest (parallel requests, a stale /auth/me) skip the flash and the event.
      if (localStorage.getItem(TOKEN_KEY)) {
        localStorage.removeItem(TOKEN_KEY);
        try {
          sessionStorage.setItem(FLASH_KEY, signOutNotice(err));
        } catch {
          /* storage blocked: the redirect still happens, just without the notice */
        }
        window.dispatchEvent(new Event("modelward:unauthorized"));
      }
    }
    // A super admin without a (valid) organization selected: not a session problem. The
    // AuthContext clears the stale selection; the page decides what to show.
    if (err?.response?.status === 400 && err.response.data?.code === "ORG_REQUIRED") {
      window.dispatchEvent(new Event("modelward:org-required"));
    }
    return Promise.reject(err);
  }
);

// Centralize "what went wrong" extraction so every page doesn't reinvent it.
export function extractError(err) {
  if (!err) return "Something went wrong";
  const res = err.response;
  if (!res) {
    if (err.code === "ERR_CANCELED") return "Request cancelled";
    if (err.request || err.code === "ERR_NETWORK" || err.code === "ECONNABORTED") {
      return "Cannot reach the server. Check your connection and try again.";
    }
    return err.message || "Something went wrong";
  }
  const data = res.data;
  if (data && typeof data.error === "string" && data.error) return data.error;
  if (data?.fields && typeof data.fields === "object") {
    const msgs = Object.values(data.fields).filter((m) => typeof m === "string" && m);
    if (msgs.length) return msgs.join(" ");
  }
  if (res.status === 429) return "Too many requests. Please wait a moment and try again.";
  if (res.status === 413) return "That file is too large.";
  if (res.status >= 500) return "The server hit a problem. Please try again.";
  return err.message || "Something went wrong";
}

// Field-level messages from a 400 `{error, fields}` response ({} when there are none).
export function extractFields(err) {
  const f = err?.response?.data?.fields;
  return f && typeof f === "object" ? f : {};
}

export default api;
