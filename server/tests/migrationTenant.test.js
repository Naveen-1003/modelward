// The multi-tenant migration: a single-tenant database becomes one "Default Organization".
const mongoose = require("mongoose");
const env = require("../config/env");
const AuditLog = require("../models/AuditLog");
const writeAuditLog = require("../middleware/audit");
const { GENESIS, computeHash, verifyChain } = require("../utils/auditChain");
const { runMigrations, ensureIndexes } = require("../migrations");
const { runWithOrg } = require("../utils/tenant");
const { connect, disconnect } = require("./helpers");

const oid = () => new mongoose.Types.ObjectId();
const col = (name) => mongoose.connection.collection(name);
const day = (n) => new Date(Date.UTC(2025, 0, n));
const wipe = () => mongoose.connection.dropDatabase();
const snapshotOf = async (names) =>
  JSON.stringify(await Promise.all(names.map((n) => col(n).find().sort({ _id: 1 }).toArray())));
const ALL = ["users", "models", "versions", "comments", "metricsnapshots", "settings", "auditlogs", "organizations"];

const saved = {};
beforeAll(async () => {
  await connect();
  Object.assign(saved, { e: env.superAdminEmail, p: env.superAdminPassword, n: env.defaultOrgName });
});
afterAll(async () => {
  Object.assign(env, { superAdminEmail: saved.e, superAdminPassword: saved.p, defaultOrgName: saved.n });
  await disconnect();
});
beforeEach(() => {
  env.superAdminEmail = "";
  env.superAdminPassword = "";
  env.defaultOrgName = "Default Organization";
});

const user = (email, role, extra = {}) => ({
  _id: oid(), name: email.split("@")[0], email, passwordHash: "x", role, isActive: true, createdAt: day(1), ...extra,
});
const model = (name, extra = {}) => ({
  _id: oid(), name, description: "", useCase: "", createdBy: oid(), isDeleted: false, versionSeq: 1, createdAt: day(1), ...extra,
});
const version = (modelId, n, extra = {}) => ({
  _id: oid(), modelId, versionNumber: n, fileType: "csv", status: "draft", isDeleted: false, initialRiskTier: null,
  thresholdsUsed: {}, retryable: false, fileName: "a.csv", createdBy: oid(), createdAt: day(2), updatedAt: day(2), ...extra,
});

function legacyAuditRows(n, actorId) {
  const rows = [];
  let prevHash = GENESIS;
  for (let seq = 1; seq <= n; seq += 1) {
    const row = { _id: oid(), seq, prevHash, actorName: "Alice", actorRole: "admin", actorId, action: "login", targetType: "User", targetId: actorId, details: `legacy ${seq}`, createdAt: day(seq) };
    row.hash = computeHash(row, "sha256");
    prevHash = row.hash;
    rows.push(row);
  }
  return rows;
}

