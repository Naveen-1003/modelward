import React, { useCallback, useEffect, useState } from "react";
import api, { extractError } from "../../api/axios.js";
import { useToast } from "../../context/ToastContext.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { useMounted } from "../../components/featureUtils.js";
import { Icon, Loading, ErrorBox } from "../../components/ui.jsx";
import { formatDate, roleLabel } from "./format.js";

// The server returns at most this many rows.
const PENDING_CAP = 500;

// Verified sign-ups waiting for an admin's decision. `onChanged` tells the dashboard to refresh
// the count badge on the tab.
export default function PendingTab({ onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const mounted = useMounted();
  const [data, setData] = useState(null); // { users, total }
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get("/users/pending");
      if (!mounted.current) return;
      setData({ users: Array.isArray(d.users) ? d.users : [], total: d.total ?? 0 });
      setError("");
    } catch (err) {
      if (mounted.current) setError(extractError(err));
    }
  }, [mounted]);

  useEffect(() => {
    load();
  }, [load]);

  const changed = () => {
    if (typeof onChanged === "function") onChanged();
  };

  async function approve(u) {
    setBusyId(u.id);
    try {
      await api.post(`/users/${u.id}/approve`);
      toast.success(`${u.name} was approved and can sign in now.`);
    } catch (err) {
      // 409 = somebody else already decided; the refresh below shows the real state
      toast.error(extractError(err));
    }
    await load();
    changed();
    if (mounted.current) setBusyId(null);
  }

  async function reject(u) {
    const ok = await confirm({
      title: "Reject this sign-up?",
      message: `The request from ${u.name} (${u.email}) is deleted and the seat on the join code is freed. The person must sign up again if this was a mistake.`,
      confirmLabel: "Reject",
      danger: true,
    });
    if (!ok) return;
    setBusyId(u.id);
    try {
      await api.post(`/users/${u.id}/reject`);
      toast.success(`The request from ${u.name} was rejected.`);
    } catch (err) {
      toast.error(extractError(err));
    }
    await load();
    changed();
    if (mounted.current) setBusyId(null);
  }

  async function approveAll() {
    const count = data?.total ?? 0;
    const ok = await confirm({
      title: `Approve all ${count} pending sign-up${count === 1 ? "" : "s"}?`,
      message: "Every person waiting will get access to the organization right away, with the role their join code gave them.",
      confirmLabel: `Approve ${count}`,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const { data: res } = await api.post("/users/pending/approve-all");
      const n = res?.approved ?? 0;
      toast.success(`${n} sign-up${n === 1 ? "" : "s"} approved.`);
    } catch (err) {
      toast.error(extractError(err));
    }
    await load();
    changed();
    if (mounted.current) setBulkBusy(false);
  }

  if (!data) return error ? <ErrorBox>{error}</ErrorBox> : <Loading />;

  const users = data.users;
  const busy = bulkBusy || busyId !== null;

  return (
    <>
      <p className="note">
        People land here after they sign up with a join code and confirm their email address. They cannot sign in until you approve them.
      </p>
      <ErrorBox>{error}</ErrorBox>

      {users.length === 0 ? (
        <div className="empty-state">No sign-ups are waiting for approval</div>
      ) : (
        <>
          <div className="toolbar">
            <span className="muted" aria-live="polite">{data.total} waiting</span>
            <div className="btn-row" style={{ marginLeft: "auto" }}>
              <button type="button" onClick={approveAll} disabled={busy} aria-busy={bulkBusy}>
                <Icon name="check" /> {bulkBusy ? "Approving…" : "Approve all"}
              </button>
            </div>
          </div>
          {data.total > users.length && (
            <p className="note">Showing the newest {PENDING_CAP} of {data.total} requests. Approve or reject some to see the rest.</p>
          )}
          <div className="table-wrap" aria-busy={busy}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Requested</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const rowBusy = busyId === u.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        {u.name}
                        <span className="sub" style={{ textTransform: "none" }}>{u.email}</span>
                      </td>
                      <td>{roleLabel(u.role)}</td>
                      <td className="mono muted nowrap">{formatDate(u.createdAt)}</td>
                      <td className="num">
                        <div className="cell-actions" style={{ justifyContent: "flex-end" }}>
                          <button type="button" onClick={() => approve(u)} disabled={busy} aria-busy={rowBusy}>
                            Approve
                          </button>
                          <button type="button" className="danger" onClick={() => reject(u)} disabled={busy}>
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
