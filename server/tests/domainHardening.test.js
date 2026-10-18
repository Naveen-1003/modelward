// Regression tests for the independent logic review of the models/versions domain
// (deploy race, drift acknowledgement, ownership, stale index, retry claim, ...).
jest.mock("../utils/metricsClient");

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../app");
const env = require("../config/env");
const Model = require("../models/Model");
const Version = require("../models/Version");
const MetricSnapshot = require("../models/MetricSnapshot");
const AuditLog = require("../models/AuditLog");
const computeMetrics = require("../utils/metricsClient");
const realMetricsClient = jest.requireActual("../utils/metricsClient");
const { UPLOAD_DIR } = require("../middleware/upload");
const { evaluateSnapshot } = require("../utils/drift");
const computeRiskTier = require("../utils/riskTier");
const scoreCompliance = require("../utils/compliance");
const { runCleanupOnce } = require("../jobs/cleanup");
const { runMigrations, ensureIndexes } = require("../migrations");
const { connect, reset, disconnect, makeUser, auth } = require("./helpers");
const { GOOD, BAD, CSV, createModel, uploadCsv, newVersion, post, get, approve, deploy } = require("./domainHelpers");

let eng, eng2, officer, admin, model;
const files = () => fs.readdirSync(UPLOAD_DIR).length;
const del = (token, url, body) => auth(request(app).delete(url), token).send(body || {});
const patch = (token, url, body) => auth(request(app).patch(url), token).send(body || {});
const batch = (token, id, buf = CSV) => auth(request(app).post(`/api/versions/${id}/monitoring-batch`), token).attach("file", buf, "b.csv");
const retryableErr = (msg = "Metrics service is unreachable, try again shortly") => Object.assign(new Error(msg), { retryable: true });
// clear models/versions/snapshots but keep the users (their tokens must stay valid)
const wipeDomain = async () => {
  for (const c of ["models", "versions", "metricsnapshots"]) await mongoose.connection.collection(c).deleteMany({});
};
const rawVersion = (id) => Version.findById(id).setOptions({ includeDeleted: true }).lean();

beforeAll(async () => {
  await connect();
  await reset();
  eng = (await makeUser("ml_engineer")).token;
  eng2 = (await makeUser("ml_engineer")).token;
  officer = (await makeUser("compliance_officer")).token;
  admin = (await makeUser("admin")).token;
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnect();
});
beforeEach(async () => {
  computeMetrics.mockReset();
  computeMetrics.mockResolvedValue(GOOD);
  model = await createModel(eng);
});
afterEach(() => {
  jest.restoreAllMocks();
  env.storageMode = "local";
});