describe("legacy single-tenant database", () => {
  const ids = {};
  let summary;

  beforeAll(async () => {
    await wipe();
    Object.assign(ids, { adminOld: oid(), adminNew: oid(), engineer: oid(), compliance: oid(), root: oid(), m1: oid(), m2: oid(), v1: oid(), v2: oid(), v3: oid() });
    // The platform owner is the OLDEST admin, so contactEmail must come from the next admin.
    await col("users").insertMany([
      user("root@acme.test", "admin", { _id: ids.root, createdAt: day(1) }),
      user("boss@acme.test", "admin", { _id: ids.adminOld, createdAt: day(2) }),
      user("boss2@acme.test", "admin", { _id: ids.adminNew, createdAt: day(3) }),
      user("Eng@Acme.test", "ml_engineer", { _id: ids.engineer, createdAt: day(4) }),
      user("co@acme.test", "compliance_officer", { _id: ids.compliance, createdAt: day(5) }),
    ]);
    await col("models").insertMany([model("Alpha", { _id: ids.m1 }), model("Beta", { _id: ids.m2, isDeleted: true })]);
    await col("versions").insertMany([
      version(ids.m1, 1, { _id: ids.v1 }),
      version(ids.m1, 2, { _id: ids.v2, isDeleted: true }),
      version(ids.m2, 1, { _id: ids.v3 }),
      version(oid(), 1), // orphan: its model no longer exists -> falls back to the default org
    ]);
    await col("comments").insertMany([
      { _id: oid(), versionId: ids.v1, authorId: ids.engineer, authorName: "E", authorRole: "ml_engineer", body: "hi", createdAt: day(3) },
      { _id: oid(), versionId: oid(), authorId: ids.engineer, authorName: "E", authorRole: "ml_engineer", body: "orphan", createdAt: day(3) },
    ]);
    await col("metricsnapshots").insertMany([
      { _id: oid(), versionId: ids.v1, accuracy: 0.9, fairnessGap: 0.05, source: "baseline", riskTier: "low", rows: null, createdAt: day(3) },
    ]);
    await col("settings").insertOne({ _id: oid(), key: "global", lowAccuracy: 0.9, lowFairnessGap: 0.05, mediumAccuracy: 0.8, mediumFairnessGap: 0.1, driftThreshold: 0.2, createdAt: day(1), updatedAt: day(1) });
    await col("auditlogs").insertMany(legacyAuditRows(3, ids.adminOld));

    // The indexes the single-tenant schema had.
    await col("models").createIndex({ name: 1 }, { unique: true });
    await col("settings").createIndex({ key: 1 }, { unique: true });

    env.superAdminEmail = "root@acme.test";
    summary = await runMigrations();
  });

  test("creates ONE default organization and attaches every row", async () => {
    const orgs = await col("organizations").find().toArray();
    expect(orgs).toHaveLength(1);
    const org = orgs[0];
    ids.org = org._id;
    expect(org).toMatchObject({ name: "Default Organization", domainRuleEnabled: false, autoApprove: false, allowedDomains: [], status: "active", contactEmail: "boss@acme.test" });
    for (const kind of ["ml_engineer", "compliance_officer"]) expect(org.codes[kind]).toMatchObject({ used: 0, gen: 1, seatLimit: null, expiresAt: null });
    expect(org.codes.ml_engineer.value).toMatch(/^[A-Z2-9]{12}$/);
    expect(org.codes.ml_engineer.value).not.toBe(org.codes.compliance_officer.value);

    for (const c of ["models", "versions", "comments", "metricsnapshots", "settings", "auditlogs"]) {
      // (the promotion's own audit entry is platform-level: chainV 2, orgId null)
      expect(await col(c).countDocuments({ orgId: { $ne: ids.org }, chainV: { $exists: false } })).toBe(0);
      expect(await col(c).countDocuments()).toBeGreaterThan(0);
    }
    // archived rows are attached too
    expect(await col("models").countDocuments({ isDeleted: true, orgId: ids.org })).toBe(1);
    expect(await col("versions").countDocuments({ isDeleted: true, orgId: ids.org })).toBe(1);
    expect(summary.join(" | ")).toMatch(/created organization "Default Organization"/);
  });

  test("admins stay admins of it; the super admin is promoted and has no organization", async () => {
    const byId = async (id) => col("users").findOne({ _id: id });
    expect(await byId(ids.adminOld)).toMatchObject({ role: "admin", orgId: ids.org, status: "active" });
    expect(await byId(ids.adminNew)).toMatchObject({ role: "admin", orgId: ids.org, status: "active" });
    expect(await byId(ids.engineer)).toMatchObject({ role: "ml_engineer", orgId: ids.org, emailKey: "eng@acme.test" });
    expect(await byId(ids.compliance)).toMatchObject({ role: "compliance_officer", orgId: ids.org });
    const root = await byId(ids.root);
    expect(root).toMatchObject({ role: "super_admin", orgId: null, status: "active", isActive: true, emailKey: "root@acme.test" });
    expect(summary.join(" | ")).toMatch(/promoted root@acme.test to super_admin/);
  });

  test("the legacy settings document becomes the organization's (key removed)", async () => {
    const all = await col("settings").find().toArray();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ orgId: ids.org, lowAccuracy: 0.9, driftThreshold: 0.2 });
    expect("key" in all[0]).toBe(false);
    const { getThresholds } = require("../utils/settings");
    expect((await runWithOrg(ids.org, () => getThresholds(ids.org))).lowAccuracy).toBe(0.9);
  });

  test("old indexes are gone, new ones are present", async () => {
    const models = await col("models").indexes();
    expect(models.some((i) => JSON.stringify(i.key) === JSON.stringify({ name: 1 }))).toBe(false);
    expect(models.find((i) => JSON.stringify(i.key) === JSON.stringify({ orgId: 1, name: 1 }))).toMatchObject({
      unique: true, partialFilterExpression: { isDeleted: false }, collation: expect.objectContaining({ locale: "en", strength: 2 }),
    });
    const settings = await col("settings").indexes();
    expect(settings.some((i) => i.key.key === 1)).toBe(false);
    expect(settings.find((i) => i.key.orgId === 1)).toMatchObject({ unique: true });
    const users = await col("users").indexes();
    expect(users.find((i) => i.key.emailKey === 1)).toMatchObject({ unique: true, sparse: true });
    expect(users.find((i) => i.key.email === 1)).toMatchObject({ unique: true });
    expect((await col("organizations").indexes()).some((i) => i.key.name === 1 && i.unique)).toBe(true);
  });

  test("a second run changes nothing and reports nothing", async () => {
    const before = await snapshotOf(ALL);
    const again = await runMigrations();
    expect(again).toEqual([]);
    expect(await snapshotOf(ALL)).toBe(before);
    await ensureIndexes();
    expect(await col("organizations").countDocuments()).toBe(1);
  });

  test("a mixed legacy + new audit chain still verifies", async () => {
    // the promotion wrote a platform-level v2 entry (orgId null) AFTER the 3 legacy rows
    const rows = await col("auditlogs").find().sort({ seq: 1 }).toArray();
    expect(rows.slice(0, 3).every((r) => r.chainV === undefined && String(r.orgId) === String(ids.org))).toBe(true);
    expect(rows[3]).toMatchObject({ chainV: 2, action: "update_user", seq: 4 });
    expect(rows[3].orgId == null).toBe(true); // never stamped with the default org

    await writeAuditLog({ actor: { name: "Alice", role: "admin", _id: ids.adminOld }, action: "login", targetType: "User", targetId: ids.adminOld, details: "new", orgId: ids.org });
    await writeAuditLog({ actor: { name: "x", role: "none" }, action: "login_failed", targetType: "User", details: "platform", orgId: null });
    const result = await verifyChain(AuditLog);
    expect(result).toMatchObject({ ok: true, checked: 6 });
    // and a legacy row tampered with after the migration is still caught
    await col("auditlogs").updateOne({ seq: 2 }, { $set: { details: "forged" } });
    expect((await verifyChain(AuditLog)).brokenSeqs).toEqual([2]);
  });
});

