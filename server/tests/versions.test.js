jest.mock("../utils/metricsClient");

const fs = require("fs");
const request = require("supertest");
const app = require("../app");
const env = require("../config/env");
const computeMetrics = require("../utils/metricsClient");
const { UPLOAD_DIR } = require("../middleware/upload");
const { evaluateSnapshot } = require("../utils/drift");
const { tierRank, worseThan } = require("../utils/riskTier");
const scoreCompliance = require("../utils/compliance");
const { connect, reset, disconnect, makeUser, auth, sys } = require("./helpers");
// direct DB access in this file is cross-tenant on purpose (sys = bypassTenant)
const Version = sys(require("../models/Version"));
const MetricSnapshot = sys(require("../models/MetricSnapshot"));
const AuditLog = sys(require("../models/AuditLog"));
const { metrics, GOOD, MEDIUM, BAD, CSV, createModel, uploadCsv, newVersion, post, get, approve, deploy } = require("./domainHelpers");

let engineer, engineerUser, engineer2, officer, admin, model;

const files = () => fs.readdirSync(UPLOAD_DIR).length;
const audit = async (targetId) => (await AuditLog.find({ targetId }).sort({ createdAt: 1, seq: 1 }).lean()).map((a) => a.action);
const retryableErr = (msg = "Metrics service is unreachable, try again shortly") => Object.assign(new Error(msg), { retryable: true });
const userErr = (msg = "CSV is missing required column(s): actual") => Object.assign(new Error(msg), { retryable: false });
const dataset = Buffer.from("actual,protected_attribute,f1\n0,0,1\n");

beforeAll(async () => {
  await connect();
  await reset();
  ({ token: engineer, user: engineerUser } = await makeUser("ml_engineer"));
  engineer2 = (await makeUser("ml_engineer")).token;
  officer = (await makeUser("compliance_officer")).token;
  admin = (await makeUser("admin")).token;
});
afterAll(disconnect);

beforeEach(async () => {
  computeMetrics.mockReset();
  computeMetrics.mockResolvedValue(GOOD);
  model = await createModel(engineer);
});
afterEach(() => {
  jest.restoreAllMocks();
  env.storageMode = "local";
  env.allowModelFiles = true;
  env.enableDriftSimulation = true;
});

