jest.mock("../utils/metricsClient");

const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../app");
const computeMetrics = require("../utils/metricsClient");
const { runMigrations, ensureIndexes } = require("../migrations");
const env = require("../config/env");
const { connect, disconnect, makeUser, makeOrg } = require("./helpers");
const { GOOD, uploadCsv, createModel, post } = require("./domainHelpers");

// A developer's .env may configure a platform owner; these tests are about the data migration.
env.superAdminEmail = "";
env.superAdminPassword = "";

const oid = () => new mongoose.Types.ObjectId();
const col = (name) => mongoose.connection.collection(name);
const day = (n) => new Date(Date.UTC(2025, 0, n));

// Wipe the DB WITHOUT rebuilding indexes (helpers.reset() would build the unique
// indexes that legacy duplicate rows could not live under).
const wipe = () => mongoose.connection.dropDatabase();

beforeAll(async () => {
  await connect();
});
afterAll(disconnect);

describe("runMigrations on legacy-shaped data", () => {
  const creator = oid();
  const ids = {};

  beforeAll(async () => {
    await wipe();
    ids.dupOld = oid();
    ids.dupMid = oid();
    ids.dupNew = oid();
    ids.taken2 = oid();
    ids.solo = oid();
    // legacy Model rows: no isDeleted, no versionSeq; three names that differ only by case
    await col("models").insertMany([
      { _id: ids.dupOld, name: "Credit Scorer", description: "", useCase: "", createdBy: creator, createdAt: day(1) },
      { _id: ids.dupMid, name: "credit scorer", description: "", useCase: "", createdBy: creator, createdAt: day(2) },
      { _id: ids.taken2, name: "Credit Scorer (2)", description: "", useCase: "", createdBy: creator, createdAt: day(3) },
      { _id: ids.dupNew, name: "CREDIT SCORER", description: "", useCase: "", createdBy: creator, createdAt: day(4) },
      { _id: ids.solo, name: "Fraud Detector", description: "", useCase: "", createdBy: creator, createdAt: day(5) },
    ]);
    // legacy Version rows: no isDeleted / initialRiskTier / thresholdsUsed / fileName.
    // dupOld has TWO v2 rows (the old countDocuments race).
    const v = (modelId, n, extra = {}) => ({
      _id: oid(), modelId, versionNumber: n, fileType: "csv", datasetNotes: "", trainingNotes: "", status: "draft",
      metrics: { accuracy: 0.95, fairnessGap: 0.02, latencyMs: 10, computedBy: "self_reported" },
      riskTier: "low", uploadError: null, reviewComment: "", reviewedBy: null, createdBy: creator,
      createdAt: day(10 + n), updatedAt: day(10 + n), ...extra,
    });
    ids.v1 = oid();
    ids.v2a = oid();
    ids.v2b = oid();
    ids.fraud3 = oid();
    await col("versions").insertMany([
      v(ids.dupOld, 1, { _id: ids.v1, filePath: "D:\\old\\server\\uploads\\1791005212828-good_predictions.csv" }),
      v(ids.dupOld, 2, { _id: ids.v2a, createdAt: day(20) }),
      v(ids.dupOld, 2, { _id: ids.v2b, createdAt: day(21), status: "upload_failed", riskTier: null, metrics: {}, uploadError: "boom" }),
      v(ids.solo, 1),
      v(ids.solo, 2),
      v(ids.solo, 3, {
        _id: ids.fraud3, fileType: "joblib", riskTier: "high",
        filePath: "/srv/app/uploads/1791005213041-dummy_model.joblib",
        datasetPath: "/srv/app/uploads/1791005213042-model_dataset.csv",
      }),
    ]);
    await col("metricsnapshots").insertMany([
      { versionId: ids.v1, accuracy: 0.95, fairnessGap: 0.02, latencyMs: 10, driftDelta: 0, flagged: false, isBaseline: true, createdAt: day(11) },
      { versionId: ids.v1, accuracy: 0.6, fairnessGap: 0.02, latencyMs: 10, driftDelta: -0.35, flagged: true, isBaseline: false, createdAt: day(12) },
    ]);
    await col("users").insertOne({ name: "Old User", email: "old@user.test", passwordHash: "x", role: "ml_engineer", createdAt: day(1) });
  });

  test("backfills, renumbers duplicates, renames duplicate names, builds indexes", async () => {
    const summary = await runMigrations();
    expect(summary.join(" | ")).toMatch(/renamed 2 duplicate model name/);
    expect(summary.join(" | ")).toMatch(/created organization "Default Organization"/);

    // every legacy row now belongs to the one Default Organization
    const orgs = await col("organizations").find().toArray();
    expect(orgs).toHaveLength(1);
    ids.org = orgs[0]._id;
    for (const c of ["models", "versions", "metricsnapshots", "users"]) {
      expect(await col(c).countDocuments({ orgId: { $ne: ids.org } })).toBe(0);
    }

    // soft-delete flag everywhere
    for (const c of ["models", "versions"]) expect(await col(c).countDocuments({ isDeleted: { $exists: false } })).toBe(0);
    expect(await col("models").countDocuments({ isDeleted: true })).toBe(0);

    // duplicate names: oldest keeps its name, later ones get the next free " (n)" suffix
    const names = Object.fromEntries((await col("models").find().toArray()).map((m) => [String(m._id), m.name]));
    expect(names[ids.dupOld]).toBe("Credit Scorer");
    expect(names[ids.dupMid]).toBe("credit scorer (3)");
    expect(names[ids.taken2]).toBe("Credit Scorer (2)");
    expect(names[ids.dupNew]).toBe("CREDIT SCORER (4)");
    expect(names[ids.solo]).toBe("Fraud Detector");

    // duplicate version numbers: the oldest keeps 2, the later duplicate becomes 3
    const dupVersions = await col("versions").find({ modelId: ids.dupOld }).sort({ versionNumber: 1 }).toArray();
    expect(dupVersions.map((x) => [String(x._id), x.versionNumber])).toEqual([[String(ids.v1), 1], [String(ids.v2a), 2], [String(ids.v2b), 3]]);

    // versionSeq = max(versionNumber)
    const seq = Object.fromEntries((await col("models").find().toArray()).map((m) => [String(m._id), m.versionSeq]));
    expect(seq[ids.dupOld]).toBe(3);
    expect(seq[ids.solo]).toBe(3);
    expect(seq[ids.dupMid]).toBe(0);

    // version backfills
    const v1 = await col("versions").findOne({ _id: ids.v1 });
    expect(v1).toMatchObject({ initialRiskTier: "low", fileName: "good_predictions.csv", retryable: false });
    expect(v1.thresholdsUsed).toEqual({ lowAccuracy: 0.85, lowFairnessGap: 0.1, mediumAccuracy: 0.7, mediumFairnessGap: 0.2, driftThreshold: 0.1 });
    const failed = await col("versions").findOne({ _id: ids.v2b });
    expect(failed.initialRiskTier).toBeNull();
    const fraud3 = await col("versions").findOne({ _id: ids.fraud3 });
    expect(fraud3).toMatchObject({ initialRiskTier: "high", fileName: "dummy_model.joblib", datasetFileName: "model_dataset.csv" });

    // snapshot backfills
    const snaps = await col("metricsnapshots").find().sort({ createdAt: 1 }).toArray();
    expect(snaps[0]).toMatchObject({ source: "baseline", riskTier: "low", rows: null });
    expect(snaps[1]).toMatchObject({ source: "simulated", riskTier: "high" });

    // users
    expect(await col("users").findOne({ email: "old@user.test" })).toMatchObject({ isActive: true, status: "active", emailKey: "old@user.test", orgId: ids.org });

    // indexes
    const modelIdx = await col("models").indexes();
    const nameIdx = modelIdx.find((i) => i.key.name === 1);
    expect(nameIdx.key).toEqual({ orgId: 1, name: 1 });
    expect(nameIdx).toMatchObject({ unique: true, partialFilterExpression: { isDeleted: false }, collation: expect.objectContaining({ locale: "en", strength: 2 }) });
    const versionIdx = (await col("versions").indexes()).find((i) => i.key.modelId === 1 && i.key.versionNumber === 1);
    expect(versionIdx.unique).toBe(true);
    expect((await col("metricsnapshots").indexes()).some((i) => i.key.versionId === 1 && i.key.createdAt === 1)).toBe(true);
    expect((await col("users").indexes()).some((i) => i.key.email === 1 && i.unique)).toBe(true);
    expect((await col("auditlogs").indexes()).some((i) => i.key.seq === 1 && i.unique)).toBe(true);
  });

  test("is idempotent: a second run changes nothing", async () => {
    const before = JSON.stringify({
      m: await col("models").find().sort({ _id: 1 }).toArray(),
      v: await col("versions").find().sort({ _id: 1 }).toArray(),
    });
    const summary = await runMigrations();
    expect(summary).toEqual([]);
    const after = JSON.stringify({
      m: await col("models").find().sort({ _id: 1 }).toArray(),
      v: await col("versions").find().sort({ _id: 1 }).toArray(),
    });
    expect(after).toBe(before);
    await ensureIndexes(); // also safe on its own, repeatedly
  });

  test("new uploads continue after the legacy numbers; legacy duplicates now collide with new names", async () => {
    computeMetrics.mockResolvedValue(GOOD);
    const { token: engineer } = await makeUser("ml_engineer", { orgId: ids.org });
    const up = await uploadCsv(engineer, String(ids.dupOld));
    expect(up.status).toBe(201);
    expect(up.body.version.versionNumber).toBe(4);
    const up2 = await uploadCsv(engineer, String(ids.solo));
    expect(up2.body.version.versionNumber).toBe(4);
    // legacy rows are readable through the API (hasFile from the legacy path, names recovered)
    const list = await request(app).get(`/api/models/${ids.solo}/versions`).set("Authorization", `Bearer ${engineer}`);
    expect(list.status).toBe(200);
    const legacy = list.body.versions.find((v) => v.versionNumber === 3);
    expect(legacy).toMatchObject({ fileName: "dummy_model.joblib", hasFile: true, hasDataset: true, status: "draft" });
    expect(JSON.stringify(list.body)).not.toMatch(/filePath|datasetPath|\/srv\/app/);
    // the case-insensitive unique name index is live
    expect((await post(engineer, "/api/models", { name: "fraud DETECTOR" })).status).toBe(409);
  });
});

describe("runMigrations on an empty database", () => {
  test("works, builds indexes, and the app is usable afterwards", async () => {
    await wipe();
    const summary = await runMigrations();
    expect(summary).toEqual([]);
    expect((await col("models").indexes()).some((i) => i.key.name === 1 && i.unique)).toBe(true);
    expect(await col("organizations").countDocuments()).toBe(0); // no organization is invented
    const org = await makeOrg();
    const { token } = await makeUser("ml_engineer", { orgId: org._id });
    const model = await createModel(token, "Fresh model");
    computeMetrics.mockResolvedValue(GOOD);
    expect((await uploadCsv(token, model._id)).body.version.versionNumber).toBe(1);
    await runMigrations(); // and again with data present
  });
});
