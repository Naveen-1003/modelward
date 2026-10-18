import React from "react";

export const STATUS_LABELS = {
  draft: "Draft",
  submitted: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  deployed: "Deployed",
  needs_review: "Needs review",
  superseded: "Superseded",
  retired: "Retired",
  upload_failed: "Upload failed",
};

export default function StatusBadge({ status }) {
  if (!status) return null;
  const label = STATUS_LABELS[status] || String(status).replace(/_/g, " ");
  return <span className={`badge badge-status-${status}`}>{label}</span>;
}
