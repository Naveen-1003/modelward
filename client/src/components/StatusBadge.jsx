import React from "react";

const LABELS = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  deployed: "Deployed",
  upload_failed: "Upload Failed",
};

export default function StatusBadge({ status }) {
  return <span className={`badge badge-status-${status}`}>{LABELS[status] || status}</span>;
}
