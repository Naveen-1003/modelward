const mongoose = require("mongoose");
const env = require("./env");

// autoIndex is OFF on purpose: migrations/index.js creates indexes explicitly,
// AFTER it has backfilled/de-duplicated legacy data, so a unique index can never
// fail to build because of old rows. Tests call ensureIndexes() themselves.
mongoose.set("autoIndex", false);

async function connectDB(uri = env.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  // Never log credentials from an Atlas URI.
  console.log(`[db] connected -> ${uri.replace(/\/\/[^@/]+@/, "//***@")}`);
}

module.exports = connectDB;
