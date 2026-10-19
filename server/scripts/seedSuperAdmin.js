// Promotes / creates the platform owner from the environment, outside of a server boot:
//   SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD=... [SUPER_ADMIN_NAME=...] npm run seed:superadmin
// (the same variables, the same rules as the startup migration; values may also live in server/.env).
// Exits non-zero when nothing could be configured.
const mongoose = require("mongoose");
const env = require("../config/env");
const connectDB = require("../config/db");
const { ensureSuperAdminDetailed } = require("../utils/superAdmin");

async function main() {
  if (!env.superAdminEmail) throw new Error("SUPER_ADMIN_EMAIL is not set");
  await connectDB();
  const result = await ensureSuperAdminDetailed();
  console.log(`[seed] ${result.action}: ${result.message}`);
  if (result.action === "none" || result.action === "skipped") throw new Error(result.message);
}

main()
  .then(() => mongoose.disconnect().then(() => process.exit(0)))
  .catch(async (err) => {
    console.error(`[seed] failed: ${err.message}`);
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