describe("existing organizations with stray rows", () => {
  const org = (name, extra = {}) => ({ _id: oid(), name, address: "", contactEmail: "", allowedDomains: [], domainRuleEnabled: true, autoApprove: false, status: "active", codes: require("../utils/joinCodes").newCodes(), createdAt: day(1), updatedAt: day(1), ...extra });

  test("strays follow their parent's org, else go to the oldest org with the default name", async () => {
    await wipe();
    const acme = org("Acme");
    const dflt = org("default organization", { createdAt: day(5) }); // case-insensitive match
    const dfltTwin = org("Default Organization 2", { createdAt: day(2) });
    await col("organizations").insertMany([acme, dflt, dfltTwin]);
    const mAcme = oid();
    await col("models").insertMany([model("Acme model", { _id: mAcme, orgId: acme._id }), model("Stray model")]);
    const vAcme = oid();
    await col("versions").insertMany([version(mAcme, 1, { _id: vAcme }), version(oid(), 1)]); // stray under an Acme model + an orphan
    await col("metricsnapshots").insertOne({ _id: oid(), versionId: vAcme, accuracy: 1, fairnessGap: 0, source: "baseline", riskTier: "low", rows: null, createdAt: day(3) });
    await col("users").insertMany([user("stray@x.test", "ml_engineer"), user("acme@acme.test", "admin", { orgId: acme._id, status: "active", emailKey: "acme@acme.test" })]);

    const summary = await runMigrations();
    expect(await col("organizations").countDocuments()).toBe(3); // nothing created: "default organization" exists
    expect(summary.join(" | ")).not.toMatch(/created organization/);
    expect((await col("models").findOne({ name: "Stray model" })).orgId).toEqual(dflt._id);
    expect((await col("models").findOne({ name: "Acme model" })).orgId).toEqual(acme._id);
    const versions = await col("versions").find().toArray();
    expect(versions.find((v) => String(v._id) === String(vAcme)).orgId).toEqual(acme._id);
    expect(versions.find((v) => String(v._id) !== String(vAcme)).orgId).toEqual(dflt._id);
    expect((await col("metricsnapshots").findOne()).orgId).toEqual(acme._id);
    expect((await col("users").findOne({ email: "stray@x.test" })).orgId).toEqual(dflt._id);
    expect((await col("users").findOne({ email: "acme@acme.test" })).orgId).toEqual(acme._id);
    expect(await runMigrations()).toEqual([]);
  });

  test("creates the default organization when organizations exist but none has that name", async () => {
    await wipe();
    const acme = org("Acme");
    await col("organizations").insertOne(acme);
    await col("models").insertOne(model("Stray model"));
    env.defaultOrgName = "Legacy Co";
    const summary = await runMigrations();
    expect(summary.join(" | ")).toMatch(/created organization "Legacy Co"/);
    const legacy = await col("organizations").findOne({ name: "Legacy Co" });
    expect((await col("models").findOne()).orgId).toEqual(legacy._id);
    expect(await col("organizations").countDocuments()).toBe(2);
  });
});

