const mongoose = require("mongoose");
const env = require("./config/env");

// Fail fast on a bad configuration (weak secret in prod, missing metrics secret, ...).
try {
  env.validateEnv();
} catch (err) {
  console.error(`[server] ${err.message}`);
  process.exit(1);
}

const app = require("./app");
const connectDB = require("./config/db");
const { runMigrations } = require("./migrations");
const { startCleanupJob } = require("./jobs/cleanup");
const { startExpiryJob } = require("./jobs/expireUnverified");

let server;

async function main() {
  await connectDB();
  // super admin promotion/seed (a missing SUPER_ADMIN_EMAIL only warns) + tenant backfill + dedupe
  // + index creation; idempotent
  await runMigrations();
  startCleanupJob();
  startExpiryJob();
  server = app.listen(env.port, () => {
    console.log(`[server] ModelWard API listening on port ${env.port} (${env.nodeEnv})`);
  });
}

main().catch((err) => {
  console.error("[server] Failed to start:", err);
  process.exit(1);
});

// Graceful shutdown so Render deploys don't kill in-flight uploads mid-write.
let shuttingDown = false;
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return; // a second signal/fault must not restart the sequence
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  const done = () =>
    mongoose.connection
      .close(false)
      .catch(() => {})
      .finally(() => process.exit(exitCode));
  if (server) server.close(done);
  else done();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// After an unhandled fault the process state is unknown: log it, stop accepting
// work, finish in-flight requests and exit non-zero so the platform restarts us.
// shutdown() is idempotent and force-exits after 10s, so this cannot loop.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason instanceof Error ? reason.stack || reason.message : reason);
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err && err.stack ? err.stack : err);
  shutdown("uncaughtException", 1);
});
