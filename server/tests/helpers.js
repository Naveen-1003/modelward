// Shared test helpers. Use a unique TEST_DB_NAME per concurrent runner
// (e.g. TEST_DB_NAME=modelward_jest_a npm test) -- reset() DROPS that database.
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

async function connect() {
  mongoose.set("autoIndex", false);
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
  const { ensureIndexes } = require("../migrations");
  await ensureIndexes();
}

// Drop everything and rebuild indexes so every test file starts clean.
async function reset() {
  await mongoose.connection.dropDatabase();
  const { ensureIndexes } = require("../migrations");
  await ensureIndexes();
}

async function disconnect() {
  await mongoose.connection.close();
}

let counter = 0;
// Creates a user directly in the DB (bypasses signup gating) and returns { user, token }.
async function makeUser(role = "ml_engineer", overrides = {}) {
  const User = require("../models/User");
  counter += 1;
  const user = await User.create({
    name: overrides.name || `Test ${role} ${counter}`,
    email: overrides.email || `${role}.${counter}.${Date.now()}@test.local`,
    passwordHash: await bcrypt.hash(overrides.password || "Password1!", 4),
    role,
    ...(overrides.extra || {}),
  });
  const token = jwt.sign({ sub: user._id.toString(), role: user.role }, env.jwtSecret, { expiresIn: "1h" });
  return { user, token, password: overrides.password || "Password1!" };
}

// supertest convenience: auth(request(app).get("/api/x"), token)
const auth = (req, token) => req.set("Authorization", `Bearer ${token}`);

module.exports = { connect, reset, disconnect, makeUser, auth };
