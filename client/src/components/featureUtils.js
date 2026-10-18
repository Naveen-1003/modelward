// Small helpers shared by the version / model / audit UI (formatting, downloads, labels).
import { useCallback, useEffect, useRef, useState } from "react";
import api, { extractError } from "../api/axios.js";

export const LIVE_STATUSES = ["deployed", "needs_review"];
export const MAX_COMMENT = 2000;
export const MAX_NOTES = 5000;

export function fmt(value, digits = 3) {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function roleLabel(role) {
  return role ? String(role).replace(/_/g, " ") : "";
}

// Debounce a fast-changing value (search boxes).
export function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Page number that belongs to one filter set: when `key` (the serialised filters) changes the
// page falls back to 1 in the same render, so a filter change fires exactly one request.
export function useKeyedPage(key) {
  const [state, setState] = useState({ key, page: 1 });
  const page = state.key === key ? state.page : 1;
  const setPage = useCallback((p) => setState({ key, page: p }), [key]);
  return [page, setPage];
}

// True while the component is mounted; read `.current` after an await.
export function useMounted() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

// With responseType "blob" an error body arrives as a Blob, so unwrap `{error}` by hand.
export async function blobErrorMessage(err) {
  const data = err?.response?.data;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      if (parsed?.error) return parsed.error;
    } catch {
      /* fall through to the generic message */
    }
  }
  return extractError(err);
}

function filenameFromHeaders(headers) {
  const cd = headers?.["content-disposition"];
  if (!cd) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* ignore */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : null;
}

// Download through `api` (the endpoint needs the Authorization header), then save via an object URL.
export async function downloadBlob(url, { params, fileName, fallbackName = "download" } = {}) {
  const res = await api.get(url, { params, responseType: "blob" });
  const name = fileName || filenameFromHeaders(res.headers) || fallbackName;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return name;
}

export function extOf(name) {
  const m = /\.([^.]+)$/.exec(name || "");
  return m ? `.${m[1].toLowerCase()}` : "";
}

// Mirrors utils/auditActions.js on the server, with readable labels.
export const ACTION_LABELS = {
  signup: "Signed up",
  login: "Signed in",
  login_failed: "Failed sign-in",
  create_user: "User created",
  update_user: "User updated",
  update_settings: "Thresholds updated",
  create_model: "Model created",
  archive_model: "Model archived",
  restore_model: "Model restored",
  upload_version: "Version uploaded",
  retry_version: "Scoring retried",
  update_notes: "Notes edited",
  submit_version: "Submitted for review",
  withdraw_version: "Withdrawn to draft",
  approve: "Approved",
  reject: "Rejected",
  request_changes: "Requested changes",
  deploy: "Deployed",
  retire: "Retired",
  resolve_review: "Review resolved",
  archive_version: "Version archived",
  restore_version: "Version restored",
  download_file: "File downloaded",
  simulate_drift: "Drift snapshot",
  monitoring_batch: "Monitoring batch",
  drift_flagged: "Drift flagged",
  comment: "Comment added",
};

export const AUDIT_ACTIONS = Object.keys(ACTION_LABELS);

export function actionLabel(action) {
  return ACTION_LABELS[action] || String(action || "").replace(/_/g, " ");
}
