// Shared test helpers. Use a unique TEST_DB_NAME per concurrent runner
// (e.g. TEST_DB_NAME=modelward_jest_a npm test) -- reset() DROPS that database.
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { runSystem } = require("../utils/tenant");

async function connect() {
  mongoose.set("autoIndex", false);
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
  const { ensureIndexes } = require("../migrations");
  await ensureIndexes();
}

let defaultOrgPromise = null; // the shared org makeUser() uses when no orgId is given

// Drop everything and rebuild indexes so every test file starts clean.
async function reset() {
  defaultOrgPromise = null;
  require("../middleware/auth").resetOrgAccessThrottle(); // in-process super-admin audit throttle
  await mongoose.connection.dropDatabase();
  const { ensureIndexes } = require("../migrations");
  await ensureIndexes();
}

async function disconnect() {
  await mongoose.connection.close();
}

let counter = 0;

// A tenant for tests. Codes are generated like production ones. Override anything:
//   makeOrg({ name: "Acme", allowedDomains: ["acme.com"], autoApprove: true, status: "suspended" })
async function makeOrg(overrides = {}) {
  const Organization = require("../models/Organization");
  const { newCodes } = require("../utils/joinCodes");
  counter += 1;
  return Organization.create({
    name: `Test Org ${counter} ${Date.now().toString(36)}`,
    allowedDomains: ["test.local"],
    domainRuleEnabled: true,
    codes: newCodes(),
    ...overrides,
  });
}

// The shared default organization, created on first use (cleared by reset()).
function defaultOrg() {
  if (!defaultOrgPromise) defaultOrgPromise = makeOrg({ name: "Default Test Org" });
  return defaultOrgPromise;
}

// Creates a user directly in the DB (bypasses signup gating) and returns { user, token, password }.
// The user belongs to overrides.orgId, else the shared default org; super_admin belongs to none.
async function makeUser(role = "ml_engineer", overrides = {}) {
  const User = require("../models/User");
  counter += 1;
  const orgId = role === "super_admin" ? null : (overrides.orgId || (await defaultOrg())._id);
  const password = overrides.password || "Password1!";
  const user = await runSystem(async () =>
    User.create({
      name: overrides.name || `Test ${role} ${counter}`,
      email: overrides.email || `${role}.${counter}.${Date.now()}@test.local`,
      passwordHash: await bcrypt.hash(password, 4),
      role,
      orgId,
      status: overrides.status || "active",
      ...(overrides.extra || {}),
    })
  );
  const token = jwt.sign({ sub: user._id.toString(), role: user.role }, env.jwtSecret, { expiresIn: "1h" });
  return { user, token, password };
}

// Static methods that return a Query: wrapped so they run cross-tenant (direct DB access in tests).
const QUERY_STATICS = new Set([
  "find", "findOne", "findById", "findOneAndUpdate", "findByIdAndUpdate", "findOneAndDelete", "findByIdAndDelete",
  "findOneAndReplace", "countDocuments", "estimatedDocumentCount", "updateOne", "updateMany", "deleteOne", "deleteMany",
  "replaceOne", "distinct", "exists",
]);

// sys(Model).find(...) etc: the same Mongoose model, but every query carries bypassTenant (and
// aggregate() carries it as an aggregate option). Everything else passes through untouched.
function sys(M) {
  return new Proxy(M, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (QUERY_STATICS.has(prop)) return (...args) => value.apply(target, args).setOptions({ bypassTenant: true });
      if (prop === "aggregate") return (...args) => value.apply(target, args).option({ bypassTenant: true });
      return value.bind(target);
    },
  });
}

// supertest convenience: auth(request(app).get("/api/x"), token)
const auth = (req, token) => req.set("Authorization", `Bearer ${token}`);

module.exports = { connect, reset, disconnect, makeUser, makeOrg, defaultOrg, sys, auth };
