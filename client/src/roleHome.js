// super_admin is "admin plus the platform": same client-side treatment, plus the Organizations tab.
export function isAdminRole(role) {
  return role === "admin" || role === "super_admin";
}

export function roleHome(role) {
  if (role === "ml_engineer") return "/ml";
  if (role === "compliance_officer") return "/compliance";
  if (role === "admin" || role === "super_admin") return "/admin";
  return "/login";
}
