import React, { useState } from "react";
import api, { extractError } from "../../api/axios.js";
import { useToast } from "../../context/ToastContext.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { fmtDate } from "../../components/featureUtils.js";
import { Icon, Loading, ErrorBox } from "../../components/ui.jsx";
import SetupLinkPanel, { CopyButton } from "./SetupLinkPanel.jsx";
import { MAX_DOMAINS, parseDomains, serverFields } from "./orgUtils.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_LABELS = [
  { kind: "ml_engineer", label: "ML Engineer code" },
  { kind: "compliance_officer", label: "Compliance Officer code" },
];

// Parsed domains shown live under the textarea: valid ones as chips, unusable ones in red.
function DomainPreview({ domains, invalid }) {
  if (!domains.length && !invalid.length) return null;
  return (
    <div className="chip-list span-all" aria-live="polite" aria-label="Parsed domains">
      {domains.map((d) => (
        <span className="chip" key={d}>{d}</span>
      ))}
      {invalid.map((d) => (
        <span className="chip chip-bad" key={`bad-${d}`} title="Not a valid domain">{d} (invalid)</span>
      ))}
    </div>
  );
}

// "New organization" (org = null) and "Edit organization" share one form.
function OrgForm({ org, onDone, onCancel }) {
  const editing = Boolean(org);
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    name: org ? org.name : "",
    address: org ? org.address || "" : "",
    adminEmail: "",
    adminName: "",
    domainsText: org ? (org.allowedDomains || []).join(", ") : "",
    rule: org ? org.domainRuleEnabled !== false : true,
  }));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const { domains, invalid } = parseDomains(form.domainsText);
  const idp = editing ? "eo" : "no";

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    // drop the error of the field being edited (the rule also affects the domain list's validity)
    const key = field === "domainsText" ? "allowedDomains" : field === "rule" ? "domainRuleEnabled" : field;
    setErrors((e) => ({ ...e, [key]: undefined, ...(field === "rule" ? { allowedDomains: undefined } : {}) }));
  }

  function validate() {
    const e = {};
    const name = form.name.trim();
    if (!name) e.name = "Enter the organization name.";
    else if (name.length > 120) e.name = "Name must be 120 characters or fewer.";
    if (form.address.trim().length > 300) e.address = "Address must be 300 characters or fewer.";
    if (!editing) {
      const email = form.adminEmail.trim();
      if (!EMAIL_RE.test(email)) e.adminEmail = "Enter a valid email address.";
      else if (email.length > 254) e.adminEmail = "Email must be 254 characters or fewer.";
      if (form.adminName.trim().length > 100) e.adminName = "Name must be 100 characters or fewer.";
    }
    if (invalid.length) e.allowedDomains = `Not a valid domain: ${invalid.join(", ")} (for example acme.com).`;
    else if (domains.length > MAX_DOMAINS) e.allowedDomains = `At most ${MAX_DOMAINS} domains.`;
    else if (form.rule && domains.length === 0) e.allowedDomains = "Add at least one allowed email domain, or turn the domain restriction off.";
    return e;
  }

  // Edit: only what changed is sent, so a rename never trips over an older domain list.
  const changes = {};
  if (editing) {
    if (form.name.trim() !== org.name) changes.name = form.name.trim();
    if (form.address.trim() !== (org.address || "")) changes.address = form.address.trim();
    if (domains.join(",") !== (org.allowedDomains || []).join(",")) changes.allowedDomains = domains;
    if (form.rule !== (org.domainRuleEnabled !== false)) changes.domainRuleEnabled = form.rule;
  }
  const dirty = !editing || Object.keys(changes).length > 0;

  async function submit(ev) {
    ev.preventDefault();
    setFormError("");
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      if (editing) {
        const { data } = await api.patch(`/orgs/${org.id}`, changes);
        toast.success(`${data.org?.name || "Organization"} updated.`);
        onDone(data);
      } else {
        const body = {
          name: form.name.trim(),
          address: form.address.trim(),
          adminEmail: form.adminEmail.trim(),
          allowedDomains: domains,
          domainRuleEnabled: form.rule,
        };
        if (form.adminName.trim()) body.adminName = form.adminName.trim();
        const { data } = await api.post("/orgs", body);
        toast.success(`Organization ${data.org?.name || ""} created.`);
        onDone(data);
      }
    } catch (err) {
      setErrors(serverFields(err));
      setFormError(extractError(err));
      setSaving(false);
    }
  }

  const aria = (name) => (errors[name] ? { "aria-invalid": true, "aria-describedby": `${idp}-${name}-err` } : {});
  const err = (name) => (errors[name] ? <small className="field-error" id={`${idp}-${name}-err`}>{errors[name]}</small> : null);

  return (
    <div className="panel form-panel" style={{ marginTop: 0, marginBottom: "1.25rem", maxWidth: "720px" }}>
      <h2>{editing ? `Edit ${org.name}` : "New organization"}</h2>
      <p className="muted small">
        {editing
          ? "Changes apply immediately. Existing accounts are not re-checked against a new domain list."
          : "Creates the organization with its two join codes and its first admin. The admin chooses their own password through a one-time setup link."}
      </p>
      <ErrorBox>{formError}</ErrorBox>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <label>
            Organization name
            <input autoComplete="off" maxLength={120} value={form.name} onChange={(e) => set("name", e.target.value)} {...aria("name")} />
            {err("name")}
          </label>
          <label>
            <span>Address <span className="hint">(optional)</span></span>
            <input autoComplete="off" maxLength={300} value={form.address} onChange={(e) => set("address", e.target.value)} {...aria("address")} />
            {err("address")}
          </label>
          {!editing && (
            <>
              <label>
                Admin email
                <input type="email" autoComplete="off" value={form.adminEmail} onChange={(e) => set("adminEmail", e.target.value)} {...aria("adminEmail")} />
                {err("adminEmail")}
              </label>
              <label>
                <span>Admin name <span className="hint">(optional)</span></span>
                <input autoComplete="off" maxLength={100} value={form.adminName} onChange={(e) => set("adminName", e.target.value)} {...aria("adminName")} />
                {err("adminName")}
              </label>
            </>
          )}
          <label className="span-all">
            <span>Allowed email domains{!form.rule && <span className="hint"> (optional while sign-ups are open to any address)</span>}</span>
            <textarea
              rows={2}
              autoComplete="off"
              spellCheck={false}
              placeholder="acme.com, acme.co.uk"
              value={form.domainsText}
              onChange={(e) => set("domainsText", e.target.value)}
              {...aria("allowedDomains")}
            />
            <small className="hint">Separate domains with commas, spaces or new lines. Only exact matches count: mail.acme.com is not acme.com.</small>
            {err("allowedDomains")}
          </label>
          <DomainPreview domains={domains} invalid={invalid} />
        </div>
        <label className="choice">
          <input type="checkbox" checked={form.rule} onChange={(e) => set("rule", e.target.checked)} {...aria("domainRuleEnabled")} />
          <span>
            Restrict sign-ups to these email domains
            <small>Recommended. Free email providers such as Gmail cannot be listed while this is on.</small>
          </span>
        </label>
        {err("domainRuleEnabled")}
        {!form.rule && (
          <p className="notice">
            Sign-ups from any email address are accepted, but each person still has to verify their email and be approved manually.
            Auto-approve is unavailable{editing ? " (it is switched off for this organization)" : ""}.
          </p>
        )}
        <div className="btn-row">
          <button type="submit" disabled={saving || !dirty} aria-busy={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create organization"}
          </button>
          <button type="button" className="secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function DomainCell({ org }) {
  if (org.domainRuleEnabled === false) return <span className="muted">Any domain</span>;
  if (!org.allowedDomains?.length) return <span className="muted">None</span>;
  return (
    <span className="chip-list">
      {org.allowedDomains.map((d) => (
        <span className="chip" key={d}>{d}</span>
      ))}
    </span>
  );
}

// Platform admin: every organization, create / edit / suspend, and "Open" to work inside one.
// The list itself lives in the dashboard (it also feeds the organization switcher).
export default function OrganizationsTab({ orgs, loading, error, onReload, onOpenOrg, activeOrgId }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [mode, setMode] = useState(null); // null | "new" | an organization being edited
  const [created, setCreated] = useState(null); // response of POST /orgs
  const [busyId, setBusyId] = useState(null);

  async function toggleStatus(org) {
    const suspending = org.status !== "suspended";
    const ok = await confirm({
      title: suspending ? `Suspend ${org.name}?` : `Activate ${org.name}?`,
      message: suspending
        ? "All of this organization's users are signed out at once and cannot sign in until it is activated again. Nothing is deleted."
        : "Its users can sign in again.",
      confirmLabel: suspending ? "Suspend" : "Activate",
      danger: suspending,
    });
    if (!ok) return;
    setBusyId(org.id);
    try {
      await api.patch(`/orgs/${org.id}`, { status: suspending ? "suspended" : "active" });
      toast.success(`${org.name} ${suspending ? "suspended" : "activated"}.`);
      onReload();
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setBusyId(null);
    }
  }

  function formDone(data) {
    onReload();
    if (mode === "new") setCreated(data);
    setMode(null);
  }

  const list = orgs || [];

  return (
    <>
      <div className="toolbar">
        <span className="muted" aria-live="polite">
          {orgs ? `${list.length} organization${list.length === 1 ? "" : "s"}` : ""}
        </span>
        {mode === null && (
          <button type="button" style={{ marginLeft: "auto" }} onClick={() => { setCreated(null); setMode("new"); }}>
            <Icon name="plus" /> New organization
          </button>
        )}
      </div>

      {mode !== null && (
        <OrgForm
          key={mode === "new" ? "new" : mode.id}
          org={mode === "new" ? null : mode}
          onDone={formDone}
          onCancel={() => setMode(null)}
        />
      )}

      {created && (
        <SetupLinkPanel
          title={`${created.org?.name || "Organization"} created`}
          email={created.admin?.email}
          link={created.setupLink || null}
          emailSent={Boolean(created.emailSent)}
          onDismiss={() => setCreated(null)}
        >
          <div className="link-field">
            <h3>Join codes</h3>
            <p className="muted small">Give these to the organization&apos;s admin or to the people who should sign up. The code decides the role.</p>
            {CODE_LABELS.map(({ kind, label }) => {
              const value = created.org?.codes?.[kind]?.value;
              if (!value) return null;
              return (
                <div className="code-line" key={kind}>
                  <span className="code-label">{label}</span>
                  <code className="code-value">{value}</code>
                  <CopyButton text={value} what={label} ariaLabel={`Copy the ${label}`} />
                </div>
              );
            })}
          </div>
        </SetupLinkPanel>
      )}

      {error && (
        <>
          <ErrorBox>{error}</ErrorBox>
          <div className="btn-row" style={{ marginBottom: "1rem" }}>
            <button type="button" className="secondary" onClick={onReload}>Try again</button>
          </div>
        </>
      )}
      {!orgs && !error ? (
        <Loading />
      ) : list.length === 0 ? (
        !error && <div className="empty-state">No organizations yet. Create the first one to get started.</div>
      ) : (
        <div className="table-wrap" aria-busy={loading}>
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Contact</th>
                <th>Email domains</th>
                <th className="num">Users</th>
                <th className="num">Models</th>
                <th>Status</th>
                <th>Created</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((o) => {
                const busy = busyId === o.id;
                const suspended = o.status === "suspended";
                return (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.name}</strong>
                      {activeOrgId === o.id && <span className="muted"> (selected)</span>}
                      {o.address && <span className="sub" style={{ textTransform: "none" }}>{o.address}</span>}
                    </td>
                    <td className="muted" style={{ overflowWrap: "anywhere" }}>{o.contactEmail || "—"}</td>
                    <td><DomainCell org={o} /></td>
                    <td className="num mono">{o.counts?.users ?? 0}</td>
                    <td className="num mono">{o.counts?.models ?? 0}</td>
                    <td>
                      {suspended ? <span className="badge badge-status-rejected">Suspended</span> : <span className="badge badge-status-approved">Active</span>}
                    </td>
                    <td className="mono muted nowrap">{fmtDate(o.createdAt)}</td>
                    <td className="num">
                      <div className="cell-actions" style={{ justifyContent: "flex-end" }}>
                        <button type="button" onClick={() => onOpenOrg({ id: o.id, name: o.name })} disabled={busy}>
                          Open
                        </button>
                        <button type="button" className="secondary" onClick={() => { setCreated(null); setMode(o); }} disabled={busy}>
                          Edit
                        </button>
                        <button type="button" className={suspended ? "secondary" : "danger"} onClick={() => toggleStatus(o)} disabled={busy} aria-busy={busy}>
                          {suspended ? "Activate" : "Suspend"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
