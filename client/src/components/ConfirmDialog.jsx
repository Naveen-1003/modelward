import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ConfirmContext = createContext(null);

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function Dialog({ opts, onClose }) {
  const {
    title,
    message,
    confirmLabel = "Confirm",
    danger = false,
    requireReason = false,
    reasonLabel = "Reason",
    maxLength = 2000,
  } = opts;
  const [reason, setReason] = useState("");
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const reasonRef = useRef(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const bodyId = `${uid}-body`;

  const canConfirm = !requireReason || reason.trim().length > 0;
  const accept = useCallback(() => {
    if (requireReason) {
      const text = reason.trim();
      if (text) onClose(text);
    } else {
      onClose(true);
    }
  }, [requireReason, reason, onClose]);

  // Focus: the reason box when one is needed, Cancel for destructive actions (so a
  // stray Enter doesn't destroy anything), otherwise Confirm. The app root is made
  // inert while open (feature-checked; aria-hidden as the fallback) and everything is
  // restored, with focus returned to the opener, on close/unmount.
  useEffect(() => {
    const previous = document.activeElement;
    const root = document.getElementById("root");
    const canInert = typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype;
    const hadInert = root ? root.hasAttribute("inert") : false;
    const hadHidden = root ? root.getAttribute("aria-hidden") : null;
    if (root) {
      if (canInert) root.setAttribute("inert", "");
      else root.setAttribute("aria-hidden", "true");
    }
    const target = requireReason ? reasonRef.current : danger ? cancelRef.current : confirmRef.current;
    (target || dialogRef.current)?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Handled on document so the trap holds even if focus ever lands outside the dialog.
    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose(false);
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const nodes = dialog.querySelectorAll(FOCUSABLE);
      if (nodes.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || active === dialog) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = overflow;
      if (root) {
        if (!hadInert) root.removeAttribute("inert");
        if (hadHidden === null) root.removeAttribute("aria-hidden");
        else root.setAttribute("aria-hidden", hadHidden);
      }
      if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(false);
      }}
    >
      <div
        ref={dialogRef}
        className={`modal${danger ? " modal-danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? bodyId : undefined}
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {message && <p id={bodyId} className="muted modal-body">{message}</p>}
        {requireReason && (
          <label className="modal-reason">
            {reasonLabel}
            <textarea
              ref={reasonRef}
              rows={3}
              maxLength={maxLength}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-required="true"
            />
          </label>
        )}
        <div className="btn-row modal-actions">
          <button type="button" ref={cancelRef} className="secondary" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? "danger" : undefined}
            disabled={!canConfirm}
            onClick={accept}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmProvider({ children }) {
  const [pending, setPending] = useState(null); // { opts, resolve }
  const pendingRef = useRef(null);
  const seq = useRef(0);

  const settle = useCallback((value) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(value);
  }, []);

  const confirm = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      // a second request while one is open cancels the first
      pendingRef.current?.resolve(false);
      const next = { opts, resolve, id: ++seq.current };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  useEffect(() => () => pendingRef.current?.resolve(false), []);

  // useConfirm() returns the function itself; `.confirm` points back at it so
  // `const { confirm } = useConfirm()` works too.
  const value = useMemo(() => {
    const fn = (opts) => confirm(opts);
    fn.confirm = fn;
    return fn;
  }, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && createPortal(<Dialog key={pending.id} opts={pending.opts} onClose={settle} />, document.body)}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}
