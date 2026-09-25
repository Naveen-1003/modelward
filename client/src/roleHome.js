export function roleHome(role) {
  if (role === "ml_engineer") return "/ml";
  if (role === "compliance_officer") return "/compliance";
  if (role === "admin") return "/admin";
  return "/login";
}
