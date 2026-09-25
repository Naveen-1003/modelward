// Usage: roleGuard(["admin", "ml_engineer"])
// Must run after authGuard (needs req.user already set).
function roleGuard(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Role '${req.user.role}' is not permitted to perform this action` });
    }
    next();
  };
}

module.exports = roleGuard;
