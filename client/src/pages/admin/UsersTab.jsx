import React, { useCallback, useEffect, useState } from "react";
import api, { extractError, extractFields } from "../../api/axios.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { useConfig } from "../../context/ConfigContext.jsx";
import { useToast } from "../../context/ToastContext.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import Pagination from "../../components/Pagination.jsx";
import { Icon, Loading, ErrorBox } from "../../components/ui.jsx";
import { formatDate, roleLabel } from "./format.js";

const ROLES = ["ml_engineer", "compliance_officer", "admin"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY_FORM = { name: "", email: "", password: "", role: "ml_engineer" };

function CreateUserForm({ onCreated, onCancel }) {
  const toast = useToast();
  const { config } = useConfig();
  const minLen = config.minPasswordLength || 8;
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function validate() {
    const e = {};
    if (!form.name.trim()) e.name = "Enter a name.";
    else if (form.name.trim().length > 100) e.name = "Name must be 100 characters or fewer.";
    if (!EMAIL_RE.test(form.email.trim())) e.email = "Enter a valid email address.";
    if (form.password.length < minLen) e.password = `Password must be at least ${minLen} characters.`;
    else if (form.password.length > 128) e.password = "Password must be 128 characters or fewer.";
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
        password: form.password,
        role: form.role,
      });
      toast.success(`Created ${data.user?.name || "user"}.`);
      onCreated();
    } catch (err) {
      setErrors(extractFields(err));
      setFormError(extractError(err));
      setSaving(false);
    }
  }

  const aria = (name) => (errors[name] ? { "aria-invalid": true, "aria-describedby": `cu-${name}-err` } : {});
  const err = (name) => (errors[name] ? <small className="field-error" id={`cu-${name}-err`}>{errors[name]}</small> : null);

  return (
    <div className="panel form-panel" style={{ marginTop: 0, marginBottom: "1.25rem" }}>
      <h2>Add a user</h2>
      <p className="muted small">Creates an active account straight away. Share the password securely.</p>
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
            Temporary password
            <input type="password" autoComplete="new-password" maxLength={128} value={form.password} onChange={(e) => set("password", e.target.value)} {...aria("password")} />
            <small className="hint">At least {minLen} characters</small>
            {err("password")}
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

  async function changeRole(u, newRole) {
    if (newRole === u.role) return;
    const ok = await confirm({
      title: "Change role?",
      message: `${u.name} will become ${roleLabel(newRole)} and see that role's pages on their next request.`,
      confirmLabel: "Change role",
    });
    if (ok) patchUser(u, { role: newRole }, `${u.name} is now ${roleLabel(newRole)}.`);
  }

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
          <button type="button" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add user
          </button>
        )}
      </div>

      {adding && (
        <CreateUserForm
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            setPage(1);
            setReloadKey((k) => k + 1);
          }}
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
                  const lockTip = isSelf ? "You can't change your own role or deactivate yourself" : undefined;
                  return (
                    <tr key={u.id}>
                      <td>
                        {u.name}{isSelf && <span className="muted"> (you)</span>}
                        <span className="sub" style={{ textTransform: "none" }}>{u.email}</span>
                      </td>
                      <td>
                        <div className="cell-actions" title={lockTip}>
                          <select
                            value={u.role}
                            onChange={(e) => changeRole(u, e.target.value)}
                            disabled={isSelf || busy}
                            aria-label={`Role for ${u.name}`}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>{roleLabel(r)}</option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td>{active ? <span className="badge badge-status-approved">Active</span> : <span className="badge badge-muted">Inactive</span>}</td>
                      <td className="mono muted nowrap">{formatDate(u.createdAt)}</td>
                      <td className="num">
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