// ---------------------------------------------------------------------------
describe("1. deploy race", () => {
  test("many concurrent deploys of one version leave exactly one live version", async () => {
    const old = await deploy(eng, officer, (await newVersion(eng, model._id))._id);
    const next = await newVersion(eng, model._id);
    await approve(eng, officer, next._id);
    for (let round = 0; round < 12; round += 1) {
      await Version.updateOne({ _id: next._id }, { $set: { status: "approved", deployedAt: null } });
      await Version.updateOne({ _id: old._id }, { $set: { status: "deployed" } });
      const rs = await Promise.all(Array.from({ length: 6 }, (_, k) => post(k % 2 ? officer : admin, `/api/versions/${next._id}/deploy`)));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      const live = await Version.find({ modelId: model._id, status: { $in: ["deployed", "needs_review"] } }).lean();
      expect(live.map((v) => String(v._id))).toEqual([next._id]);
    }
  });

  test("two DIFFERENT approved versions deployed at once: exactly one survives, never zero", async () => {
    const a = await newVersion(eng, model._id);
    const b = await newVersion(eng, model._id);
    await approve(eng, officer, a._id);
    await approve(eng, officer, b._id);
    for (let round = 0; round < 8; round += 1) {
      await Version.updateMany({ _id: { $in: [a._id, b._id] } }, { $set: { status: "approved", deployedAt: null } });
      const rs = await Promise.all([post(officer, `/api/versions/${a._id}/deploy`), post(admin, `/api/versions/${b._id}/deploy`)]);
      expect(rs.every((r) => [200, 409].includes(r.status))).toBe(true);
      const live = await Version.find({ modelId: model._id, status: { $in: ["deployed", "needs_review"] } }).lean();
      expect(live).toHaveLength(1);
      expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("a lost deploy changes nothing else and each superseded version is audited", async () => {
    const old = await deploy(eng, officer, (await newVersion(eng, model._id))._id);
    const next = await newVersion(eng, model._id);
    await approve(eng, officer, next._id);
    expect((await post(officer, `/api/versions/${next._id}/deploy`)).status).toBe(200);
    expect((await post(officer, `/api/versions/${next._id}/deploy`)).status).toBe(400);
    expect((await Version.findById(old._id)).status).toBe("superseded");
    expect(await AuditLog.countDocuments({ targetId: old._id, action: "deploy", details: /Superseded by v2/ })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("2. resolve-review keep resolves the drift", () => {
  let live;
  beforeEach(async () => {
    live = await deploy(eng, officer, (await newVersion(eng, model._id))._id);
    computeMetrics.mockResolvedValue({ ...BAD, rows: 50 }); // far from GOOD -> flagged + escalated
    const flagged = await batch(eng, live._id);
    expect(flagged.status).toBe(201);
    expect(flagged.body.snapshot.flagged).toBe(true);
    expect(flagged.body.version.status).toBe("needs_review");
  });
  const driftClear = async () => (await get(officer, `/api/versions/${live._id}`)).body.compliance.checks.find((c) => c.key === "drift_clear");

  test("keep: compliance no longer penalised, next snapshot at the accepted level is not flagged", async () => {
    expect((await driftClear()).passed).toBe(false);
    const keep = await post(officer, `/api/versions/${live._id}/resolve-review`, { decision: "keep", comment: "accepted" });
    expect(keep.status).toBe(200);
    expect(keep.body.version.status).toBe("deployed");
    expect(keep.body.version.driftAckAt).toBeTruthy();
    expect(keep.body.version.driftAckSnapshotId).toBeUndefined(); // internal
    expect((await driftClear()).passed).toBe(true); // latest snapshot is flagged but acknowledged

    const again = await batch(eng, live._id); // same (bad) metrics: no drift from the NEW baseline, tier not worse
    expect(again.status).toBe(201);
    expect(again.body.snapshot.flagged).toBe(false);
    expect(again.body.version.status).toBe("deployed");
    expect((await driftClear()).passed).toBe(true);
    // the original baseline snapshot is untouched
    const base = await MetricSnapshot.findOne({ versionId: live._id, isBaseline: true });
    expect(base.accuracy).toBeCloseTo(GOOD.accuracy, 5);
  });

  test("further drift beyond the threshold from the NEW baseline flags again", async () => {
    await post(officer, `/api/versions/${live._id}/resolve-review`, { decision: "keep", comment: "accepted" }).expect(200);
    computeMetrics.mockResolvedValue({ ...BAD, accuracy: BAD.accuracy - 0.2, rows: 50 });
    const worse = await batch(eng, live._id);
    expect(worse.body.snapshot.flagged).toBe(true);
    expect(worse.body.version.status).toBe("needs_review");
    expect((await driftClear()).passed).toBe(false);
  });

  test("retire does not store an acknowledgement", async () => {
    const r = await post(officer, `/api/versions/${live._id}/resolve-review`, { decision: "retire", comment: "bad" });
    expect(r.body.version.driftAckAt).toBeNull();
  });
});

describe("2b. pure: acknowledgement in compliance", () => {
  const snap = (id, flagged, createdAt) => ({ _id: id, flagged, createdAt: new Date(createdAt) });
  test("drift_clear ignores flagged snapshots at/before the acknowledgement", () => {
    const v = { riskTier: "medium", status: "deployed", metrics: { accuracy: 0.9 }, reviewComment: "x", driftAckSnapshotId: "s2", driftAckSnapshotAt: new Date(2000) };
    const clear = (latest, over = {}) => scoreCompliance({ ...v, ...over }, latest).checks.find((c) => c.key === "drift_clear").passed;
    expect(clear(snap("s2", true, 2000))).toBe(true); // the acknowledged snapshot itself
    expect(clear(snap("s1", true, 1000))).toBe(true); // older
    expect(clear(snap("s3", true, 3000))).toBe(false); // newer flag counts
    expect(clear(snap("s3", false, 3000))).toBe(true);
    expect(clear(snap("s2", true, 2000), { driftAckSnapshotId: null, driftAckSnapshotAt: null })).toBe(false);
    expect(clear(snap("s2", true, 2000), { status: "needs_review" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("3. owner-only mutations", () => {
  test("a different ml_engineer gets 403 on notes / submit / withdraw / retry; the owner succeeds", async () => {
    const v = await newVersion(eng, model._id);
    const r1 = await patch(eng2, `/api/versions/${v._id}/notes`, { datasetNotes: "hacked" });
    expect(r1.status).toBe(403);
    expect(r1.body.error).toMatch(/Only the engineer who uploaded this version/);
    expect((await post(eng2, `/api/versions/${v._id}/submit`)).status).toBe(403);
    expect((await Version.findById(v._id)).status).toBe("draft");
    expect((await patch(eng, `/api/versions/${v._id}/notes`, { datasetNotes: "mine" })).status).toBe(200);
    expect((await post(eng, `/api/versions/${v._id}/submit`)).status).toBe(200);
    expect((await post(eng2, `/api/versions/${v._id}/withdraw`)).status).toBe(403);
    expect((await Version.findById(v._id)).status).toBe("submitted");
    expect((await post(eng, `/api/versions/${v._id}/withdraw`)).status).toBe(200);

    computeMetrics.mockRejectedValue(retryableErr());
    const failed = await newVersion(eng, model._id);
    computeMetrics.mockResolvedValue(GOOD);
    expect((await post(eng2, `/api/versions/${failed._id}/retry`)).status).toBe(403);
    expect((await Version.findById(failed._id)).retryable).toBe(true); // 403 did not claim it
    expect((await post(eng, `/api/versions/${failed._id}/retry`)).status).toBe(200);
  });

  test("any ml_engineer may still upload to a shared model", async () => {
    const res = await uploadCsv(eng2, model._id);
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
describe("4. null thresholds never override defaults", () => {
  test("evaluateSnapshot / computeRiskTier ignore null fields in either threshold object", () => {
    const nulls = { lowAccuracy: null, lowFairnessGap: null, mediumAccuracy: null, mediumFairnessGap: null, driftThreshold: null };
    const r = evaluateSnapshot({ baseline: { accuracy: 0.95, fairnessGap: 0.02 }, metrics: { accuracy: 0.94, fairnessGap: 0.02 }, version: { riskTier: "low", thresholdsUsed: nulls }, thresholds: nulls });
    expect(r).toMatchObject({ riskTier: "low", flagged: false, escalated: false });
    expect(computeRiskTier({ accuracy: 0.95, fairnessGap: 0.02 }, nulls)).toBe("low");
  });

  test("simulate-drift on a version whose thresholdsUsed are all null behaves like defaults", async () => {
    const live = await deploy(eng, officer, (await newVersion(eng, model._id))._id);
    await Version.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(live._id) },
      { $set: { thresholdsUsed: { lowAccuracy: null, lowFairnessGap: null, mediumAccuracy: null, mediumFairnessGap: null, driftThreshold: null } } }
    );
    jest.spyOn(Math, "random").mockReturnValue(0.5); // accuracy -0.01
    const r = await post(eng, `/api/versions/${live._id}/simulate-drift`);
    expect(r.status).toBe(201);
    expect(r.body.snapshot).toMatchObject({ flagged: false, riskTier: "low" });
  });
});

// ---------------------------------------------------------------------------
describe("5. stale legacy name_1 index", () => {
  test("ensureIndexes drops a plain {name:1} index and recreates the collated partial one", async () => {
    const coll = mongoose.connection.collection("models");
    await coll.dropIndex("name_1").catch(() => {});
    await coll.createIndex({ name: 1 }, { unique: true, name: "name_1" });
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await runMigrations();
    const idx = (await coll.indexes()).filter((i) => i.name === "name_1");
    expect(idx).toHaveLength(1);
    expect(idx[0].collation).toMatchObject({ locale: "en", strength: 2 });
    expect(idx[0].partialFilterExpression).toEqual({ isDeleted: false });
    // an archived name is reusable and case variants are rejected again
    const m = await createModel(eng, "Legacy Index Model");
    await del(admin, `/api/models/${m._id}`).expect(200);
    expect((await auth(request(app).post("/api/models"), eng).send({ name: "Legacy Index Model" })).status).toBe(201);
    expect((await auth(request(app).post("/api/models"), eng).send({ name: "LEGACY INDEX MODEL" })).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe("6. cleanup marks purged upload_failed versions unretryable", () => {
  test("retryable:false (uploadError kept) once the files are purged", async () => {
    computeMetrics.mockRejectedValue(retryableErr("down for a while"));
    const v = await newVersion(eng, model._id);
    expect(v.retryable).toBe(true);
    await Version.collection.updateOne({ _id: new mongoose.Types.ObjectId(v._id) }, { $set: { updatedAt: new Date(Date.now() - 40 * 864e5) } });
    await runCleanupOnce();
    const row = await rawVersion(v._id);
    expect(row).toMatchObject({ status: "upload_failed", retryable: false, filePath: null, uploadError: "down for a while" });
    const r = await post(eng, `/api/versions/${v._id}/retry`);
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("7. metricsClient", () => {
  let server;
  let calls;
  let handler;
  let tmp;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      calls.push({ url: req.url, secret: req.headers["x-metrics-secret"] });
      req.resume();
      req.on("end", () => handler(req, res));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    tmp = path.join(os.tmpdir(), `hardening-mc-${Date.now()}.csv`);
    fs.writeFileSync(tmp, "predicted,actual,protected_attribute\n0,0,1\n");
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.unlinkSync(tmp);
  });
  beforeEach(() => {
    calls = [];
    realMetricsClient._resetForTests();
    env.metricsUrl = `http://127.0.0.1:${server.address().port}`;
    env.metricsSecret = "SUPER-SECRET";
    env.metricsWakeTimeoutMs = 0;
    env.metricsTimeoutMs = 5000;
  });
  afterEach(() => {
    env.metricsSecret = "";
    env.metricsWakeTimeoutMs = 0;
  });
  const send = (status, body = { error: "x" }) => (req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const run = () => realMetricsClient({ fileType: "csv", primaryFilePath: tmp, datasetFilePath: null }).then((r) => ({ ok: r }), (e) => ({ err: e }));

  test.each([404, 408, 425, 429])("HTTP %i is retryable", async (code) => {
    handler = send(code);
    const r = await run();
    expect(r.err.retryable).toBe(true);
  });
  test.each([422, 418])("other 4xx (%i) stays non-retryable", async (code) => {
    handler = send(code);
    expect((await run()).err.retryable).toBe(false);
  });

  test("the /health wake probe does not carry the shared secret (the scoring call does)", async () => {
    env.metricsWakeTimeoutMs = 3000;
    handler = (req, res) => {
      if (req.url === "/health") return send(200, { ok: true })(req, res);
      return send(200, { accuracy: 0.9, fairness_gap: 0.05 })(req, res);
    };
    const r = await run();
    expect(r.ok).toBeTruthy();
    const health = calls.find((c) => c.url === "/health");
    const score = calls.find((c) => c.url === "/compute-metrics");
    expect(health.secret).toBeUndefined();
    expect(score.secret).toBe("SUPER-SECRET");
  });

  test.each([
    ["accuracy", { accuracy: 1.7, fairness_gap: 0.1 }],
    ["fairness_gap", { accuracy: 0.9, fairness_gap: -3 }],
    ["auc", { accuracy: 0.9, fairness_gap: 0.1, auc: 2 }],
    ["precision", { accuracy: 0.9, fairness_gap: 0.1, precision: -0.1 }],
    ["group tpr", { accuracy: 0.9, fairness_gap: 0.1, groups: [{ group: "a", tpr: 1.5 }] }],
    ["infinity", '{"accuracy":1e999,"fairness_gap":0.1}'],
  ])("out-of-range %s is rejected non-retryably", async (_label, body) => {
    handler = send(200, body);
    const r = await run();
    expect(r.err.message).toBe("Metrics service returned out-of-range values");
    expect(r.err.retryable).toBe(false);
  });

  test("in-range values and null optionals still pass", async () => {
    handler = send(200, { accuracy: 0, fairness_gap: 1, f1: null, auc: 1, groups: [{ group: 1, accuracy: 0.5, positive_rate: 0, tpr: null }] });
    const r = await run();
    expect(r.ok).toMatchObject({ accuracy: 0, fairnessGap: 1, f1: null, auc: 1 });
  });
});

// ---------------------------------------------------------------------------
describe("8. JSON does not leak soft-delete internals", () => {
  test("version and model JSON; trash still exposes archive details", async () => {
    const v = await newVersion(eng, model._id);
    const detail = (await get(eng, `/api/versions/${v._id}`)).body.version;
    for (const k of ["isDeleted", "deletedAt", "deletedBy", "deletedByCascade", "deleteReason", "filePath", "datasetPath", "__v", "retryClaimedAt", "driftAckSnapshotId"]) {
      expect(detail).not.toHaveProperty(k);
    }
    expect(detail).toHaveProperty("driftAckAt", null);
    const m = (await get(eng, `/api/models/${model._id}`)).body.model;
    for (const k of ["versionSeq", "isDeleted", "deletedAt", "deletedBy", "deletedByCascade", "deleteReason", "__v"]) expect(m).not.toHaveProperty(k);
    const list = (await get(eng, "/api/models")).body.models[0];
    expect(list).not.toHaveProperty("versionSeq");

    await del(eng, `/api/versions/${v._id}`, { reason: "obsolete" }).expect(200);
    const trash = (await get(admin, "/api/trash")).body;
    expect(trash.versions.find((x) => x._id === v._id)).toMatchObject({ deleteReason: "obsolete", deletedByCascade: false, deletedAt: expect.any(String) });
    const restored = await post(eng, `/api/versions/${v._id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.version).not.toHaveProperty("isDeleted");
  });
});

// ---------------------------------------------------------------------------
describe("9. retry claim cannot strand a version", () => {
  let failed;
  beforeEach(async () => {
    computeMetrics.mockRejectedValue(retryableErr());
    failed = await newVersion(eng, model._id);
    computeMetrics.mockResolvedValue(GOOD);
  });

  test("an exception after the claim releases it (still upload_failed + retryable, no stray baseline)", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(MetricSnapshot, "create").mockRejectedValueOnce(new Error("db hiccup"));
    const r = await post(eng, `/api/versions/${failed._id}/retry`);
    expect(r.status).toBe(500);
    const row = await rawVersion(failed._id);
    expect(row).toMatchObject({ status: "upload_failed", retryable: true, retryClaimedAt: null });
    expect(await MetricSnapshot.countDocuments({ versionId: failed._id })).toBe(0);
    const again = await post(eng, `/api/versions/${failed._id}/retry`);
    expect(again.status).toBe(200);
    expect(again.body.version.status).toBe("draft");
    expect(await MetricSnapshot.countDocuments({ versionId: failed._id })).toBe(1);
  });

  test("a fresh claim blocks; a claim older than 5 minutes is taken over", async () => {
    await Version.updateOne({ _id: failed._id }, { $set: { retryable: false, retryClaimedAt: new Date() } });
    expect((await post(eng, `/api/versions/${failed._id}/retry`)).status).toBe(400);
    await Version.updateOne({ _id: failed._id }, { $set: { retryClaimedAt: new Date(Date.now() - 6 * 60 * 1000) } });
    const r = await post(eng, `/api/versions/${failed._id}/retry`);
    expect(r.status).toBe(200);
    expect(r.body.version.status).toBe("draft");
    expect(await rawVersion(failed._id)).toMatchObject({ retryClaimedAt: null });
  });

  test("a non-retryable failure (no claim stamp) stays unretryable", async () => {
    computeMetrics.mockRejectedValue(Object.assign(new Error("bad cols"), { retryable: false }));
    const v = await newVersion(eng, model._id);
    expect((await post(eng, `/api/versions/${v._id}/retry`)).status).toBe(400);
  });

  test("a retry that fails retryably gives the claim back", async () => {
    computeMetrics.mockRejectedValue(retryableErr("still down"));
    const r = await post(eng, `/api/versions/${failed._id}/retry`);
    expect(r.status).toBe(200);
    expect(r.body.version).toMatchObject({ status: "upload_failed", retryable: true, uploadError: "still down" });
  });
});

// ---------------------------------------------------------------------------
describe("10. queue excludes archived models; archive cascade is resilient", () => {
  test("versions of an archived model never show up (and total matches)", async () => {
    const v = await newVersion(eng, model._id);
    await post(eng, `/api/versions/${v._id}/submit`).expect(200);
    const other = await createModel(eng);
    const ov = await newVersion(eng, other._id);
    await post(eng, `/api/versions/${ov._id}/submit`).expect(200);
    // archive the MODEL only (no cascade) to prove the filter itself works
    await Model.updateOne({ _id: model._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
    const q = await get(officer, "/api/versions?status=submitted&limit=100");
    expect(q.status).toBe(200);
    expect(q.body.versions.every((x) => x.modelId && x.modelId.name)).toBe(true);
    expect(q.body.versions.map((x) => x._id)).toContain(ov._id);
    expect(q.body.versions.map((x) => x._id)).not.toContain(v._id);
    expect(q.body.total).toBe(q.body.versions.length);
    const byName = await get(officer, `/api/versions?q=${encodeURIComponent(other.name)}`);
    expect(byName.body.versions.map((x) => x._id)).toEqual(expect.arrayContaining([ov._id]));
  });

  test("a failing cascade reverts the model archive flag", async () => {
    await newVersion(eng, model._id);
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(Version, "updateMany").mockRejectedValueOnce(new Error("cascade boom"));
    const r = await del(admin, `/api/models/${model._id}`);
    expect(r.status).toBe(500);
    expect((await get(eng, `/api/models/${model._id}`)).status).toBe(200);
    expect((await get(eng, `/api/models/${model._id}/versions`)).body.versions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("11. a version archived mid-request is a clean 409, not a 500", () => {
  test("simulate-drift", async () => {
    const live = await deploy(eng, officer, (await newVersion(eng, model._id))._id);
    const realCreate = MetricSnapshot.create.bind(MetricSnapshot);
    jest.spyOn(MetricSnapshot, "create").mockImplementationOnce(async (doc) => {
      const s = await realCreate(doc);
      await Version.collection.updateOne({ _id: new mongoose.Types.ObjectId(live._id) }, { $set: { isDeleted: true } });
      return s;
    });
    const r = await post(eng, `/api/versions/${live._id}/simulate-drift`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/archived/);
  });
});

// ---------------------------------------------------------------------------
describe("12. migrations", () => {
  const col = (n) => mongoose.connection.collection(n);
  const U = new mongoose.Types.ObjectId();

  test("duplicate-name dedupe follows case + trailing-space semantics, then the unique index builds", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    await wipeDomain();
    await col("models").dropIndex("name_1").catch(() => {}); // legacy rows would violate it
    await col("models").insertMany([
      { name: "Acme Scorer", createdBy: U, createdAt: new Date(1000) },
      { name: "acme scorer ", createdBy: U, createdAt: new Date(2000) },
      { name: "ACME SCORER", createdBy: U, createdAt: new Date(3000) },
      { name: "Acme Scorer (2)", createdBy: U, createdAt: new Date(4000) },
    ]);
    const summary = await runMigrations();
    expect(summary.join(";")).toMatch(/renamed 2 duplicate model name/);
    const names = (await col("models").find().sort({ createdAt: 1 }).toArray()).map((m) => m.name);
    expect(names[0]).toBe("Acme Scorer");
    expect(names[1]).toBe("acme scorer (3)"); // trimmed, "(2)" already taken
    expect(names[2]).toBe("ACME SCORER (4)");
    expect(names[3]).toBe("Acme Scorer (2)");
    const idx = (await col("models").indexes()).find((i) => i.name === "name_1");
    expect(idx).toMatchObject({ unique: true });
  });

  test("an unexpected E11000 while building an index logs loudly and does not abort", async () => {
    const err = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    jest.spyOn(Model, "createIndexes").mockRejectedValueOnce(err);
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(ensureIndexes()).resolves.toBeUndefined();
    expect(spy.mock.calls.flat().join(" ")).toMatch(/WARNING: could not build a unique index on Model/);
  });

  test("legacy unknown statuses are left alone but counted in a warning", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const m = await createModel(eng);
    await col("versions").insertOne({ modelId: new mongoose.Types.ObjectId(m._id), versionNumber: 99, fileType: "csv", status: "weird_legacy", createdBy: U, isDeleted: false });
    await runMigrations();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/1 version\(s\) have a status outside the known set/);
    expect((await col("versions").findOne({ versionNumber: 99 })).status).toBe("weird_legacy");
  });
});

// ---------------------------------------------------------------------------
describe("13. stats stay exact with archived models", () => {
  test("archived models/versions are excluded from counts and lists", async () => {
    await wipeDomain();
    const m1 = await createModel(eng);
    const v1 = await newVersion(eng, m1._id);
    await post(eng, `/api/versions/${v1._id}/submit`).expect(200);
    const m2 = await createModel(eng);
    const v2 = await newVersion(eng, m2._id);
    await post(eng, `/api/versions/${v2._id}/submit`).expect(200);
    await del(admin, `/api/models/${m2._id}`).expect(200);
    const s = (await get(eng, "/api/stats")).body;
    expect(s.totals).toMatchObject({ models: 1, versions: 1, awaitingReview: 1 });
    expect(s.byTier).toEqual({ low: 1, medium: 0, high: 0, unrated: 0 });
    expect(s.awaitingReview.map((x) => x.versionId)).toEqual([v1._id]);
    expect(s.awaitingReview[0].modelName).toBe(m1.name);
  });
});

// ---------------------------------------------------------------------------
describe("14. no scored version without a baseline snapshot", () => {
  test("a failing baseline insert on upload removes the version row and the files, returns 500", async () => {
    const before = files();
    const countBefore = await Version.countDocuments({ modelId: model._id }).setOptions({ includeDeleted: true });
    jest.spyOn(MetricSnapshot, "create").mockRejectedValueOnce(new Error("db down"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    const r = await uploadCsv(eng, model._id);
    expect(r.status).toBe(500);
    expect(await Version.countDocuments({ modelId: model._id }).setOptions({ includeDeleted: true })).toBe(countBefore);
    expect(files()).toBe(before);
    // and the next upload works
    const ok = await uploadCsv(eng, model._id);
    expect(ok.status).toBe(201);
    expect(await MetricSnapshot.countDocuments({ versionId: ok.body.version._id })).toBe(1);
  });
});