describe("per-organization model names", () => {
  test("the same name in two organizations is legal; duplicates inside one are renamed", async () => {
    await wipe();
    const a = oid();
    const b = oid();
    const orgs = ["Org A", "Org B"].map((name, i) => ({ _id: [a, b][i], name, codes: require("../utils/joinCodes").newCodes(), domainRuleEnabled: true, allowedDomains: [], status: "active", createdAt: day(1), updatedAt: day(1) }));
    await col("organizations").insertMany(orgs);
    await col("models").insertMany([
      model("Scorer", { orgId: a, createdAt: day(1) }),
      model("scorer", { orgId: a, createdAt: day(2) }), // duplicate inside org A
      model("Scorer", { orgId: b, createdAt: day(3) }), // fine: other org
      model("SCORER", { orgId: b, createdAt: day(4), isDeleted: true }), // archived: never renamed
    ]);
    const summary = await runMigrations();
    expect(summary.join(" | ")).toMatch(/renamed 1 duplicate model name/);
    const names = (await col("models").find({ orgId: a }).sort({ createdAt: 1 }).toArray()).map((m) => m.name);
    expect(names).toEqual(["Scorer", "scorer (2)"]);
    expect((await col("models").find({ orgId: b, isDeleted: false }).toArray()).map((m) => m.name)).toEqual(["Scorer"]);
    expect((await col("models").indexes()).find((i) => i.key.orgId === 1 && i.key.name === 1).unique).toBe(true);
    expect(await runMigrations()).toEqual([]);
  });
});

