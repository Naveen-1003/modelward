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

const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Credentials being wrong on these two is a normal 401, not an expired session.
function isAuthAttempt(url = "") {
  const path = String(url).split("?")[0];
  return path === "/auth/login" || path === "/auth/signup";
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
          sessionStorage.setItem(FLASH_KEY, SESSION_EXPIRED);
        } catch {
          /* storage blocked: the redirect still happens, just without the notice */
        }
        window.dispatchEvent(new Event("modelward:unauthorized"));
      }
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
