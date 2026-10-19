import React, { useCallback, useEffect, useState } from "react";
import api, { extractError } from "../../api/axios.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { useToast } from "../../context/ToastContext.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import Pagination from "../../components/Pagination.jsx";
import { Icon, Loading, ErrorBox } from "../../components/ui.jsx";
import SetupLinkPanel from "./SetupLinkPanel.jsx";
import { formatDate, roleLabel } from "./format.js";
import { errorCode, serverFields } from "./orgUtils.js";

const ROLES = ["ml_engineer", "compliance_officer", "admin"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY_FORM = { name: "", email: "", role: "ml_engineer", allowExternalEmail: false };

function CreateUserForm({ onCreated, onCancel }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  // The server said the email's domain is not allowed: draw attention to the override checkbox.
  const [domainBlocked, setDomainBlocked] = useState(false);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
    if (field === "email") setDomainBlocked(false);
  }

  function validate() {
    const e = {};
    if (!form.name.trim()) e.name = "Enter a name.";
    else if (form.name.trim().length > 100) e.name = "Name must be 100 characters or fewer.";
    const email = form.email.trim();
    if (!EMAIL_RE.test(email)) e.email = "Enter a valid email address.";
    else if (email.length > 254) e.email = "Email must be 254 characters or fewer.";
    if (!ROLES.includes(form.role)) e.role = "Choose a role.";
    return e;
  }

  async function submit(ev) {
    ev.preventDefault();
    setFormError("");
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const { data } = await api.post("/users", {
        name: form.name.trim(),
        email: form.email.trim(),
        role: form.role,
        allowExternalEmail: form.allowExternalEmail,
      });
      onCreated(data);
    } catch (err) {
      setErrors(serverFields(err));
      setDomainBlocked(errorCode(err) === "EMAIL_DOMAIN_NOT_ALLOWED");
      setFormError(extractError(err));
      setSaving(false);
    }
  }

  const aria = (name) => (errors[name] ? { "aria-invalid": true, "aria-describedby": `cu-${name}-err` } : {});
  const err = (name) => (errors[name] ? <small className="field-error" id={`cu-${name}-err`}>{errors[name]}</small> : null);

  return (
    <div className="panel form-panel" style={{ marginTop: 0, marginBottom: "1.25rem" }}>
      <h2>Add a user</h2>
      <p className="muted small">
        No password is typed here. The person receives a one-time setup link (valid 72 hours) and chooses their own password. They can sign in once they have done so.
      </p>
      <ErrorBox>{formError}</ErrorBox>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <label>
            Full name
            <input autoComplete="off" maxLength={100} value={form.name} onChange={(e) => set("name", e.target.value)} {...aria("name")} />
            {err("name")}
          </label>
          <label>
            Email
            <input type="email" autoComplete="off" value={form.email} onChange={(e) => set("email", e.target.value)} {...aria("email")} />
            {err("email")}
          </label>
          <label>
            Role
            <select value={form.role} onChange={(e) => set("role", e.target.value)} {...aria("role")}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
            {err("role")}
          </label>
        </div>
        <label className={`choice${domainBlocked && !form.allowExternalEmail ? " attn" : ""}`}>
          <input
            type="checkbox"
            checked={form.allowExternalEmail}
            onChange={(e) => set("allowExternalEmail", e.target.checked)}
          />
          <span>
            Allow an email outside the organization&apos;s domains
            <small>For contractors and other people without a company address. This choice is recorded in the audit log.</small>
          </span>
        </label>
        <div className="btn-row">
          <button type="submit" disabled={saving} aria-busy={saving}>{saving ? "Creating…" : "Create user"}</button>
          <button type="button" className="secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

export default function UsersTab() {
  const { user: me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [adding, setAdding] = useState(false);
  // One-time setup link result: { title, email, link, emailSent } (after Add user / Resend setup link).
  const [linkInfo, setLinkInfo] = useState(null);

  // debounce the search box so we don't fire a request per keystroke
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = { page, limit: 25 };
    if (q) params.q = q;
    if (role) params.role = role;
    api
      .get("/users", { params })
      .then(({ data: d }) => {
        if (cancelled) return;
        setData(d);
        setError("");
      })
      .catch((err) => {
        if (!cancelled) setError(extractError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q, role, page, reloadKey]);

  const patchUser = useCallback(
    async (u, body, okMessage) => {
      setBusyId(u.id);
      try {
        const { data: res } = await api.patch(`/users/${u.id}`, body);
        setData((d) => (d ? { ...d, users: d.users.map((x) => (x.id === u.id ? res.user : x)) } : d));
        toast.success(okMessage);
      } catch (err) {
        toast.error(extractError(err));
      } finally {
        setBusyId(null);
      }
    },
    [toast]
  );

  async function toggleActive(u) {
    const deactivating = u.isActive !== false;
    const ok = await confirm({
      title: deactivating ? "Deactivate user?" : "Activate user?",
      message: deactivating
        ? `${u.name} will be signed out and unable to log in. Their history stays in the audit log.`
        : `${u.name} will be able to log in again.`,
      confirmLabel: deactivating ? "Deactivate" : "Activate",
      danger: deactivating,
    });
    if (ok) patchUser(u, { isActive: !deactivating }, `${u.name} ${deactivating ? "deactivated" : "activated"}.`);
  }

  async function resendLink(u) {
    setBusyId(u.id);
    try {
      const { data: res } = await api.post(`/users/${u.id}/setup-link`);
      if (res.setupLink) {
        setLinkInfo({ title: "New setup link", email: u.email, link: res.setupLink, emailSent: false });
      } else if (res.emailSent) {
        toast.success(`A new setup email was sent to ${u.email}.`);
      } else {
        toast.info("A new setup link was created but could not be delivered. Try again.");
      }
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setBusyId(null);
    }
  }

  function onCreated(res) {
    setAdding(false);
    setPage(1);
    setReloadKey((k) => k + 1);
    toast.success(`Created ${res.user?.name || "user"}.`);
    setLinkInfo({
      title: "User created",
      email: res.user?.email || "",
      link: res.setupLink || null,
      emailSent: Boolean(res.emailSent),
    });
  }

  const users = data?.users || [];

  return (
    <>
      <div className="toolbar">
        <label>
          <span className="sr-only">Search users</span>
          <input
            type="search"
            placeholder="Search by name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search users"
          />
        </label>
        <label className="narrow">
          <span className="sr-only">Filter by role</span>
          <select value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }} aria-label="Filter by role">
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>{roleLabel(r)}</option>
            ))}
          </select>
        </label>
        {!adding && (
          <button type="button" onClick={() => { setLinkInfo(null); setAdding(true); }}>
            <Icon name="plus" /> Add user
          </button>
        )}
      </div>

      {adding && (
        <CreateUserForm onCancel={() => setAdding(false)} onCreated={onCreated} />
      )}

      {linkInfo && (
        <SetupLinkPanel
          title={linkInfo.title}
          email={linkInfo.email}
          link={linkInfo.link}
          emailSent={linkInfo.emailSent}
          onDismiss={() => setLinkInfo(null)}
        />
      )}

      <ErrorBox>{error}</ErrorBox>
      {loading && !data ? (
        <Loading />
      ) : users.length === 0 && !error ? (
        <div className="empty-state">{q || role ? "No users match those filters." : "No users yet."}</div>
      ) : (
        users.length > 0 && (
          <div className="table-wrap" aria-busy={loading}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = me && u.id === me.id;
                  const busy = busyId === u.id;
                  const active = u.isActive !== false;
                  const invited = u.status === "invited";
                  const lockTip = isSelf ? "You can't deactivate yourself" : undefined;
                  return (
                    <tr key={u.id}>
                      <td>
                        {u.name}{isSelf && <span className="muted"> (you)</span>}
                        <span className="sub" style={{ textTransform: "none" }}>{u.email}</span>
                      </td>
                      <td>{roleLabel(u.role)}</td>
                      <td>
                        {!active ? (
                          <span className="badge badge-muted">Inactive</span>
                        ) : invited ? (
                          <span className="badge badge-status-submitted" title="Has not set a password yet">Invited</span>
                        ) : (
                          <span className="badge badge-status-approved">Active</span>
                        )}
                      </td>
                      <td className="mono muted nowrap">{formatDate(u.createdAt)}</td>
                      <td className="num">
                        <div className="cell-actions" style={{ justifyContent: "flex-end" }}>
                          {invited && (
                            <button type="button" className="secondary" onClick={() => resendLink(u)} disabled={busy} aria-busy={busy}>
                              Resend setup link
                            </button>
                          )}
                          <span title={lockTip}>
                            <button
                              type="button"
                              className={active ? "danger" : "secondary"}
                              onClick={() => toggleActive(u)}
                              disabled={isSelf || busy}
                              aria-busy={busy}
                            >
                              {active ? "Deactivate" : "Activate"}
                            </button>
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
      {data && <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={setPage} />}
    </>
  );
}