describe("emailKey backfill", () => {
  test("plain addresses claim their key first; a colliding later +tag address keeps its full address", async () => {
    await wipe();
    const org = { _id: oid(), name: "O", codes: require("../utils/joinCodes").newCodes(), domainRuleEnabled: false, allowedDomains: [], status: "active", createdAt: day(1), updatedAt: day(1) };
    await col("organizations").insertOne(org);
    await col("users").insertMany([
      user("jo+hr@acme.com", "ml_engineer", { createdAt: day(1), orgId: org._id }), // OLDER, but tagged
      user("jo@acme.com", "ml_engineer", { createdAt: day(2), orgId: org._id }),
      user("jo+it@acme.com", "ml_engineer", { createdAt: day(3), orgId: org._id }),
      user("Mia+x@Acme.com", "admin", { createdAt: day(4), orgId: org._id }), // alone: normalized key
      user("keep@acme.com", "admin", { createdAt: day(5), orgId: org._id, emailKey: "keep@acme.com" }), // already keyed
    ]);
    const summary = await runMigrations();
    expect(summary.join(" | ")).toMatch(/emailKey on 4 user/);
    const key = async (email) => (await col("users").findOne({ email })).emailKey;
    expect(await key("jo@acme.com")).toBe("jo@acme.com");
    expect(await key("jo+hr@acme.com")).toBe("jo+hr@acme.com");
    expect(await key("jo+it@acme.com")).toBe("jo+it@acme.com");
    expect(await key("Mia+x@Acme.com")).toBe("mia@acme.com");
    expect(await key("keep@acme.com")).toBe("keep@acme.com");
    expect(await col("users").countDocuments({ status: { $ne: "active" } })).toBe(0);
    // the unique index could be built over all of them
    expect((await col("users").indexes()).some((i) => i.key.emailKey === 1 && i.unique)).toBe(true);
    expect(await runMigrations()).toEqual([]);
  });
});

describe("empty database", () => {
  test("creates no organization and no user, and the audit log stays empty", async () => {
    await wipe();
    const summary = await runMigrations();
    expect(summary).toEqual([]);
    for (const c of ["organizations", "users", "settings", "auditlogs"]) expect(await col(c).countDocuments()).toBe(0);
  });

  test("only a configured super admin (with a password) is created, still without organization", async () => {
    await wipe();
    env.superAdminEmail = "owner@platform.test";
    env.superAdminPassword = "a-good-password";
    const summary = await runMigrations();
    expect(summary).toEqual(["created super_admin owner@platform.test"]);
    expect(await col("organizations").countDocuments()).toBe(0);
    expect(await col("users").findOne()).toMatchObject({ role: "super_admin", orgId: null, status: "active", emailKey: "owner@platform.test" });
    expect(await runMigrations()).toEqual([]);
  });
});

describe("ensureIndexes robustness", () => {
  test("leftover indexes with the same key but other options are replaced instead of crashing", async () => {
    await wipe();
    await col("models").createIndex({ orgId: 1, name: 1 }); // no collation / partial filter / unique
    await col("users").createIndex({ emailKey: 1 }); // not unique, not sparse
    await col("settings").createIndex({ key: 1 }, { unique: true });
    await col("models").createIndex({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 }, partialFilterExpression: { isDeleted: false } });
    await ensureIndexes();
    const models = await col("models").indexes();
    expect(models.filter((i) => i.key.name === 1)).toHaveLength(1);
    expect(models.find((i) => i.key.name === 1).key).toEqual({ orgId: 1, name: 1 });
    expect(models.find((i) => i.key.name === 1)).toMatchObject({ unique: true, partialFilterExpression: { isDeleted: false } });
    expect((await col("users").indexes()).find((i) => i.key.emailKey === 1)).toMatchObject({ unique: true, sparse: true });
    expect((await col("settings").indexes()).some((i) => i.key.key === 1)).toBe(false);
  });
});