// ---------------------------------------------------------------------------
describe("upload", () => {
  test("csv happy path: scored draft, baseline snapshot, clean JSON, audit", async () => {
    const res = await uploadCsv(engineer, model._id, { fields: { datasetNotes: "ds", trainingNotes: "tr" } });
    expect(res.status).toBe(201);
    const v = res.body.version;
    expect(v).toMatchObject({
      modelId: model._id,
      versionNumber: 1,
      fileType: "csv",
      fileName: "preds.csv",
      datasetFileName: null,
      hasFile: true,
      hasDataset: false,
      status: "draft",
      riskTier: "low",
      initialRiskTier: "low",
      uploadError: null,
      retryable: false,
      datasetNotes: "ds",
      trainingNotes: "tr",
      createdByName: engineerUser.name,
      reviewedAt: null,
      deployedAt: null,
    });
    expect(v.createdBy).toBe(String(engineerUser._id));
    expect(v.metrics).toMatchObject({ accuracy: 0.95, fairnessGap: 0.02, latencyMs: 12, computedBy: "self_reported", rows: 200 });
    expect(v.metrics.groups).toEqual([{ group: "0", count: 100, accuracy: 0.95, positiveRate: 0.5, tpr: 0.9 }]);
    expect(v.thresholdsUsed).toEqual({ lowAccuracy: 0.85, lowFairnessGap: 0.1, mediumAccuracy: 0.7, mediumFairnessGap: 0.2, driftThreshold: 0.1 });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/filePath|datasetPath|__v|uploads|modelward-test/);

    const detail = await get(engineer, `/api/versions/${v._id}`);
    expect(detail.body.snapshots).toHaveLength(1);
    expect(detail.body.snapshots[0]).toMatchObject({ isBaseline: true, source: "baseline", riskTier: "low", rows: 200, driftDelta: 0, flagged: false, createdByName: engineerUser.name });
    expect(JSON.stringify(detail.body)).not.toMatch(/filePath|datasetPath|__v/);
    expect(await audit(v._id)).toEqual(["upload_version"]);
    expect(computeMetrics.mock.calls[0][0]).toMatchObject({ fileType: "csv", datasetFilePath: null });
    expect(typeof computeMetrics.mock.calls[0][0].primaryFilePath).toBe("string");
  });

  test("risk tier is computed server-side, scoring warnings are kept", async () => {
    computeMetrics.mockResolvedValue({ ...BAD, warnings: ["small group"] });
    const v = await newVersion(engineer, model._id);
    expect(v).toMatchObject({ riskTier: "high", scoringWarnings: ["small group"] });
    computeMetrics.mockResolvedValue(MEDIUM);
    expect((await newVersion(engineer, model._id)).riskTier).toBe("medium");
  });

  test("an unknown extra tier field cannot be injected", async () => {
    const res = await uploadCsv(engineer, model._id, { fields: { riskTier: "low", status: "approved" } });
    expect(res.status).toBe(201);
    expect(res.body.version.status).toBe("draft");
  });

  test("version numbers are sequential, atomic under parallel uploads, and not burned by validation errors", async () => {
    expect((await newVersion(engineer, model._id)).versionNumber).toBe(1);
    expect((await uploadCsv(engineer, model._id, { latencyMs: "abc" })).status).toBe(400);
    expect((await uploadCsv(engineer, model._id, { filename: "x.txt" })).status).toBe(400);
    expect((await newVersion(engineer, model._id)).versionNumber).toBe(2);
    const results = await Promise.all(Array.from({ length: 6 }, () => uploadCsv(engineer, model._id)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    const nums = results.map((r) => r.body.version.versionNumber).sort((a, b) => a - b);
    expect(nums).toEqual([3, 4, 5, 6, 7, 8]);
  });

  test.each([
    ["missing", null],
    ["empty", ""],
    ["blank", "  "],
    ["text", "abc"],
    ["negative", "-5"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["1e999", "1e999"],
    ["too large", "600001"],
    ["hex", "0x10"],
  ])("csv latencyMs %s is rejected", async (_label, latencyMs) => {
    const before = files();
    const res = await uploadCsv(engineer, model._id, { latencyMs });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/latencyMs/);
    expect(files()).toBe(before); // temp upload removed
    expect(computeMetrics).not.toHaveBeenCalled();
  });

  test.each([["0", 0], ["600000", 600000], ["12.5", 12.5], ["1e2", 100]])("csv latencyMs %s is accepted", async (raw, num) => {
    const res = await uploadCsv(engineer, model._id, { latencyMs: raw });
    expect(res.status).toBe(201);
    expect(res.body.version.metrics.latencyMs).toBe(num);
  });

  test("field and file validation matrix", async () => {
    const cases = [
      ["bad extension (csv)", uploadCsv(engineer, model._id, { filename: "preds.txt" })],
      ["pickle named .csv", auth(request(app).post(`/api/models/${model._id}/versions`), engineer).field("fileType", "pickle").attach("file", CSV, "m.csv").attach("datasetFile", dataset, "d.csv")],
      ["pickle without dataset", auth(request(app).post(`/api/models/${model._id}/versions`), engineer).field("fileType", "pickle").attach("file", Buffer.from("x"), "m.pkl")],
      ["dataset not csv", auth(request(app).post(`/api/models/${model._id}/versions`), engineer).field("fileType", "joblib").attach("file", Buffer.from("x"), "m.joblib").attach("datasetFile", dataset, "d.txt")],
      ["bad fileType", auth(request(app).post(`/api/models/${model._id}/versions`), engineer).field("fileType", "exe").field("latencyMs", "1").attach("file", CSV, "a.csv")],
      ["missing fileType", auth(request(app).post(`/api/models/${model._id}/versions`), engineer).field("latencyMs", "1").attach("file", CSV, "a.csv")],
      ["no file", auth(request(app).post(`/api/models/${model._id}/versions`), engineer).field("fileType", "csv").field("latencyMs", "1")],
      ["unexpected file field", auth(request(app).post(`/api/models/${model._id}/versions`), engineer).field("fileType", "csv").field("latencyMs", "1").attach("evil", CSV, "a.csv")],
      ["notes too long", uploadCsv(engineer, model._id, { fields: { trainingNotes: "x".repeat(5001) } })],
      ["dataset notes too long", uploadCsv(engineer, model._id, { fields: { datasetNotes: "x".repeat(5001) } })],
    ];
    const before = files();
    for (const [label, req] of cases) {
      const res = await req;
      expect([label, res.status]).toEqual([label, 400]);
      expect(typeof res.body.error).toBe("string");
    }
    expect(files()).toBe(before);
    expect(await Version.countDocuments({ modelId: model._id })).toBe(0);
  });

  test("a companion dataset sent with a csv upload is ignored and removed", async () => {
    const before = files();
    const res = await uploadCsv(engineer, model._id).attach("datasetFile", dataset, "d.csv");
    expect(res.status).toBe(201);
    expect(res.body.version).toMatchObject({ hasDataset: false, datasetFileName: null });
    expect(files()).toBe(before + 1);
  });

  test("model files: disabled => 400 with the metrics-service message; enabled => scored, latencyMs ignored", async () => {
    env.allowModelFiles = false;
    const pkl = () => auth(request(app).post(`/api/models/${model._id}/versions`), engineer).field("fileType", "pickle").attach("file", Buffer.from("x"), "m.pkl").attach("datasetFile", dataset, "d.csv");
    const off = await pkl();
    expect(off.status).toBe(400);
    expect(off.body.error).toBe("Model file uploads are disabled on this deployment; upload a predictions CSV instead");
    expect(computeMetrics).not.toHaveBeenCalled();

    env.allowModelFiles = true;
    computeMetrics.mockResolvedValue(metrics({ latencyMs: 8.1 }));
    const on = await pkl().field("latencyMs", "not-a-number");
    expect(on.status).toBe(201);
    expect(on.body.version).toMatchObject({ fileType: "pickle", fileName: "m.pkl", datasetFileName: "d.csv", hasFile: true, hasDataset: true });
    expect(on.body.version.metrics).toMatchObject({ latencyMs: 8.1, computedBy: "microservice" });
    expect(computeMetrics.mock.calls[0][0].datasetFilePath).toEqual(expect.any(String));
  });

  test("roles, missing and archived models", async () => {
    expect((await uploadCsv(officer, model._id)).status).toBe(403);
    expect((await uploadCsv(admin, model._id)).status).toBe(403);
    expect((await request(app).post(`/api/models/${model._id}/versions`)).status).toBe(401);
    expect((await uploadCsv(engineer, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".slice(0, 24))).status).toBe(404);
    expect((await uploadCsv(engineer, "bad-id")).status).toBe(400);
    await auth(request(app).delete(`/api/models/${model._id}`), admin).expect(200);
    const before = files();
    expect((await uploadCsv(engineer, model._id)).status).toBe(404);
    expect(files()).toBe(before);
  });

  test("oversize upload is 413 and leaves no file behind", async () => {
    const before = files();
    const res = await uploadCsv(engineer, model._id, { buffer: Buffer.alloc((env.maxUploadMb + 1) * 1024 * 1024, "a") });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
    expect(files()).toBe(before);
  });

  test("scoring failures are saved as upload_failed with a clean, classified message", async () => {
    computeMetrics.mockRejectedValueOnce(userErr());
    const a = await uploadCsv(engineer, model._id);
    expect(a.status).toBe(201);
    expect(a.body.version).toMatchObject({ status: "upload_failed", uploadError: "CSV is missing required column(s): actual", retryable: false, riskTier: null });

    computeMetrics.mockRejectedValueOnce(retryableErr());
    const b = await uploadCsv(engineer, model._id);
    expect(b.body.version).toMatchObject({ status: "upload_failed", retryable: true, versionNumber: 2 });

    // a bug-shaped error (no .retryable) must not leak its text
    computeMetrics.mockRejectedValueOnce(new Error("ECONNREFUSED http://127.0.0.1:8000 /secret/path"));
    const c = await uploadCsv(engineer, model._id);
    expect(c.body.version.status).toBe("upload_failed");
    expect(c.body.version.uploadError).toBe("Scoring failed unexpectedly, try again shortly");
    expect(c.body.version.retryable).toBe(true);
    expect(JSON.stringify(c.body)).not.toMatch(/127\.0\.0\.1|secret/);
    expect((await audit(c.body.version._id))).toEqual(["upload_version"]);
  });
});

// ---------------------------------------------------------------------------
describe("storage policy and retry", () => {
  test("discard mode: scored files are deleted, version has no file", async () => {
    env.storageMode = "discard";
    const before = files();
    const v = await newVersion(engineer, model._id);
    expect(v.hasFile).toBe(false);
    expect(files()).toBe(before);
  });

  test("discard mode: non-retryable failure deletes files, retryable failure keeps them for retry", async () => {
    env.storageMode = "discard";
    const before = files();
    computeMetrics.mockRejectedValueOnce(userErr());
    const dead = await newVersion(engineer, model._id);
    expect(dead).toMatchObject({ status: "upload_failed", retryable: false, hasFile: false });
    expect(files()).toBe(before);

    computeMetrics.mockRejectedValueOnce(retryableErr());
    const flaky = await newVersion(engineer, model._id);
    expect(flaky).toMatchObject({ status: "upload_failed", retryable: true, hasFile: true });
    expect(files()).toBe(before + 1);

    // retry succeeds -> scored, and in discard mode the file is removed afterwards
    const res = await post(engineer, `/api/versions/${flaky._id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.version).toMatchObject({ status: "draft", riskTier: "low", initialRiskTier: "low", uploadError: null, retryable: false, hasFile: false });
    expect(res.body.version.metrics.latencyMs).toBe(12); // self-reported latency survived the failure
    expect(files()).toBe(before);
    const detail = await get(engineer, `/api/versions/${flaky._id}`);
    expect(detail.body.snapshots).toHaveLength(1);
    expect(detail.body.snapshots[0].isBaseline).toBe(true);
    expect(await audit(flaky._id)).toEqual(["upload_version", "retry_version"]);
  });

  test("local mode keeps files even for scored / non-retryable failures", async () => {
    const before = files();
    computeMetrics.mockRejectedValueOnce(userErr());
    const v = await newVersion(engineer, model._id);
    expect(v.hasFile).toBe(true);
    await newVersion(engineer, model._id);
    expect(files()).toBe(before + 2);
  });

  test("retry guards: only upload_failed + retryable + stored files; role; repeated failure", async () => {
    const ok = await newVersion(engineer, model._id);
    expect((await post(engineer, `/api/versions/${ok._id}/retry`)).status).toBe(400); // not failed
    expect((await post(officer, `/api/versions/${ok._id}/retry`)).status).toBe(403);

    computeMetrics.mockRejectedValueOnce(userErr());
    const dead = await newVersion(engineer, model._id);
    const r1 = await post(engineer, `/api/versions/${dead._id}/retry`);
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/cannot be fixed by retrying/);

    computeMetrics.mockRejectedValueOnce(retryableErr());
    const flaky = await newVersion(engineer, model._id);
    computeMetrics.mockRejectedValueOnce(retryableErr("Metrics service timed out, try again shortly"));
    const again = await post(engineer, `/api/versions/${flaky._id}/retry`);
    expect(again.status).toBe(200);
    expect(again.body.version).toMatchObject({ status: "upload_failed", retryable: true, uploadError: "Metrics service timed out, try again shortly" });

    // after the files vanish the retry is refused
    const row = await Version.findById(flaky._id);
    fs.unlinkSync(row.filePath);
    const gone = await post(engineer, `/api/versions/${flaky._id}/retry`);
    expect(gone.status).toBe(400);
    expect(gone.body.error).toMatch(/no longer stored/);
  });

  test("two concurrent retries score once", async () => {
    computeMetrics.mockRejectedValueOnce(retryableErr());
    const flaky = await newVersion(engineer, model._id);
    computeMetrics.mockImplementation(() => new Promise((r) => setTimeout(() => r(GOOD), 150)));
    const rs = await Promise.all([post(engineer, `/api/versions/${flaky._id}/retry`), post(engineer, `/api/versions/${flaky._id}/retry`)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await MetricSnapshot.countDocuments({ versionId: flaky._id })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("read endpoints", () => {
  test("model versions list: newest first, names, archived hidden, 404 for unknown model", async () => {
    const v1 = await newVersion(engineer, model._id);
    const v2 = await newVersion(engineer, model._id);
    const v3 = await newVersion(engineer, model._id);
    await auth(request(app).delete(`/api/versions/${v2._id}`), engineer).send({ reason: "dup" }).expect(200);
    const res = await get(officer, `/api/models/${model._id}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.versions.map((v) => v.versionNumber)).toEqual([3, 1]);
    expect(res.body.versions[0].createdByName).toBe(engineerUser.name);
    expect(JSON.stringify(res.body)).not.toMatch(/filePath|datasetPath/);
    expect((await get(officer, "/api/models/aaaaaaaaaaaaaaaaaaaaaaaa/versions")).status).toBe(404);
    expect(v3.versionNumber).toBe(3);
    expect(v1.versionNumber).toBe(1);
  });

  test("queue endpoint: status filter, q by model name / version number, pagination, populated model", async () => {
    const m2 = await createModel(engineer, `Queue Target ${Date.now()}`);
    const a = await newVersion(engineer, m2._id); // v1 draft
    const b = await newVersion(engineer, m2._id); // v2 -> submitted
    await post(engineer, `/api/versions/${b._id}/submit`).expect(200);
    computeMetrics.mockRejectedValueOnce(userErr());
    const c = await newVersion(engineer, m2._id); // v3 upload_failed

    const sub = await get(officer, "/api/versions?status=submitted&q=Queue%20Target");
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ page: 1, limit: 20, total: 1, pages: 1 });
    expect(sub.body.versions[0]).toMatchObject({ _id: b._id, status: "submitted" });
    expect(sub.body.versions[0].modelId).toEqual({ _id: m2._id, name: m2.name });

    const two = await get(officer, `/api/versions?status=draft,upload_failed&q=${encodeURIComponent(m2.name)}`);
    expect(two.body.versions.map((v) => v._id).sort()).toEqual([a._id, c._id].sort());

    const byNum = await get(officer, `/api/versions?q=v3&status=upload_failed`);
    expect(byNum.body.versions.some((v) => v._id === c._id)).toBe(true);

    const paged = await get(officer, `/api/versions?q=${encodeURIComponent(m2.name)}&limit=2&page=2`);
    expect(paged.body).toMatchObject({ page: 2, limit: 2, total: 3, pages: 2 });
    expect(paged.body.versions).toHaveLength(1);
    expect(paged.body.versions[0]._id).toBe(a._id); // newest first => the oldest is on page 2

    expect((await get(officer, "/api/versions?status=bogus")).status).toBe(400);
    expect((await get(officer, "/api/versions?status=draft,bogus")).status).toBe(400);
    expect((await get(officer, "/api/versions?page=0")).status).toBe(400);
    expect((await request(app).get("/api/versions")).status).toBe(401);
    // archived versions never show up
    await auth(request(app).delete(`/api/versions/${a._id}`), engineer).expect(200);
    expect((await get(officer, `/api/versions?q=${encodeURIComponent(m2.name)}`)).body.total).toBe(2);
  });

  test("detail: populated model, compliance shape, snapshots, 400/404", async () => {
    const v = await newVersion(engineer, model._id);
    const res = await get(officer, `/api/versions/${v._id}`);
    expect(res.status).toBe(200);
    expect(res.body.version.modelId).toMatchObject({ _id: model._id, name: model.name });
    expect(res.body.compliance).toEqual({
      score: 50,
      checks: [
        { key: "metrics", label: expect.any(String), passed: true },
        { key: "approval", label: expect.any(String), passed: false },
      ],
      required: expect.any(Array),
    });
    expect((await get(officer, "/api/versions/xyz")).status).toBe(400);
    expect((await get(officer, "/api/versions/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe("review workflow", () => {
  test("full lifecycle: upload -> submit -> approve -> deploy -> retire, with audit trail and timestamps", async () => {
    const v = await newVersion(engineer, model._id);
    const submit = await post(engineer, `/api/versions/${v._id}/submit`);
    expect(submit.body.version.status).toBe("submitted");
    const review = await post(officer, `/api/versions/${v._id}/review`, { decision: "approve", comment: "  looks fine  " });
    expect(review.status).toBe(200);
    expect(review.body.version).toMatchObject({ status: "approved", reviewComment: "looks fine" });
    expect(review.body.version.reviewedAt).toEqual(expect.any(String));
    const dep = await post(officer, `/api/versions/${v._id}/deploy`);
    expect(dep.body.version.status).toBe("deployed");
    expect(dep.body.version.deployedAt).toEqual(expect.any(String));

    const detail = await get(officer, `/api/versions/${v._id}`);
    expect(detail.body.compliance.score).toBe(100);
    const ret = await post(admin, `/api/versions/${v._id}/retire`, { comment: "replaced by newer approach" });
    expect(ret.body.version.status).toBe("retired");
    expect(await audit(v._id)).toEqual(["upload_version", "submit_version", "approve", "deploy", "retire"]);
  });

  test("review comment rules", async () => {
    const mk = async (m = GOOD) => {
      computeMetrics.mockResolvedValue(m);
      const v = await newVersion(engineer, model._id);
      await post(engineer, `/api/versions/${v._id}/submit`).expect(200);
      return v;
    };
    const review = (id, body) => post(officer, `/api/versions/${id}/review`, body);

    const low = await mk(GOOD);
    expect((await review(low._id, { decision: "approve" })).status).toBe(200); // low risk: comment optional

    const rej = await mk(GOOD);
    for (const body of [{ decision: "reject" }, { decision: "reject", comment: "" }, { decision: "reject", comment: "   \n\t " }]) {
      expect((await review(rej._id, body)).status).toBe(400);
    }
    for (const comment of [123, {}, [], ["x"], true, null]) {
      expect([comment, (await review(rej._id, { decision: "reject", comment })).status]).toEqual([comment, 400]);
    }
    expect((await review(rej._id, { decision: "approve", comment: "x".repeat(2001) })).status).toBe(400);
    expect((await review(rej._id, { decision: "maybe", comment: "x" })).status).toBe(400);
    expect((await review(rej._id, {})).status).toBe(400);
    expect((await review(rej._id, { decision: "reject", comment: "no good" })).body.version.status).toBe("rejected");

    const rc = await mk(GOOD);
    expect((await review(rc._id, { decision: "request_changes", comment: " " })).status).toBe(400);
    expect((await review(rc._id, { decision: "request_changes" })).status).toBe(400);
    const ch = await review(rc._id, { decision: "request_changes", comment: "add dataset notes" });
    expect(ch.body.version).toMatchObject({ status: "changes_requested", reviewComment: "add dataset notes" });

    const high = await mk(BAD);
    expect(high.riskTier).toBe("high");
    expect((await review(high._id, { decision: "approve" })).status).toBe(400);
    expect((await review(high._id, { decision: "approve", comment: "   " })).status).toBe(400);
    const ok = await review(high._id, { decision: "approve", comment: "reviewed with mitigation plan" });
    expect(ok.status).toBe(200);
    const detail = await get(officer, `/api/versions/${high._id}`);
    expect(detail.body.compliance.checks.map((c) => c.key)).toEqual(["metrics", "documented_review_comment", "approval", "drift_clear"]);
    expect(detail.body.compliance.score).toBe(100);
    expect(await audit(rej._id)).toEqual(["upload_version", "submit_version", "reject"]);
    expect(await audit(rc._id)).toEqual(["upload_version", "submit_version", "request_changes"]);
  });

  test("request changes -> edit notes -> resubmit; withdraw; rejected is terminal", async () => {
    const v = await newVersion(engineer, model._id);
    await post(engineer, `/api/versions/${v._id}/submit`).expect(200);
    const wd = await post(engineer, `/api/versions/${v._id}/withdraw`);
    expect(wd.body.version.status).toBe("draft");
    await post(engineer, `/api/versions/${v._id}/submit`).expect(200);
    await post(officer, `/api/versions/${v._id}/review`, { decision: "request_changes", comment: "need notes" }).expect(200);

    const patch = (body, token = engineer) => auth(request(app).patch(`/api/versions/${v._id}/notes`), token).send(body);
    const ok = await patch({ datasetNotes: "  new ds notes ", trainingNotes: "tr" });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toMatchObject({ datasetNotes: "new ds notes", trainingNotes: "tr", status: "changes_requested" });
    expect((await patch({ datasetNotes: "only" })).body.version.trainingNotes).toBe("tr"); // untouched
    expect((await patch({})).status).toBe(400);
    expect((await patch({ datasetNotes: 5 })).status).toBe(400);
    expect((await patch({ trainingNotes: "x".repeat(5001) })).status).toBe(400);
    expect((await patch({ datasetNotes: "x" }, officer)).status).toBe(403);

    await post(engineer, `/api/versions/${v._id}/submit`).expect(200);
    expect((await patch({ datasetNotes: "locked while in review" })).status).toBe(400);
    await post(officer, `/api/versions/${v._id}/review`, { decision: "reject", comment: "no" }).expect(200);
    expect((await post(engineer, `/api/versions/${v._id}/submit`)).status).toBe(400);
    expect(await audit(v._id)).toEqual(["upload_version", "submit_version", "withdraw_version", "submit_version", "request_changes", "update_notes", "update_notes", "submit_version", "reject"]);
  });

  test("illegal transitions and wrong roles", async () => {
    const draft = await newVersion(engineer, model._id);
    const id = draft._id;
    const expectStatus = async (promise, status) => {
      const res = await promise;
      expect([res.status, res.body.error]).toEqual([status, expect.any(String)]);
      return res;
    };
    // illegal from draft
    const rv = await expectStatus(post(officer, `/api/versions/${id}/review`, { decision: "approve", comment: "x" }), 400);
    expect(rv.body.currentStatus).toBe("draft");
    await expectStatus(post(officer, `/api/versions/${id}/deploy`), 400);
    await expectStatus(post(admin, `/api/versions/${id}/deploy`), 400);
    await expectStatus(post(officer, `/api/versions/${id}/retire`, { comment: "x" }), 400);
    await expectStatus(post(officer, `/api/versions/${id}/resolve-review`, { decision: "keep", comment: "x" }), 400);
    await expectStatus(post(engineer, `/api/versions/${id}/withdraw`), 400);
    await expectStatus(post(engineer, `/api/versions/${id}/simulate-drift`), 400);
    // wrong role
    await expectStatus(post(officer, `/api/versions/${id}/submit`), 403);
    await expectStatus(post(admin, `/api/versions/${id}/submit`), 403);
    await expectStatus(post(engineer, `/api/versions/${id}/review`, { decision: "approve" }), 403);
    await expectStatus(post(admin, `/api/versions/${id}/review`, { decision: "approve" }), 403);
    await expectStatus(post(engineer, `/api/versions/${id}/deploy`), 403);
    await expectStatus(post(engineer, `/api/versions/${id}/retire`, { comment: "x" }), 403);
    await expectStatus(post(engineer, `/api/versions/${id}/resolve-review`, { decision: "keep", comment: "x" }), 403);
    // illegal later in the lifecycle
    await post(engineer, `/api/versions/${id}/submit`).expect(200);
    await expectStatus(post(engineer, `/api/versions/${id}/submit`), 400);
    await expectStatus(post(officer, `/api/versions/${id}/deploy`), 400);
    await post(officer, `/api/versions/${id}/review`, { decision: "approve", comment: "ok" }).expect(200);
    await expectStatus(post(officer, `/api/versions/${id}/review`, { decision: "approve", comment: "again" }), 400);
    await expectStatus(post(engineer, `/api/versions/${id}/withdraw`), 400);
    await post(officer, `/api/versions/${id}/deploy`).expect(200);
    await expectStatus(post(officer, `/api/versions/${id}/deploy`), 400);
    await expectStatus(post(engineer, `/api/versions/${id}/submit`), 400);
    // unauthenticated
    expect((await request(app).post(`/api/versions/${id}/submit`)).status).toBe(401);
    // unknown / malformed ids
    expect((await post(engineer, "/api/versions/aaaaaaaaaaaaaaaaaaaaaaaa/submit")).status).toBe(404);
    expect((await post(engineer, "/api/versions/not-an-id/submit")).status).toBe(400);
    // upload_failed cannot be submitted
    computeMetrics.mockRejectedValueOnce(userErr());
    const failed = await newVersion(engineer, model._id);
    await expectStatus(post(engineer, `/api/versions/${failed._id}/submit`), 400);
  });

  test("retire and resolve-review need a comment (string, non-blank)", async () => {
    const v = await deploy(engineer, officer, (await newVersion(engineer, model._id))._id);
    for (const body of [{}, { comment: "" }, { comment: "  " }, { comment: 5 }, { comment: {} }]) {
      expect((await post(officer, `/api/versions/${v._id}/retire`, body)).status).toBe(400);
    }
    for (const body of [{ decision: "keep" }, { decision: "keep", comment: " " }, { decision: "bogus", comment: "x" }, { comment: "x" }]) {
      expect((await post(officer, `/api/versions/${v._id}/resolve-review`, body)).status).toBe(400);
    }
    expect((await post(officer, `/api/versions/${v._id}/retire`, { comment: "sunset" })).body.version.status).toBe("retired");
    expect((await post(officer, `/api/versions/${v._id}/retire`, { comment: "again" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("deploy supersedes", () => {
  test("deploying v2 supersedes live v1 (and a needs_review v1), with audit on each", async () => {
    const v1 = await deploy(engineer, officer, (await newVersion(engineer, model._id))._id);
    const v2raw = await newVersion(engineer, model._id);
    const v2 = await deploy(engineer, officer, v2raw._id);
    expect(v2.status).toBe("deployed");
    expect((await get(officer, `/api/versions/${v1._id}`)).body.version.status).toBe("superseded");
    expect(await audit(v1._id)).toEqual(["upload_version", "submit_version", "approve", "deploy", "deploy"]);
    const log = await AuditLog.findOne({ targetId: v1._id, action: "deploy", details: /Superseded by v2/ });
    expect(log).toBeTruthy();

    // a drift-flagged (needs_review) live version is superseded as well
    await Version.updateOne({ _id: v2._id }, { $set: { status: "needs_review" } });
    const v3 = await deploy(engineer, officer, (await newVersion(engineer, model._id))._id);
    expect((await get(officer, `/api/versions/${v2._id}`)).body.version.status).toBe("superseded");
    const list = await get(officer, `/api/models/${model._id}/versions`);
    expect(list.body.versions.filter((v) => ["deployed", "needs_review"].includes(v.status)).map((v) => v.versionNumber)).toEqual([3]);
    const summary = (await get(officer, `/api/models/${model._id}`)).body.model;
    expect(summary).toMatchObject({ liveVersionNumber: 3, liveVersionStatus: "deployed", versionCount: 3 });
    expect(v3.versionNumber).toBe(3);
  });

  test("admins may deploy; other models' live versions are untouched", async () => {
    const other = await createModel(engineer);
    const o1 = await deploy(engineer, officer, (await newVersion(engineer, other._id))._id);
    const a = await newVersion(engineer, model._id);
    await approve(engineer, officer, a._id);
    expect((await post(admin, `/api/versions/${a._id}/deploy`)).status).toBe(200);
    expect((await get(officer, `/api/versions/${o1._id}`)).body.version.status).toBe("deployed");
  });

  test("a 400 deploy (not approved) does not disturb the live version", async () => {
    const live = await deploy(engineer, officer, (await newVersion(engineer, model._id))._id);
    const draft = await newVersion(engineer, model._id);
    expect((await post(officer, `/api/versions/${draft._id}/deploy`)).status).toBe(400);
    expect((await get(officer, `/api/versions/${live._id}`)).body.version.status).toBe("deployed");
  });
});

// ---------------------------------------------------------------------------
describe("race safety", () => {
  test("double submit: exactly one 200", async () => {
    const v = await newVersion(engineer, model._id);
    const rs = await Promise.all(Array.from({ length: 4 }, () => post(engineer, `/api/versions/${v._id}/submit`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(3);
    expect(rs.find((r) => r.status === 400).body.error).toMatch(/submitted/);
    expect(await AuditLog.countDocuments({ targetId: v._id, action: "submit_version" })).toBe(1);
  });

  test("approve vs reject at the same time: exactly one wins", async () => {
    const v = await newVersion(engineer, model._id);
    await post(engineer, `/api/versions/${v._id}/submit`).expect(200);
    const rs = await Promise.all([
      post(officer, `/api/versions/${v._id}/review`, { decision: "approve", comment: "a" }),
      post(officer, `/api/versions/${v._id}/review`, { decision: "reject", comment: "r" }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  test("double deploy of the same version and concurrent retire: one winner each", async () => {
    const v = await newVersion(engineer, model._id);
    await approve(engineer, officer, v._id);
    const d = await Promise.all([post(officer, `/api/versions/${v._id}/deploy`), post(admin, `/api/versions/${v._id}/deploy`)]);
    expect(d.map((r) => r.status).sort()).toEqual([200, 400]);
    const r = await Promise.all([post(officer, `/api/versions/${v._id}/retire`, { comment: "x" }), post(admin, `/api/versions/${v._id}/retire`, { comment: "y" })]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 400]);
  });

  test("deploying two approved versions of one model at once leaves exactly one live", async () => {
    const a = await newVersion(engineer, model._id);
    const b = await newVersion(engineer, model._id);
    await approve(engineer, officer, a._id);
    await approve(engineer, officer, b._id);
    await Promise.all([post(officer, `/api/versions/${a._id}/deploy`), post(admin, `/api/versions/${b._id}/deploy`)]);
    expect(await Version.countDocuments({ modelId: model._id, status: "deployed" })).toBe(1);
    expect(await Version.countDocuments({ modelId: model._id, status: "superseded" })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("drift monitoring", () => {
  let live;
  beforeEach(async () => {
    live = await deploy(engineer, officer, (await newVersion(engineer, model._id))._id);
  });
  const sim = (id = live._id, token = engineer) => post(token, `/api/versions/${id}/simulate-drift`);

  test("simulate: flagged snapshot flips deployed -> needs_review once, tier follows the metrics", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0); // accuracy -0.03 per click, gap +0
    const seen = [];
    let flaggedAt = null;
    for (let i = 1; i <= 6; i += 1) {
      const res = await sim();
      expect(res.status).toBe(201);
      expect(Object.keys(res.body).sort()).toEqual(["escalated", "snapshot", "version"]);
      seen.push(res.body);
      if (res.body.snapshot.flagged && flaggedAt === null) flaggedAt = i;
    }
    expect(seen[0].snapshot).toMatchObject({ source: "simulated", isBaseline: false, flagged: false, riskTier: "low", createdByName: expect.any(String) });
    expect(seen[0].snapshot.accuracy).toBeCloseTo(0.92, 5);
    expect(seen[0].version.status).toBe("deployed");
    // 0.95 -> .92 -> .89 -> .86 -> .83 (tier medium: escalated, and |delta| 0.12 > 0.1)
    expect(flaggedAt).toBe(4);
    expect(seen[3]).toMatchObject({ escalated: true });
    expect(seen[3].snapshot.riskTier).toBe("medium");
    expect(seen[3].version).toMatchObject({ status: "needs_review", riskTier: "medium", initialRiskTier: "low" });
    expect(seen[4].version.status).toBe("needs_review"); // keeps monitoring while in review
    expect(seen[5]).toMatchObject({ escalated: false }); // .77: still medium, no further escalation
    expect(seen[5].snapshot.riskTier).toBe("medium");
    expect(await AuditLog.countDocuments({ targetId: live._id, action: "drift_flagged" })).toBe(1);
    expect(await AuditLog.countDocuments({ targetId: live._id, action: "simulate_drift" })).toBe(6);

    const detail = await get(officer, `/api/versions/${live._id}`);
    expect(detail.body.snapshots).toHaveLength(7);
    expect(detail.body.snapshots[0].isBaseline).toBe(true);
    const times = detail.body.snapshots.map((s) => new Date(s.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times); // oldest -> newest
    expect(detail.body.compliance.checks.find((c) => c.key === "drift_clear").passed).toBe(false);
  });

  test("resolve-review keep returns to deployed; retire ends it; roles + state guards", async () => {
    await Version.updateOne({ _id: live._id }, { $set: { status: "needs_review" } });
    expect((await post(engineer, `/api/versions/${live._id}/resolve-review`, { decision: "keep", comment: "x" })).status).toBe(403);
    const keep = await post(officer, `/api/versions/${live._id}/resolve-review`, { decision: "keep", comment: "false alarm" });
    expect(keep.body.version.status).toBe("deployed");
    expect((await post(officer, `/api/versions/${live._id}/resolve-review`, { decision: "keep", comment: "again" })).status).toBe(400);

    await Version.updateOne({ _id: live._id }, { $set: { status: "needs_review" } });
    const retire = await post(admin, `/api/versions/${live._id}/resolve-review`, { decision: "retire", comment: "degraded" });
    expect(retire.body.version.status).toBe("retired");
    expect(await audit(live._id)).toEqual(expect.arrayContaining(["resolve_review"]));
    expect((await sim()).status).toBe(400); // retired versions are not monitored
  });

  test("retire works from needs_review", async () => {
    await Version.updateOne({ _id: live._id }, { $set: { status: "needs_review" } });
    expect((await post(officer, `/api/versions/${live._id}/retire`, { comment: "bad" })).body.version.status).toBe("retired");
  });

  test("simulation can be disabled (403) and is capped at 500 snapshots", async () => {
    env.enableDriftSimulation = false;
    expect((await sim()).status).toBe(403);
    env.enableDriftSimulation = true;
    const base = await MetricSnapshot.findOne({ versionId: live._id });
    await MetricSnapshot.insertMany(
      Array.from({ length: 499 }, () => ({ orgId: base.orgId, versionId: live._id, accuracy: 0.9, fairnessGap: 0.02, source: "simulated", riskTier: "low" }))
    );
    expect(base).toBeTruthy();
    const res = await sim();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500/);
    expect((await post(engineer, `/api/versions/${live._id}/monitoring-batch`)).status).toBe(400);
  });

  test("simulate requires auth and a live version", async () => {
    expect((await request(app).post(`/api/versions/${live._id}/simulate-drift`)).status).toBe(401);
    expect((await sim(live._id, officer)).status).toBe(201); // any authenticated role
    const draft = await newVersion(engineer, model._id);
    expect((await sim(draft._id)).status).toBe(400);
  });
});

describe("evaluateSnapshot / riskTier / compliance (pure)", () => {
  const baseline = { accuracy: 0.95, fairnessGap: 0.02 };
  const version = (riskTier = "low", thresholdsUsed = undefined) => ({ riskTier, thresholdsUsed });

  test("tier ranking", () => {
    expect([tierRank("low"), tierRank("medium"), tierRank("high"), tierRank(null)]).toEqual([0, 1, 2, 2]);
    expect(worseThan("high", "low")).toBe(true);
    expect(worseThan("low", "low")).toBe(false);
    expect(worseThan("low", "medium")).toBe(false);
  });

  test("flagged on accuracy drift, fairness drift, or escalation only", () => {
    const small = evaluateSnapshot({ baseline, metrics: { accuracy: 0.9, fairnessGap: 0.03 }, version: version() });
    expect(small).toMatchObject({ riskTier: "low", flagged: false, escalated: false });
    expect(small.driftDelta).toBeCloseTo(-0.05, 10);
    expect(evaluateSnapshot({ baseline, metrics: { accuracy: 0.84, fairnessGap: 0.02 }, version: version() })).toMatchObject({ flagged: true, escalated: true, riskTier: "medium" });
    // accuracy moved > 0.1 but tier unchanged (high stays high) -> flagged, not escalated
    expect(evaluateSnapshot({ baseline, metrics: { accuracy: 0.3, fairnessGap: 0.02 }, version: version("high") })).toMatchObject({ flagged: true, escalated: false, riskTier: "high" });
    // fairness gap alone
    expect(evaluateSnapshot({ baseline, metrics: { accuracy: 0.95, fairnessGap: 0.14 }, version: version("medium") })).toMatchObject({ flagged: true, escalated: false });
    // improvement beyond the threshold is still "drift" (absolute), but never escalated
    expect(evaluateSnapshot({ baseline: { accuracy: 0.6, fairnessGap: 0.3 }, metrics: { accuracy: 0.9, fairnessGap: 0.05 }, version: version("high") })).toMatchObject({ flagged: true, escalated: false, riskTier: "low" });
  });

  test("uses the thresholds the version was scored under", () => {
    const strict = { lowAccuracy: 0.99, lowFairnessGap: 0.01, mediumAccuracy: 0.9, mediumFairnessGap: 0.05, driftThreshold: 0.02 };
    const r = evaluateSnapshot({ baseline, metrics: { accuracy: 0.93, fairnessGap: 0.02 }, version: version("low", strict) });
    expect(r).toMatchObject({ riskTier: "medium", escalated: true, flagged: true });
  });

  test("compliance: tiers, approval states, drift_clear", () => {
    const base = { metrics: { accuracy: 0.9 }, reviewComment: "", status: "draft" };
    expect(scoreCompliance({ ...base, riskTier: "low" }).checks.map((c) => c.key)).toEqual(["metrics", "approval"]);
    expect(scoreCompliance({ ...base, riskTier: "low" }).score).toBe(50);
    expect(scoreCompliance({ ...base, riskTier: "medium" }).checks.map((c) => c.key)).toEqual(["metrics", "approval", "drift_clear"]);
    const unrated = scoreCompliance({ ...base, riskTier: null });
    expect(unrated.checks.map((c) => c.key)).toEqual(["metrics", "documented_review_comment", "approval", "drift_clear"]);
    for (const status of ["approved", "deployed", "needs_review", "superseded", "retired"]) {
      expect(scoreCompliance({ ...base, riskTier: "low", status }).checks.find((c) => c.key === "approval").passed).toBe(true);
    }
    expect(scoreCompliance({ ...base, riskTier: "low", status: "submitted" }).checks.find((c) => c.key === "approval").passed).toBe(false);
    const flagged = scoreCompliance({ ...base, riskTier: "medium", status: "deployed" }, { flagged: true });
    expect(flagged.checks.find((c) => c.key === "drift_clear").passed).toBe(false);
    expect(scoreCompliance({ ...base, riskTier: "medium", status: "needs_review" }, { flagged: false }).checks.find((c) => c.key === "drift_clear").passed).toBe(false);
    expect(scoreCompliance({ riskTier: "low", metrics: {}, status: "deployed" }).checks[0].passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("monitoring batch", () => {
  let live;
  beforeEach(async () => {
    live = await deploy(engineer, officer, (await newVersion(engineer, model._id))._id);
  });
  const batch = (id = live._id, { buffer = CSV, filename = "batch.csv", fields = {}, token = engineer } = {}) => {
    let req = auth(request(app).post(`/api/versions/${id}/monitoring-batch`), token);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return buffer ? req.attach("file", buffer, filename) : req;
  };

  test("good batch: batch snapshot, carried-forward latency, rows, audit; temp file removed", async () => {
    computeMetrics.mockResolvedValue(metrics({ accuracy: 0.94, rows: 321 }));
    const before = files();
    const res = await batch();
    expect(res.status).toBe(201);
    expect(res.body.snapshot).toMatchObject({ source: "batch", rows: 321, accuracy: 0.94, latencyMs: 12, flagged: false, isBaseline: false, riskTier: "low" });
    expect(res.body.escalated).toBe(false);
    expect(res.body.version.status).toBe("deployed");
    expect(computeMetrics.mock.calls.pop()[0]).toMatchObject({ fileType: "csv", datasetFilePath: null });
    expect(files()).toBe(before);
    expect(await AuditLog.countDocuments({ targetId: live._id, action: "monitoring_batch" })).toBe(1);
  });

  test("explicit latency overrides; bad batch flags, escalates and moves to needs_review", async () => {
    computeMetrics.mockResolvedValue(BAD);
    const res = await batch(live._id, { fields: { latencyMs: "30" } });
    expect(res.status).toBe(201);
    expect(res.body.snapshot).toMatchObject({ latencyMs: 30, flagged: true, riskTier: "high" });
    expect(res.body.escalated).toBe(true);
    expect(res.body.version).toMatchObject({ status: "needs_review", riskTier: "high", initialRiskTier: "low" });
    expect(await AuditLog.countDocuments({ targetId: live._id, action: "drift_flagged" })).toBe(1);
    const again = await batch(); // still scores while in review; stays needs_review
    expect(again.status).toBe(201);
    expect(again.body.version.status).toBe("needs_review");
  });

  test("validation: file, extension, latency, state, auth; file always removed", async () => {
    const before = files();
    expect((await batch(live._id, { buffer: null })).status).toBe(400);
    expect((await batch(live._id, { filename: "b.txt" })).status).toBe(400);
    expect((await batch(live._id, { fields: { latencyMs: "-1" } })).status).toBe(400);
    expect((await batch(live._id, { fields: { latencyMs: "1e999" } })).status).toBe(400);
    const draft = await newVersion(engineer, model._id);
    const filesAfterDraft = files();
    expect((await batch(draft._id)).status).toBe(400);
    expect(files()).toBe(filesAfterDraft); // the batch temp file was removed
    expect((await batch("aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await request(app).post(`/api/versions/${live._id}/monitoring-batch`)).status).toBe(401);
    // the wrong field name is rejected by multer
    const wrong = await auth(request(app).post(`/api/versions/${live._id}/monitoring-batch`), engineer).attach("other", CSV, "b.csv");
    expect(wrong.status).toBe(400);
    expect(files()).toBe(filesAfterDraft);
    expect(before + 1).toBe(filesAfterDraft); // only the draft upload remained
    expect(await MetricSnapshot.countDocuments({ versionId: live._id })).toBe(1);
  });

  test("scoring failures: 400 for user errors, 503 for retryable ones; any role may submit a batch", async () => {
    const before = files();
    computeMetrics.mockRejectedValueOnce(userErr("CSV is missing required column(s): predicted"));
    const a = await batch();
    expect(a.status).toBe(400);
    expect(a.body.error).toBe("CSV is missing required column(s): predicted");
    computeMetrics.mockRejectedValueOnce(retryableErr());
    const b = await batch();
    expect(b.status).toBe(503);
    expect(b.body.retryable).toBe(true);
    expect(files()).toBe(before);
    expect((await batch(live._id, { token: officer })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
describe("file download", () => {
  const dl = (id, qs = "", token = officer) => get(token, `/api/versions/${id}/file${qs}`).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

  test("local mode streams the original file under its original (sanitised) name and audits it", async () => {
    const v = await newVersion(engineer, model._id, { filename: "my preds (final).csv", buffer: Buffer.from("predicted,actual\n1,1\n") });
    const res = await dl(v._id);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toContain("my preds (final).csv");
    expect(res.body.toString()).toBe("predicted,actual\n1,1\n");
    expect(await audit(v._id)).toEqual(["upload_version", "download_file"]);
    expect(JSON.stringify(await AuditLog.find({ targetId: v._id }).lean())).not.toMatch(/uploads|modelward-test/);
  });

  test("dataset download for model files; 404 when not retained; validation", async () => {
    computeMetrics.mockResolvedValue(metrics({ latencyMs: 5 }));
    const res = await auth(request(app).post(`/api/models/${model._id}/versions`), engineer)
      .field("fileType", "joblib")
      .attach("file", Buffer.from("MODEL"), "m.joblib")
      .attach("datasetFile", dataset, "ds.csv");
    const v = res.body.version;
    expect((await dl(v._id, "?which=dataset")).body.toString()).toBe(dataset.toString());
    expect((await dl(v._id, "?which=model")).body.toString()).toBe("MODEL");
    expect((await dl(v._id, "?which=bogus")).status).toBe(400);

    const csvV = await newVersion(engineer, model._id);
    const noDs = await dl(csvV._id, "?which=dataset");
    expect(noDs.status).toBe(404);

    env.storageMode = "discard";
    const gone = await newVersion(engineer, model._id);
    const r = await get(officer, `/api/versions/${gone._id}/file`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "File not retained" });

    const row = await Version.findById(csvV._id);
    fs.unlinkSync(row.filePath);
    expect((await get(officer, `/api/versions/${csvV._id}/file`)).status).toBe(404); // missing on disk
    await Version.updateOne({ _id: csvV._id }, { $set: { filePath: "C:/Windows/win.ini" } });
    expect((await get(officer, `/api/versions/${csvV._id}/file`)).status).toBe(404); // outside the upload dir
    expect((await request(app).get(`/api/versions/${csvV._id}/file`)).status).toBe(401);
  });
});
