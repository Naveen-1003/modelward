// Every action that may appear in the audit log. Shared by the AuditLog schema
// and by whichever route writes the entry.
module.exports = [
  // auth / users
  "signup",
  "login",
  "login_failed",
  "create_user",
  "update_user",
  // settings
  "update_settings",
  // registry
  "create_model",
  "archive_model",
  "restore_model",
  // version lifecycle
  "upload_version",
  "retry_version",
  "update_notes",
  "submit_version",
  "withdraw_version",
  "approve",
  "reject",
  "request_changes",
  "deploy",
  "retire",
  "resolve_review",
  "archive_version",
  "restore_version",
  "download_file",
  // monitoring
  "simulate_drift",
  "monitoring_batch",
  "drift_flagged",
  // collaboration
  "comment",
  // organizations / multi-tenancy
  "org_create",
  "org_update",
  "org_suspend",
  "org_activate",
  "org_access", // a super admin started working inside an organization
  "code_update",
  "code_regenerate",
  "join_code_failed",
  "email_verified",
  "user_approve",
  "user_reject",
  "setup_link_issued",
  "password_setup",
  "cross_org_attempt", // an id of another organization was requested (answered 404)
];
