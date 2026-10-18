import React, { useState } from "react";
import { useToast } from "../context/ToastContext.jsx";
import { Icon } from "./ui.jsx";
import { blobErrorMessage, downloadBlob, useMounted } from "./featureUtils.js";

// Fetches through the authenticated axios instance and saves the blob.
export default function DownloadButton({ url, params, fileName, fallbackName, label, className = "secondary", disabled }) {
  const toast = useToast();
  const mounted = useMounted();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      await downloadBlob(url, { params, fileName, fallbackName });
    } catch (err) {
      toast.error(await blobErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <button type="button" className={className} onClick={onClick} disabled={disabled || busy} aria-busy={busy}>
      <Icon name="download" />
      {busy ? "Downloading…" : label}
    </button>
  );
}
