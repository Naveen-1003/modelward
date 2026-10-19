import React, { useEffect, useState } from "react";
import api, { extractError } from "../../api/axios.js";
import { useToast } from "../../context/ToastContext.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { useMounted, fmtDate } from "../../components/featureUtils.js";
import { Icon, Loading, ErrorBox } from "../../components/ui.jsx";
import { CopyButton } from "./SetupLinkPanel.jsx";
import { serverFields } from "./orgUtils.js";

const KINDS = [
  { kind: "ml_engineer", label: "ML Engineer", blurb: "People who sign up with this code can register models and upload versions." },
  { kind: "compliance_officer", label: "Compliance Officer", blurb: "People who sign up with this code can review and approve versions." },
];
const MAX_SEATS = 100000;

const pad = (n) => String(n).padStart(2, "0");
// ISO instant -> value of <input type="date"> in the viewer's time zone ("" for none).
function toDateInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const endOfDay = (value) => {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
};
const todayInput = () => toDateInput(new Date().toISOString());

// One join code: the code itself, seats, and the two optional limits (expiry, seat limit).
function CodeCard({ kind, label, blurb, code, onUpdated }) {
  const toast = useToast();
  const confirm = useConfirm();
  const mounted = useMounted();
  const [expiry, setExpiry] = useState(() => toDateInput(code.expiresAt));
  const [limit, setLimit] = useState(() => (code.seatLimit == null ? "" : String(code.seatLimit)));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const expired = code.expiresAt && new Date(code.expiresAt).getTime() <= Date.now();
  const full = code.seatLimit != null && code.used >= code.seatLimit;
  const expiryDirty = expiry !== toDateInput(code.expiresAt);
  const limitDirty = limit.trim() !== (code.seatLimit == null ? "" : String(code.seatLimit));
  const dirty = expiryDirty || limitDirty;
  const busy = saving || regenerating;

  async function save(ev) {
    ev.preventDefault();
    setFormError("");
    const found = {};
    const body = {};
    if (expiryDirty) {
      if (expiry && endOfDay(expiry).getTime() <= Date.now()) found.expiresAt = "Choose a date in the future.";
      else body.expiresAt = expiry ? endOfDay(expiry).toISOString() : null;
    }
    if (limitDirty) {
      const raw = limit.trim();
      if (!raw) body.seatLimit = null;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) found.seatLimit = "Enter a whole number of at least 1, or clear the field for no limit.";
        else if (n > MAX_SEATS) found.seatLimit = `Must be at most ${MAX_SEATS}.`;
        else if (n < code.used) found.seatLimit = `Cannot be below the ${code.used} seat${code.used === 1 ? "" : "s"} already in use.`;
        else body.seatLimit = n;
      }
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/orgs/current/codes/${kind}`, body);
      toast.success(`${label} code updated.`);
      onUpdated(data.org); // the card is re-keyed by its values, so the form resets itself
    } catch (err) {
      if (mounted.current) {
        setErrors(serverFields(err));
        setFormError(extractError(err));
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function regenerate() {
    const ok = await confirm({
      title: `Regenerate the ${label} code?`,
      message: "The current code stops working immediately. Seats used and limits reset.",
      confirmLabel: "Regenerate",
      danger: true,
    });
    if (!ok) return;
    setRegenerating(true);
    try {
      const { data } = await api.post(`/orgs/current/codes/${kind}/regenerate`);
      toast.success(`A new ${label} code was generated.`);
      onUpdated(data.org);
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      if (mounted.current) setRegenerating(false);
    }
  }

  const aria = (name) => (errors[name] ? { "aria-invalid": true, "aria-describedby": `code-${kind}-${name}-err` } : {});
  const err = (name) => (errors[name] ? <small className="field-error" id={`code-${kind}-${name}-err`}>{errors[name]}</small> : null);

  return (
    <article className="panel code-card" aria-label={`${label} join code`}>
      <div className="panel-head" style={{ marginBottom: "0.75rem" }}>
        <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
          <h3>{label}</h3>
          <p className="muted small">{blurb}</p>
        </div>
        {(expired || full) && (
          <div className="badge-row">
            {expired && <span className="badge badge-status-rejected">Expired</span>}
            {full && <span className="badge badge-status-submitted">Full</span>}
          </div>
        )}
      </div>

      <div className="code-line">
        <code className="code-value" aria-label={`${label} join code`}>{code.value}</code>
        <CopyButton text={code.value} what={`${label} code`} ariaLabel={`Copy the ${label} code`} />
      </div>

      <dl className="code-meta">
        <div>
          <dt>Seats used</dt>
          <dd className="mono">{code.used}{code.seatLimit != null ? ` of ${code.seatLimit}` : ""}</dd>
          {code.seatLimit == null && <dd className="muted small">No seat limit</dd>}
        </div>
        <div>
          <dt>Expires</dt>
          <dd className="mono">{code.expiresAt ? fmtDate(code.expiresAt) : "No expiry"}</dd>
        </div>
      </dl>

      <ErrorBox>{formError}</ErrorBox>
      <form onSubmit={save} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor={`code-${kind}-expiry`}>Expiry date</label>
            <div className="input-clear">
              <input
                id={`code-${kind}-expiry`}
                type="date"
                min={todayInput()}
                value={expiry}
                onChange={(e) => {
                  setExpiry(e.target.value);
                  if (errors.expiresAt) setErrors((x) => ({ ...x, expiresAt: undefined }));
                }}
                {...aria("expiresAt")}
              />
              {expiry && (
                <button type="button" className="secondary" onClick={() => setExpiry("")} disabled={busy} aria-label={`Clear the ${label} expiry date`}>
                  Clear
                </button>
              )}
            </div>
            <small className="hint">The code works until the end of this day. Empty means it never expires.</small>
            {err("expiresAt")}
          </div>
          <div className="field">
            <label htmlFor={`code-${kind}-limit`}>Seat limit</label>
            <div className="input-clear">
              <input
                id={`code-${kind}-limit`}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_SEATS}
                step={1}
                value={limit}
                onChange={(e) => {
                  setLimit(e.target.value);
                  if (errors.seatLimit) setErrors((x) => ({ ...x, seatLimit: undefined }));
                }}
                {...aria("seatLimit")}
              />
              {limit && (
                <button type="button" className="secondary" onClick={() => setLimit("")} disabled={busy} aria-label={`Clear the ${label} seat limit`}>
                  Clear
                </button>
              )}
            </div>
            <small className="hint">Most accounts that may join with this code. Empty means no limit.</small>
            {err("seatLimit")}
          </div>
        </div>
        <div className="btn-row">
          <button type="submit" disabled={busy || !dirty} aria-busy={saving}>{saving ? "Saving…" : "Save"}</button>
          <button type="button" className="danger" onClick={regenerate} disabled={busy} aria-busy={regenerating}>
            <Icon name="refresh" /> {regenerating ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
      </form>
    </article>
  );
}

function DomainChips({ org }) {
  if (org.domainRuleEnabled === false) return <span>Any domain (verification + manual approval required)</span>;
  if (!org.allowedDomains?.length) return <span className="muted">None</span>;
  return (
    <span className="chip-list">
      {org.allowedDomains.map((d) => (
        <span className="chip" key={d}>{d}</span>
      ))}
    </span>
  );
}

// The organization's own settings for its admin (and for a platform admin who selected it):
// facts, the two join codes with their limits, and the approval mode.
export default function OrgSettingsTab() {
  const toast = useToast();
  const mounted = useMounted();
  const [org, setOrg] = useState(null);
  const [error, setError] = useState("");
  const [savingApprove, setSavingApprove] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/orgs/current")
      .then(({ data }) => {
        if (!cancelled) setOrg(data.org);
      })
      .catch((err) => {
        if (!cancelled) setError(extractError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!org) return error ? <ErrorBox>{error}</ErrorBox> : <Loading />;

  const ruleOn = org.domainRuleEnabled !== false;

  async function setAutoApprove(value) {
    setSavingApprove(true);
    try {
      const { data } = await api.patch("/orgs/current", { autoApprove: value });
      setOrg(data.org);
      toast.success(value ? "Verified sign-ups from allowed domains are now approved automatically." : "New sign-ups now wait for your approval.");
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      if (mounted.current) setSavingApprove(false);
    }
  }

  return (
    <>
      <section aria-label="Organization">
        <div className="section-head"><h2>Organization</h2></div>
        <div className="panel">
          <dl className="org-facts">
            <div>
              <dt>Name</dt>
              <dd>{org.name}</dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd>{org.address || <span className="muted">Not set</span>}</dd>
            </div>
            <div>
              <dt>Allowed email domains</dt>
              <dd><DomainChips org={org} /></dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                {org.status === "suspended" ? (
                  <span className="badge badge-status-rejected">Suspended</span>
                ) : (
                  <span className="badge badge-status-approved">Active</span>
                )}
              </dd>
            </div>
          </dl>
          <p className="muted small" style={{ marginTop: "0.9rem" }}>
            The name, address and allowed domains are managed by the platform administrator.
          </p>
        </div>
      </section>

      <section className="section" aria-label="Join codes">
        <div className="section-head">
          <h2>Join codes</h2>
          <span className="muted">The code a person signs up with decides their role</span>
        </div>
        <p className="note">
          Share a code only with the people it is meant for. Anyone who signs up with it still has to verify their email{ruleOn ? " (on an allowed domain)" : ""} and be approved.
        </p>
        <div className="code-grid">
          {KINDS.map((k) => {
            const code = org.codes?.[k.kind];
            if (!code) return null;
            return (
              <CodeCard
                key={`${k.kind}:${code.value}:${code.expiresAt || ""}:${code.seatLimit ?? ""}`}
                kind={k.kind}
                label={k.label}
                blurb={k.blurb}
                code={code}
                onUpdated={setOrg}
              />
            );
          })}
        </div>
      </section>

      <section className="section" aria-label="Approvals">
        <div className="section-head"><h2>Approvals</h2></div>
        <div className="panel">
          <label className="choice">
            <input
              type="checkbox"
              checked={Boolean(org.autoApprove) && ruleOn}
              disabled={!ruleOn || savingApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              aria-describedby="auto-approve-help"
            />
            <span>
              Auto-approve verified sign-ups from allowed domains
              <small id="auto-approve-help">
                {ruleOn
                  ? "A person who confirms an email address on one of the allowed domains gets access immediately. Everyone else waits for your approval on the Pending tab."
                  : "Not available: this organization accepts sign-ups from any email address, so every sign-up needs email verification and your manual approval. The platform administrator can turn the domain rule back on."}
              </small>
            </span>
          </label>
        </div>
      </section>
    </>
  );
}
