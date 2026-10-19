// Org admin powers belong to super_admin too (inside the selected organization).
const isAdmin = (user) => !!user && (user.role === "admin" || user.role === "super_admin");

// Usage: roleGuard(["admin", "ml_engineer"])
// Must run after authGuard (needs req.user already set).
// super_admin counts as "admin": it passes any list that contains "admin" and nothing else
// (it is not a reviewer, so e.g. roleGuard(["compliance_officer"]) rejects it).
function roleGuard(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const role = req.user.role;
    if (!allowedRoles.includes(role) && !(role === "super_admin" && allowedRoles.includes("admin"))) {
      return res.status(403).json({ error: `Role '${role}' is not permitted to perform this action` });
    }
    next();
  };
}

module.exports = roleGuard;
module.exports.isAdmin = isAdmin;
module.exports.roleGuard = roleGuard;
