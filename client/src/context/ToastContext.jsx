import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/ui.jsx";

const ToastContext = createContext(null);

const MAX_TOASTS = 4;
const DURATION = { success: 4000, info: 4000, error: 7000 };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind, message) => {
      if (!message) return;
      const id = nextId.current++;
      setToasts((list) => {
        const next = [...list, { id, kind, message: String(message) }];
        // drop the oldest beyond the cap so a burst can't cover the screen
        const dropped = next.slice(0, Math.max(0, next.length - MAX_TOASTS));
        dropped.forEach((t) => {
          clearTimeout(timers.current.get(t.id));
          timers.current.delete(t.id);
        });
        return next.slice(-MAX_TOASTS);
      });
      timers.current.set(id, setTimeout(() => dismiss(id), DURATION[kind]));
    },
    [dismiss]
  );

  useEffect(() => {
    const live = timers.current;
    return () => live.forEach((t) => clearTimeout(t));
  }, []);

  const api = useMemo(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
    }),
    [push]
  );

  const renderToast = (t) => (
    <div key={t.id} className={`toast toast-${t.kind}`}>
      <span className="toast-msg">{t.message}</span>
      <button type="button" className="icon-btn toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
        <Icon name="close" size={14} />
      </button>
    </div>
  );

  // The two live regions always exist (screen readers only announce changes inside a
  // region that was already in the DOM). The stack is portalled to <body> so it stays
  // outside the app root, which is made inert while a confirm dialog is open.
  const stack = (
    <div className="toast-stack">
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.filter((t) => t.kind !== "error").map(renderToast)}
      </div>
      <div className="toast-region" role="alert" aria-live="assertive">
        {toasts.filter((t) => t.kind === "error").map(renderToast)}
      </div>
    </div>
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(stack, document.body)}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
