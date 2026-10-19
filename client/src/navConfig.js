// Sidebar navigation per role. `also` lists extra path prefixes that keep an item highlighted
// (the model page belongs to the registry / model lists). `badge` names a navCounts key.
export const ADMIN_SECTIONS = [
  { id: "orgs", label: "Organizations", icon: "org", platform: true, title: "Organizations", description: "Create and manage organizations, then open one to work inside it." },
  { id: "overview", label: "Overview", icon: "overview", title: "Governance overview", description: "Model risk, review status and deployment across the organization." },
  { id: "models", label: "Models", icon: "registry", also: ["/models"], title: "Models", description: "Browse every model and version in the registry." },
  { id: "users", label: "Users", icon: "users", title: "Users", description: "Add people, change roles and deactivate accounts." },
  { id: "pending", label: "Pending", icon: "pending", badge: "pending", title: "Pending sign-ups", description: "People who verified their email and wait for approval." },
  { id: "organization", label: "Organization", icon: "org", title: "Organization settings", description: "Join codes, allowed domains and approval rules." },
  { id: "thresholds", label: "Thresholds", icon: "settings", title: "Risk thresholds", description: "Accuracy, fairness and drift limits used for risk tiers." },
  { id: "trash", label: "Trash", icon: "trash", title: "Trash", description: "Archived models and versions that can be restored." },
  { id: "audit", label: "Audit log", icon: "file", title: "Audit log", description: "A tamper-evident record of every action." },
];

const ADMIN_GROUPS = [
  { label: "Platform", ids: ["orgs"], platform: true },
  { label: "Workspace", ids: ["overview", "models"] },
  { label: "People", ids: ["users", "pending"] },
  { label: "Configuration", ids: ["organization", "thresholds"] },
  { label: "Records", ids: ["trash", "audit"] },
];

export const ML_SECTIONS = [
  { id: "", label: "My models", icon: "registry", also: ["/models"], kicker: "ML engineering", title: "Model registry", description: "Track versions, measured performance, and readiness for review." },
  { id: "activity", label: "Activity", icon: "file", kicker: "ML engineering", title: "Activity", description: "Recent actions on your models and versions." },
];

export const COMPLIANCE_SECTIONS = [
  { id: "", label: "Review queue", icon: "queue", badge: "queue", kicker: "Compliance", title: "Review queue", description: "Versions awaiting review, newest first." },
  { id: "attention", label: "Drift decisions", icon: "alert", badge: "attention", kicker: "Compliance", title: "Needs attention", description: "Live versions flagged by drift monitoring." },
  { id: "deploy", label: "Ready to deploy", icon: "upload", badge: "deploy", kicker: "Compliance", title: "Awaiting deployment", description: "Approved versions that are not live yet." },
  { id: "models", label: "All models", icon: "registry", also: ["/models"], kicker: "Compliance", title: "All models", description: "Browse the full registry." },
  { id: "activity", label: "Audit log", icon: "file", kicker: "Compliance", title: "Audit log", description: "A tamper-evident record of every action." },
];

const link = (base, s) => ({ ...s, to: s.id ? `${base}/${s.id}` : base, end: !s.id });

export function navFor(role) {
  if (role === "ml_engineer") return [{ label: null, items: ML_SECTIONS.map((s) => link("/ml", s)) }];
  if (role === "compliance_officer") return [{ label: null, items: COMPLIANCE_SECTIONS.map((s) => link("/compliance", s)) }];
  if (role === "admin" || role === "super_admin") {
    const sup = role === "super_admin";
    return ADMIN_GROUPS.filter((g) => sup || !g.platform).map((g) => ({
      label: g.label,
      items: g.ids.map((id) => link("/admin", ADMIN_SECTIONS.find((s) => s.id === id))),
    }));
  }
  return [];
}
