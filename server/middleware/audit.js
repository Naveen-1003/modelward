const AuditLog = require("../models/AuditLog");

// Fire-and-forget write -- a logging failure must never break the actual request.
async function writeAuditLog({ actor, action, targetType, targetId, details = "" }) {
  try {
    await AuditLog.create({
      actorName: actor.name,
      actorRole: actor.role,
      action,
      targetType,
      targetId,
      details,
    });
  } catch (err) {
    console.error("[audit] failed to write log entry:", err.message);
  }
}

module.exports = writeAuditLog;
