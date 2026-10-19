import React, { useEffect, useRef, useState } from "react";
import { useToast } from "../../context/ToastContext.jsx";
import { Icon } from "../../components/ui.jsx";

// Copy text to the clipboard. Uses the async Clipboard API when it exists; otherwise (older
// browsers, plain http) falls back to a temporary readonly textarea + execCommand("copy").
// Resolves to true when the text was copied.
export async function copyText(text) {
  const value = String(text ?? "");
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* permission denied or insecure context: try the fallback */
  }
  const previous = document.activeElement;
  let ta = null;
  try {
    ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    if (ta) ta.remove();
    if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
  }
}

// "Copy" button that flips to "Copied" for two seconds (also announced to screen readers).
export function CopyButton({ text, label = "Copy", what = "text", ariaLabel, className = "secondary" }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    const ok = await copyText(text);
    if (!alive.current) return;
    if (!ok) {
      toast.error(`Could not copy the ${what} automatically. Select it and copy it by hand.`);
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (alive.current) setCopied(false);
    }, 2000);
  }

  return (
    <>
      <button type="button" className={className} onClick={copy} aria-label={ariaLabel}>
        <Icon name={copied ? "check" : "file"} /> {copied ? "Copied" : label}
      </button>
      <span className="sr-only" role="status">{copied ? `The ${what} was copied to the clipboard` : ""}</span>
    </>
  );
}

// Read-only one-time link with a Copy button and the standard warning.
export function SetupLinkField({ link, email }) {
  return (
    <div className="link-field">
      <p>
        Share this one-time link with {email ? <strong>{email}</strong> : "the person"}. They use it to choose their own password.
      </p>
      <div className="copy-row">
        <input readOnly value={link} aria-label="One-time setup link" onFocus={(e) => e.target.select()} />
        <CopyButton text={link} label="Copy link" what="setup link" />
      </div>
      <p className="muted small">Valid for 72 hours — share it securely. Anyone who has the link can set the password for this account.</p>
    </div>
  );
}

// Result panel shown after creating a user / resending a link. `link` is only present when the
// email could not be delivered (or the provider is the console one); `emailSent` says it was.
export default function SetupLinkPanel({ title = "Setup link", email, link, emailSent, onDismiss, dismissLabel = "Done", children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && typeof ref.current.scrollIntoView === "function") ref.current.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <section ref={ref} className="panel result-panel" aria-label={title}>
      <h2>{title}</h2>
      {emailSent && (
        <p>
          A setup email was sent to <strong>{email}</strong>. The link in it is valid for 72 hours.
        </p>
      )}
      {link && <SetupLinkField link={link} email={email} />}
      {children}
      {onDismiss && (
        <div className="btn-row">
          <button type="button" onClick={onDismiss}>{dismissLabel}</button>
        </div>
      )}
    </section>
  );
}
