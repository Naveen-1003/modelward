import React, { useCallback, useEffect, useState } from "react";
import api, { extractError } from "../../api/axios.js";
import { useToast } from "../../context/ToastContext.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import StatusBadge from "../../components/StatusBadge.jsx";
import { useMounted } from "../../components/featureUtils.js";
import { Icon, Loading, ErrorBox } from "../../components/ui.jsx";
import { formatDate } from "./format.js";

// The server returns at most this many rows per list.
const TRASH_CAP = 200;

function CapNotice({ count, what }) {
  if (count < TRASH_CAP) return null;
  return <p className="note">Showing the {TRASH_CAP} most recently archived {what}. Older archived items are not listed.</p>;
}

function Meta({ row }) {
  return (
    <>
      <td className="mono muted nowrap">{formatDate(row.deletedAt)}</td>
      <td>{row.deleteReason || <span className="muted">No reason given</span>}</td>
      <td>{row.deletedByName || <span className="muted">Unknown</span>}</td>
    </>
  );
}

export default function TrashTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const mounted = useMounted();
  const [trash, setTrash] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/trash");
      if (!mounted.current) return;
      setTrash({ models: data.models || [], versions: data.versions || [] });
      setError("");
    } catch (err) {
      if (mounted.current) setError(extractError(err));
    }
  }, [mounted]);

  useEffect(() => {
    load();
  }, [load]);

  async function restore(kind, row, label, message) {
    const ok = await confirm({ title: `Restore ${label}?`, message, confirmLabel: "Restore" });
    if (!ok) return;
    setBusyId(row._id);
    try {
      await api.post(`/${kind}/${row._id}/restore`);
      toast.success(`${label} restored.`);
      await load();
    } catch (err) {
      // 409s explain themselves (name taken, parent model archived, ...)
      toast.error(extractError(err));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  if (!trash) return error ? <ErrorBox>{error}</ErrorBox> : <Loading />;

  return (
    <>
      <ErrorBox>{error}</ErrorBox>
      <p className="note">
        Archived items are kept, not erased. Restore one to bring it back; a model returns together with the versions that were archived with it.
      </p>

      <section aria-label="Archived models">
        <div className="section-head"><h2>Models</h2><span className="muted">{trash.models.length} archived</span></div>
        <CapNotice count={trash.models.length} what="models" />
        {trash.models.length === 0 ? (
          <div className="empty-state">No archived models.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Model</th><th>Archived</th><th>Reason</th><th>By</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {trash.models.map((m) => (
                  <tr key={m._id}>
                    <td><strong>{m.name}</strong></td>
                    <Meta row={m} />
                    <td className="num">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busyId === m._id}
                        aria-busy={busyId === m._id}
                        onClick={() => restore("models", m, `Model "${m.name}"`, `"${m.name}" and the versions archived with it will return to the registry.`)}
                      >
                        <Icon name="restore" /> Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-label="Archived versions">
        <div className="section-head"><h2>Versions</h2><span className="muted">{trash.versions.length} archived</span></div>
        <CapNotice count={trash.versions.length} what="versions" />
        {trash.versions.length === 0 ? (
          <div className="empty-state">No archived versions.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Version</th><th>Status</th><th>Archived</th><th>Reason</th><th>By</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {trash.versions.map((v) => (
                  <tr key={v._id}>
                    <td>
                      <strong>{v.modelName}</strong> <span className="mono">v{v.versionNumber}</span>
                    </td>
                    <td><StatusBadge status={v.status} /></td>
                    <Meta row={v} />
                    <td className="num">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busyId === v._id}
                        aria-busy={busyId === v._id}
                        onClick={() => restore("versions", v, `Version ${v.versionNumber} of "${v.modelName}"`, "It will return to its previous status.")}
                      >
                        <Icon name="restore" /> Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
