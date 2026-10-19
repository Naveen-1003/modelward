// Unverified signups (email link never clicked) expire after 7 days: the account is deleted
// and the join-code seat it held is given back. Only `unverified` accounts are ever touched;
// pending / active / invited ones are not.
const User = require("../models/User");
const { releaseSeat } = require("../utils/joinCodes");

const FIRST_RUN_DELAY_MS = 45 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

async function expireUnverified(now = new Date()) {
  // Cross-tenant on purpose: this is a platform job (allow-listed in tests/tenantAllowlist.test.js).
  const expired = await User.find({ status: "unverified", verifyExpiresAt: { $lt: now } })
    .setOptions({ bypassTenant: true })
    .select("orgId seatKind seatGen")
    .lean();
  let removed = 0;
  for (const u of expired) {
    try {
      // Re-checked in the delete itself: an account verified a moment ago must survive.
      const r = await User.deleteOne({ _id: u._id, status: "unverified", verifyExpiresAt: { $lt: now } })
        .setOptions({ bypassTenant: true });
      if (r.deletedCount !== 1) continue;
      removed += 1;
      if (u.orgId && u.seatKind) await releaseSeat(u.orgId, u.seatKind, u.seatGen);
    } catch (err) {
      console.error(`[expire-unverified] could not expire user ${u._id}: ${err.message}`);
    }
  }
  if (removed) console.log(`[expire-unverified] removed ${removed} unverified account(s) past their verification deadline`);
  return { removed };
}

async function safeRun() {
  try {
    await expireUnverified();
  } catch (err) {
    console.error("[expire-unverified] run failed:", err);
  }
}

function startExpiryJob() {
  if (process.env.NODE_ENV === "test") return;
  setTimeout(safeRun, FIRST_RUN_DELAY_MS).unref();
  setInterval(safeRun, INTERVAL_MS).unref();
}

module.exports = { startExpiryJob, expireUnverified };
