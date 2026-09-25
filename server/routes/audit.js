const express = require("express");
const AuditLog = require("../models/AuditLog");
const authGuard = require("../middleware/auth");

const router = express.Router();

// Every authenticated role sees the full, read-only log -- no per-role scoping
// in the MVP (Admin and Compliance Officer see everything by design anyway;
// ML Engineer seeing everyone else's actions too is a deliberate scope cut,
// documented in the build plan, not an oversight).
router.get("/", authGuard, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch audit log", details: err.message });
  }
});

module.exports = router;
