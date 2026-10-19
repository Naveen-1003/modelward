// Cross-organization isolation of the models / versions / comments domain.
// Two organizations (A and B), each with an admin, an ML engineer, a compliance officer and data.
// An organization-A user must never read, list, count, modify, comment on or download anything
// of B; every attempt on B's ids is a 404 that writes at most one cross_org_attempt audit entry.
jest.mock("../utils/metricsClient");

const fs = require("fs");
const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../app");
const computeMetrics = require("../utils/metricsClient");
const Model = require("../models/Model");
const Version = require("../models/Version");
const MetricSnapshot = require("../models/MetricSnapshot");
const Comment = require("../models/Comment");
const AuditLog = require("../models/AuditLog");
const Settings = require("../models/Settings");
const User = require("../models/User");
const { UPLOAD_DIR } = require("../middleware/upload");
const { ACTIVE_MODEL_STAGES, summarizeModels, summarizeActive } = require("../utils/modelSummary");
const { runWithOrg } = require("../utils/tenant");
const { connect, reset, disconnect, makeUser, makeOrg, sys, auth } = require("./helpers");
const { GOOD, BAD, CSV, uploadCsv, createModel, newVersion, post, get, deploy } = require("./domainHelpers");

const sModel = sys(Model);
const sVersion = sys(Version);
const sSnapshot = sys(MetricSnapshot);
const sComment = sys(Comment);
const sAudit = sys(AuditLog);

let orgA, orgB;
let A = {}; // { admin, eng, officer } -> makeUser results; plus model / v1 (deployed) / v2 (draft) / v3 (submitted)
let B = {};
let superAdmin;

const del = (token, url, body, hdr = {}) => auth(request(app).delete(url), token).set(hdr).send(body || {});
const patch = (token, url, body) => auth(request(app).patch(url), token).send(body || {});
const files = () => fs.readdirSync(UPLOAD_DIR).length;

// Fresh organization data: a model with a deployed version (v1), a draft (v2), a submitted (v3),
// a failed upload (v4, retryable) and one comment, all created through the API as that org's users.
async function seed(org, label) {
  const ctx = {
    org,
    admin: await makeUser("admin", { orgId: org._id }),
    eng: await makeUser("ml_engineer", { orgId: org._id }),
    officer: await makeUser("compliance_officer", { orgId: org._id }),
  };
  computeMetrics.mockReset();
  computeMetrics.mockResolvedValue(GOOD);
  ctx.model = await createModel(ctx.eng.token, `Shared Name ${label}-only`);
  ctx.v1 = await deploy(ctx.eng.token, ctx.officer.token, (await newVersion(ctx.eng.token, ctx.model._id))._id);
  ctx.v2 = await newVersion(ctx.eng.token, ctx.model._id);
  ctx.v3 = await newVersion(ctx.eng.token, ctx.model._id);
  await post(ctx.eng.token, `/api/versions/${ctx.v3._id}/submit`).expect(200);
  computeMetrics.mockRejectedValueOnce(Object.assign(new Error("service down"), { retryable: true }));
  ctx.v4 = await newVersion(ctx.eng.token, ctx.model._id);
  expect(ctx.v4.status).toBe("upload_failed");
  ctx.comment = (await post(ctx.eng.token, `/api/versions/${ctx.v2._id}/comments`, { body: `secret of ${label}` })).body.comment;
  return ctx;
}

beforeAll(async () => {
  await connect();
  await reset();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  orgA = await makeOrg({ name: "Org A" });
  orgB = await makeOrg({ name: "Org B" });
  A = await seed(orgA, "A");
  B = await seed(orgB, "B");
  superAdmin = await makeUser("super_admin");
});
afterAll(async () => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  await disconnect();
});
beforeEach(() => {
  computeMetrics.mockReset();
  computeMetrics.mockResolvedValue(GOOD);
});

// A snapshot of everything of B that a wrongful write could change.
async function stateOf(ctx) {
  const id = ctx.org._id;
  return JSON.stringify({
    models: await sModel.find({ orgId: id }).setOptions({ includeDeleted: true }).sort({ _id: 1 }).lean(),
    versions: await sVersion.find({ orgId: id }).setOptions({ includeDeleted: true }).sort({ _id: 1 }).lean(),
    snapshots: await sSnapshot.find({ orgId: id }).sort({ _id: 1 }).lean(),
    comments: await sComment.find({ orgId: id }).sort({ _id: 1 }).lean(),
  });
}
const auditActions = async (orgId) => (await sAudit.find({ orgId }).sort({ createdAt: 1, seq: 1 }).lean()).map((a) => a.action);

// Runs `attempts` as org-A user, asserts every one answers 404, org B is byte-for-byte untouched and
// the only audit rows written are cross_org_attempt (one per attempt at most) in org A.
async function expectProbe404(attempts) {
  const before = await stateOf(B);
  const lastSeq = ((await sAudit.findOne({ seq: { $exists: true } }).sort({ seq: -1 }).lean()) || {}).seq || 0;
  const filesBefore = files();
  for (const [label, run] of attempts) {
    const res = await run();
    expect([label, res.status]).toEqual([label, 404]);
    expect(JSON.stringify(res.body)).not.toMatch(/secret of B|Shared Name B/);
  }
  expect(await stateOf(B)).toBe(before);
  expect(files()).toBe(filesBefore);
  const fresh = await sAudit.find({ seq: { $gt: lastSeq } }).lean();
  expect(fresh.length).toBeLessThanOrEqual(attempts.length);
  for (const row of fresh) {
    expect(row.action).toBe("cross_org_attempt");
    expect(String(row.orgId)).toBe(String(orgA._id));
  }
}

describe("models", () => {
  test("lists, search, tier filter and totals never include the other organization", async () => {
    const list = await get(A.eng.token, "/api/models?limit=100");
    expect(list.status).toBe(200);
    expect(list.body.models.map((m) => m.name)).toEqual(["Shared Name A-only"]);
    expect(list.body.total).toBe(1);
    expect((await get(A.eng.token, "/api/models?q=B-only")).body).toMatchObject({ total: 0, models: [] });
    expect((await get(A.eng.token, "/api/models?q=Shared")).body.total).toBe(1);
    expect((await get(A.eng.token, "/api/models?tier=low")).body.models.map((m) => m._id)).toEqual([A.model._id]);
    expect((await get(A.eng.token, "/api/models?tier=unrated")).body.total).toBe(0);
    const b = await get(B.officer.token, "/api/models");
    expect(b.body.models.map((m) => m._id)).toEqual([B.model._id]);
  });

  test("get / archive / restore of another organization's model is 404 (and audited)", async () => {
    const before = await sAudit.countDocuments({ action: "cross_org_attempt", orgId: orgA._id });
    await expectProbe404([
      ["get", () => get(A.eng.token, `/api/models/${B.model._id}`)],
      ["get as admin", () => get(A.admin.token, `/api/models/${B.model._id}`)],
      ["archive", () => del(A.admin.token, `/api/models/${B.model._id}`)],
      ["restore", () => post(A.admin.token, `/api/models/${B.model._id}/restore`)],
    ]);
    expect(await sAudit.countDocuments({ action: "cross_org_attempt", orgId: orgA._id })).toBe(before + 4);
    const row = await sAudit.findOne({ action: "cross_org_attempt", targetId: B.model._id }).lean();
    expect(row).toMatchObject({ targetType: "Model", actorId: A.eng.user._id });
  });

  test("an archived model of the other organization is just as invisible", async () => {
    const m = await createModel(B.admin.token, "B archived one");
    await del(B.admin.token, `/api/models/${m._id}`).expect(200);
    await expectProbe404([
      ["restore archived", () => post(A.admin.token, `/api/models/${m._id}/restore`)],
      ["archive archived", () => del(A.admin.token, `/api/models/${m._id}`)],
    ]);
    expect((await sModel.findById(m._id).setOptions({ includeDeleted: true })).isDeleted).toBe(true);
  });

  test("an unknown id is a plain 404 and writes no audit row", async () => {
    const before = await sAudit.countDocuments({});
    expect((await get(A.eng.token, `/api/models/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    expect(await sAudit.countDocuments({})).toBe(before);
  });

  test("model names are unique per organization: the same name is fine in two orgs, not twice in one", async () => {
    const a1 = await post(A.eng.token, "/api/models", { name: "Credit Scorer" });
    const b1 = await post(B.eng.token, "/api/models", { name: "credit scorer" });
    expect([a1.status, b1.status]).toEqual([201, 201]);
    expect((await post(A.eng.token, "/api/models", { name: "CREDIT SCORER" })).status).toBe(409);
    expect((await post(B.admin.token, "/api/models", { name: "Credit Scorer" })).status).toBe(409);
    // archiving A's frees only A's name; restore clash is judged inside A
    await del(A.admin.token, `/api/models/${a1.body.model._id}`).expect(200);
    expect((await post(A.eng.token, "/api/models", { name: "Credit Scorer" })).status).toBe(201);
    expect((await post(A.admin.token, `/api/models/${a1.body.model._id}/restore`)).status).toBe(409);
    expect((await sModel.findById(b1.body.model._id)).isDeleted).toBe(false);
    // parallel creates of one name in both orgs: one winner per org
    const race = await Promise.all([
      ...Array.from({ length: 3 }, () => post(A.eng.token, "/api/models", { name: "Race Name" })),
      ...Array.from({ length: 3 }, () => post(B.eng.token, "/api/models", { name: "Race Name" })),
    ]);
    expect(race.slice(0, 3).filter((r) => r.status === 201)).toHaveLength(1);
    expect(race.slice(3).filter((r) => r.status === 201)).toHaveLength(1);
  });

  test("created models carry the creator's orgId, never one from the body", async () => {
    const bogus = await post(A.eng.token, "/api/models", { name: "Body org", orgId: String(orgB._id) });
    expect(bogus.status).toBe(400); // strict schema: orgId is not an accepted field
    const ok = await createModel(A.eng.token, "Stamped");
    expect(String((await sModel.findById(ok._id)).orgId)).toBe(String(orgA._id));
  });
});

describe("versions", () => {
  test("list, queue, search and status filters never include the other organization", async () => {
    const mine = await get(A.eng.token, `/api/models/${A.model._id}/versions`);
    expect(mine.body.versions.map((v) => v._id).sort()).toEqual([A.v1._id, A.v2._id, A.v3._id, A.v4._id].sort());
    const queue = await get(A.officer.token, "/api/versions?limit=100");
    expect(queue.body.total).toBe(4);
    expect(queue.body.versions.every((v) => String(v.orgId) === String(orgA._id))).toBe(true);
    expect((await get(A.officer.token, "/api/versions?status=submitted")).body.versions.map((v) => v._id)).toEqual([A.v3._id]);
    expect((await get(A.officer.token, "/api/versions?q=B-only")).body.total).toBe(0);
    expect((await get(A.officer.token, "/api/versions?q=A-only")).body.total).toBe(4);
    expect((await get(A.officer.token, "/api/versions?q=v1")).body.versions.map((v) => v._id)).toEqual([A.v1._id]);
    const bq = await get(B.officer.token, "/api/versions?limit=100");
    expect(bq.body.versions.map((v) => v._id).sort()).toEqual([B.v1._id, B.v2._id, B.v3._id, B.v4._id].sort());
  });

  test("get / file / notes / submit / withdraw / retry / delete / restore of B's versions are 404", async () => {
    const bv = B.v2._id;
    await expectProbe404([
      ["list of B's model", () => get(A.eng.token, `/api/models/${B.model._id}/versions`)],
      ["get", () => get(A.officer.token, `/api/versions/${bv}`)],
      ["download model file", () => get(A.eng.token, `/api/versions/${bv}/file`)],
      ["download dataset file", () => get(A.eng.token, `/api/versions/${bv}/file?which=dataset`)],
      ["notes", () => patch(A.eng.token, `/api/versions/${bv}/notes`, { trainingNotes: "hijack" })],
      ["submit", () => post(A.eng.token, `/api/versions/${bv}/submit`)],
      ["withdraw", () => post(A.eng.token, `/api/versions/${B.v3._id}/withdraw`)],
      ["retry", () => post(A.eng.token, `/api/versions/${B.v4._id}/retry`)],
      ["archive", () => del(A.admin.token, `/api/versions/${bv}`)],
      ["restore", () => post(A.admin.token, `/api/versions/${bv}/restore`)],
    ]);
  });

  test("review / deploy / retire / resolve-review of B's versions are 404", async () => {
    await expectProbe404([
      ["approve", () => post(A.officer.token, `/api/versions/${B.v3._id}/review`, { decision: "approve", comment: "x" })],
      ["reject", () => post(A.officer.token, `/api/versions/${B.v3._id}/review`, { decision: "reject", comment: "x" })],
      ["deploy", () => post(A.officer.token, `/api/versions/${B.v1._id}/deploy`)],
      ["retire", () => post(A.officer.token, `/api/versions/${B.v1._id}/retire`, { comment: "x" })],
      ["retire as admin", () => post(A.admin.token, `/api/versions/${B.v1._id}/retire`, { comment: "x" })],
      ["resolve", () => post(A.officer.token, `/api/versions/${B.v1._id}/resolve-review`, { decision: "retire", comment: "x" })],
    ]);
  });

  test("monitoring: simulate drift and batch on B's deployed version are 404 and add no snapshot", async () => {
    await expectProbe404([
      ["simulate", () => post(A.eng.token, `/api/versions/${B.v1._id}/simulate-drift`)],
      ["simulate as officer", () => post(A.officer.token, `/api/versions/${B.v1._id}/simulate-drift`)],
      ["batch", () => auth(request(app).post(`/api/versions/${B.v1._id}/monitoring-batch`), A.eng.token).attach("file", CSV, "b.csv")],
    ]);
    expect(computeMetrics).not.toHaveBeenCalled();
  });

  test("uploading to B's model is 404, leaves no file and no version", async () => {
    const filesBefore = files();
    const res = await uploadCsv(A.eng.token, B.model._id);
    expect(res.status).toBe(404);
    expect(files()).toBe(filesBefore);
    expect(computeMetrics).not.toHaveBeenCalled();
    expect(await sVersion.countDocuments({ modelId: B.model._id }).setOptions({ includeDeleted: true })).toBe(4);
  });

  test("a version file is served inside its organization only", async () => {
    const own = await get(A.eng.token, `/api/versions/${A.v1._id}/file`);
    expect(own.status).toBe(200);
    expect(await sAudit.countDocuments({ action: "download_file", targetId: A.v1._id, orgId: orgA._id })).toBe(1);
    expect((await get(B.eng.token, `/api/versions/${A.v1._id}/file`)).status).toBe(404);
    const probe = await sAudit.findOne({ action: "cross_org_attempt", targetId: A.v1._id }).lean();
    expect(probe).toMatchObject({ targetType: "Version", actorId: B.eng.user._id });
    expect(String(probe.orgId)).toBe(String(orgB._id));
  });

  test("own-organization operations still work and every stored row carries the right orgId", async () => {
    const orgOf = async (M, id) => String((await M.findById(id).setOptions({ includeDeleted: true })).orgId);
    for (const ctx of [A, B]) {
      const want = String(ctx.org._id);
      for (const v of [ctx.v1, ctx.v2, ctx.v3, ctx.v4]) expect(await orgOf(sVersion, v._id)).toBe(want);
      expect(await orgOf(sModel, ctx.model._id)).toBe(want);
      expect(await orgOf(sComment, ctx.comment._id)).toBe(want);
      const snaps = await sSnapshot.find({ versionId: { $in: [ctx.v1._id, ctx.v2._id, ctx.v3._id] } });
      expect(snaps).toHaveLength(3);
      expect(snaps.every((s) => String(s.orgId) === want)).toBe(true);
    }
    // simulate drift on the own deployed version
    const sim = await post(A.eng.token, `/api/versions/${A.v1._id}/simulate-drift`);
    expect(sim.status).toBe(201);
    expect(String((await sSnapshot.findById(sim.body.snapshot._id)).orgId)).toBe(String(orgA._id));
    expect(sim.body.snapshot.createdByName).toBe(A.eng.user.name);
    // batch monitoring
    computeMetrics.mockResolvedValue(GOOD);
    const batch = await auth(request(app).post(`/api/versions/${A.v1._id}/monitoring-batch`), A.officer.token).attach("file", CSV, "b.csv");
    expect(batch.status).toBe(201);
    expect(String((await sSnapshot.findById(batch.body.snapshot._id)).orgId)).toBe(String(orgA._id));
    // notes, withdraw, submit, archive, restore
    expect((await patch(A.eng.token, `/api/versions/${A.v2._id}/notes`, { trainingNotes: "mine" })).status).toBe(200);
    expect((await post(A.eng.token, `/api/versions/${A.v3._id}/withdraw`)).status).toBe(200);
    expect((await post(A.eng.token, `/api/versions/${A.v3._id}/submit`)).status).toBe(200);
    expect((await del(A.admin.token, `/api/versions/${A.v2._id}`)).status).toBe(200);
    expect((await post(A.admin.token, `/api/versions/${A.v2._id}/restore`)).status).toBe(200);
  });

  test("retry of an own failed upload stores its baseline snapshot in the own organization", async () => {
    computeMetrics.mockResolvedValue(GOOD);
    const res = await post(A.eng.token, `/api/versions/${A.v4._id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.version.status).toBe("draft");
    const snaps = await sSnapshot.find({ versionId: A.v4._id });
    expect(snaps).toHaveLength(1);
    expect(String(snaps[0].orgId)).toBe(String(orgA._id));
    expect(snaps[0].isBaseline).toBe(true);
  });
});

describe("comments", () => {
  test("list and post on B's version are 404; A never sees B's comments; B is untouched", async () => {
    await expectProbe404([
      ["list", () => get(A.eng.token, `/api/versions/${B.v2._id}/comments`)],
      ["post", () => post(A.eng.token, `/api/versions/${B.v2._id}/comments`, { body: "intruder" })],
      ["post as admin", () => post(A.admin.token, `/api/versions/${B.v2._id}/comments`, { body: "intruder" })],
    ]);
    expect(await sComment.countDocuments({ body: "intruder" })).toBe(0);
    const mine = await get(A.officer.token, `/api/versions/${A.v2._id}/comments`);
    expect(mine.body.comments.map((c) => c.body)).toEqual(["secret of A"]);
    const posted = await post(A.officer.token, `/api/versions/${A.v2._id}/comments`, { body: "reply" });
    expect(posted.status).toBe(201);
    expect(String((await sComment.findById(posted.body.comment._id)).orgId)).toBe(String(orgA._id));
    expect((await get(B.officer.token, `/api/versions/${B.v2._id}/comments`)).body.comments.map((c) => c.body)).toEqual(["secret of B"]);
  });
});

describe("summaries and joins", () => {
  test("summaries are computed from the caller's organization only", async () => {
    const out = await runWithOrg(orgA._id, () => summarizeModels([A.model._id, B.model._id]));
    expect(out.get(String(A.model._id)).versionCount).toBe(4);
    expect(out.get(String(B.model._id)).versionCount).toBe(0); // B's model: nothing visible from A
    const active = await runWithOrg(orgB._id, () => summarizeActive());
    expect([...active.keys()]).toEqual([String(B.model._id)]);
  });

  test("the model $lookup joins only a model of the SAME organization as the version", async () => {
    // A corrupt row: a version stamped org A that points at B's model. The root aggregate
    // filter alone would let it through; the lookup's own orgId condition must not join it.
    const bad = await sVersion.create({
      orgId: orgA._id, modelId: B.model._id, versionNumber: 999, fileType: "csv", createdBy: A.eng.user._id, status: "submitted",
    });
    const rows = await runWithOrg(orgA._id, () => Version.aggregate([{ $match: { _id: bad._id } }, ...ACTIVE_MODEL_STAGES]));
    expect(rows).toHaveLength(0);
    const healthy = await runWithOrg(orgA._id, () => Version.aggregate([{ $match: { _id: new mongoose.Types.ObjectId(A.v1._id) } }, ...ACTIVE_MODEL_STAGES]));
    expect(healthy).toHaveLength(1);
    expect(healthy[0].model[0].name).toBe("Shared Name A-only");
    await sVersion.deleteOne({ _id: bad._id }).setOptions({ includeDeleted: true });
  });
});

describe("per-organization thresholds", () => {
  test("a version is scored with its own organization's thresholds", async () => {
    const strict = { lowAccuracy: 0.99, lowFairnessGap: 0.001, mediumAccuracy: 0.98, mediumFairnessGap: 0.002, driftThreshold: 0.5 };
    await Settings.create({ orgId: orgA._id, ...strict });
    computeMetrics.mockResolvedValue(GOOD); // accuracy .95, gap .02
    const m = await createModel(A.eng.token, "Threshold A");
    const mB = await createModel(B.eng.token, "Threshold B");
    const va = await newVersion(A.eng.token, m._id);
    const vb = await newVersion(B.eng.token, mB._id);
    expect(va.riskTier).toBe("high");
    expect(va.thresholdsUsed).toMatchObject(strict);
    expect(vb.riskTier).toBe("low");
    expect(vb.thresholdsUsed).toMatchObject({ lowAccuracy: 0.85, driftThreshold: 0.1 });
    await sys(Settings).deleteOne({ orgId: orgA._id });
  });
});

describe("super admin", () => {
  const hdr = (org) => ({ "X-Org-Id": String(org._id) });

  test("without X-Org-Id every data route is 400 ORG_REQUIRED", async () => {
    for (const url of ["/api/models", "/api/versions", `/api/models/${A.model._id}`, `/api/versions/${A.v1._id}`, `/api/versions/${A.v1._id}/comments`]) {
      const res = await get(superAdmin.token, url);
      expect([url, res.status, res.body.code]).toEqual([url, 400, "ORG_REQUIRED"]);
    }
    const w = await post(superAdmin.token, "/api/models", { name: "No org" });
    expect([w.status, w.body.code]).toEqual([400, "ORG_REQUIRED"]);
  });

  test("with X-Org-Id sees exactly the selected organization, never a mix", async () => {
    const asA = await auth(request(app).get("/api/models?limit=100"), superAdmin.token).set(hdr(orgA));
    const names = asA.body.models.map((m) => m.name);
    expect(names).toContain("Shared Name A-only");
    expect(names.every((n) => !/B-only|B archived|Threshold B/.test(n))).toBe(true);
    expect(asA.body.total).toBe(asA.body.models.length);
    const asB = await auth(request(app).get("/api/models?limit=100"), superAdmin.token).set(hdr(orgB));
    expect(asB.body.models.map((m) => m._id)).toContain(String(B.model._id));
    expect(asB.body.models.map((m) => m._id)).not.toContain(String(A.model._id));
    const q = await auth(request(app).get("/api/versions?limit=100"), superAdmin.token).set(hdr(orgB));
    expect(q.body.versions.every((v) => String(v.orgId) === String(orgB._id))).toBe(true);
    // inside org A the super admin cannot reach B's ids (404, audited as the super admin in A)
    const miss = await auth(request(app).get(`/api/versions/${B.v1._id}`), superAdmin.token).set(hdr(orgA));
    expect(miss.status).toBe(404);
    const hit = await auth(request(app).get(`/api/versions/${A.v1._id}`), superAdmin.token).set(hdr(orgA));
    expect(hit.status).toBe(200);
  });

  test("acts with admin powers inside the selected organization: rows are created there, nowhere else", async () => {
    const created = await auth(request(app).post("/api/models"), superAdmin.token).set(hdr(orgB)).send({ name: "Super made" });
    expect(created.status).toBe(201);
    const id = created.body.model._id;
    expect(String((await sModel.findById(id)).orgId)).toBe(String(orgB._id));
    expect((await get(B.eng.token, `/api/models/${id}`)).status).toBe(200);
    expect((await get(A.eng.token, `/api/models/${id}`)).status).toBe(404);
    // archived and restored in the same organization
    expect((await auth(request(app).delete(`/api/models/${id}`), superAdmin.token).set(hdr(orgB)).send({})).status).toBe(200);
    expect((await auth(request(app).post(`/api/models/${id}/restore`), superAdmin.token).set(hdr(orgB)).send({})).status).toBe(200);
    // the same model is a 404 when the super admin has selected org A instead
    expect((await auth(request(app).delete(`/api/models/${id}`), superAdmin.token).set(hdr(orgA)).send({})).status).toBe(404);
    expect((await sModel.findById(id)).isDeleted).toBe(false);
  });

  test("super admin comments and simulated snapshots land in the selected org with a resolvable author", async () => {
    const c = await auth(request(app).post(`/api/versions/${A.v2._id}/comments`), superAdmin.token).set(hdr(orgA)).send({ body: "from platform" });
    expect(c.status).toBe(201);
    expect(c.body.comment).toMatchObject({ authorName: superAdmin.user.name, authorRole: "super_admin" });
    expect(String((await sComment.findById(c.body.comment._id)).orgId)).toBe(String(orgA._id));
    expect((await auth(request(app).post(`/api/versions/${B.v2._id}/comments`), superAdmin.token).set(hdr(orgA)).send({ body: "x" })).status).toBe(404);

    const sim = await auth(request(app).post(`/api/versions/${A.v1._id}/simulate-drift`), superAdmin.token).set(hdr(orgA));
    expect(sim.status).toBe(201);
    expect(String((await sSnapshot.findById(sim.body.snapshot._id)).orgId)).toBe(String(orgA._id));
    // the super admin has no organization of their own, so only the caller itself can be named
    const detail = await auth(request(app).get(`/api/versions/${A.v1._id}`), superAdmin.token).set(hdr(orgA));
    const mine = detail.body.snapshots.find((x) => x._id === sim.body.snapshot._id);
    expect(mine.createdByName).toBe(superAdmin.user.name);
  });
});

describe("separation of duties", () => {
  // The uploader's role is changed AFTER the upload (admins can edit roles): the server must still
  // refuse the review, whatever role they hold now.
  async function ownVersion(roleAfterUpload, submit = true) {
    const user = await makeUser("ml_engineer", { orgId: orgA._id });
    const m = await createModel(user.token, `SoD ${Math.random().toString(36).slice(2)}`);
    const v = await newVersion(user.token, m._id);
    if (submit) await post(user.token, `/api/versions/${v._id}/submit`).expect(200);
    await sys(User).updateOne({ _id: user.user._id }, { $set: { role: roleAfterUpload } });
    return { user, v, m };
  }

  test("an uploader turned compliance officer cannot approve, reject or request changes on their own version", async () => {
    const { user, v } = await ownVersion("compliance_officer");
    for (const decision of ["approve", "reject", "request_changes"]) {
      const res = await post(user.token, `/api/versions/${v._id}/review`, { decision, comment: "self review" });
      expect([decision, res.status, res.body.error]).toEqual([decision, 403, "You cannot review a version you uploaded"]);
    }
    expect((await sVersion.findById(v._id)).status).toBe("submitted");
    // another officer of the same org can
    const other = await post(A.officer.token, `/api/versions/${v._id}/review`, { decision: "approve", comment: "independent" });
    expect(other.status).toBe(200);
  });

  test("an uploader turned admin cannot deploy, retire or resolve a review of their own version", async () => {
    const { user, v } = await ownVersion("ml_engineer"); // uploader still an engineer while the officer approves
    await post(A.officer.token, `/api/versions/${v._id}/review`, { decision: "approve", comment: "ok" }).expect(200);
    await sys(User).updateOne({ _id: user.user._id }, { $set: { role: "admin" } });
    const dep = await post(user.token, `/api/versions/${v._id}/deploy`);
    expect([dep.status, dep.body.error]).toEqual([403, "You cannot review a version you uploaded"]);
    expect((await sVersion.findById(v._id)).status).toBe("approved");
    // somebody else deploys it
    expect((await post(A.admin.token, `/api/versions/${v._id}/deploy`)).status).toBe(200);

    const ret = await post(user.token, `/api/versions/${v._id}/retire`, { comment: "x" });
    expect([ret.status, ret.body.error]).toEqual([403, "You cannot review a version you uploaded"]);
    await sVersion.updateOne({ _id: v._id }, { $set: { status: "needs_review" } });
    const res = await post(user.token, `/api/versions/${v._id}/resolve-review`, { decision: "keep", comment: "x" });
    expect([res.status, res.body.error]).toEqual([403, "You cannot review a version you uploaded"]);
    expect((await sVersion.findById(v._id)).status).toBe("needs_review");
    // a different compliance officer resolves it
    expect((await post(A.officer.token, `/api/versions/${v._id}/resolve-review`, { decision: "keep", comment: "fine" })).status).toBe(200);
  });

  test("regular reviews by someone else are unaffected; super admin is not a reviewer", async () => {
    const m = await createModel(A.eng.token, "SoD regular");
    const v = await newVersion(A.eng.token, m._id);
    await post(A.eng.token, `/api/versions/${v._id}/submit`).expect(200);
    const sa = await auth(request(app).post(`/api/versions/${v._id}/review`), superAdmin.token).set({ "X-Org-Id": String(orgA._id) }).send({ decision: "approve", comment: "x" });
    expect(sa.status).toBe(403);
    expect((await post(A.officer.token, `/api/versions/${v._id}/review`, { decision: "approve", comment: "ok" })).status).toBe(200);
    expect((await post(A.officer.token, `/api/versions/${v._id}/deploy`)).status).toBe(200);
  });
});

describe("uploads through multer", () => {
  test("concurrent CSV uploads in two organizations: no leakage, right orgId on every stored row", async () => {
    const mA = await createModel(A.eng.token, "Concurrent A");
    const mB = await createModel(B.eng.token, "Concurrent B");
    const filesBefore = files();
    // The mock reads the uploaded file and answers by its content, after a random delay, so the
    // two requests interleave and a mixed-up path or context would show in the stored tier.
    computeMetrics.mockImplementation(async ({ primaryFilePath }) => {
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 40)));
      const marker = fs.readFileSync(primaryFilePath, "utf8");
      return marker.startsWith("org-a") ? GOOD : BAD;
    });
    const bufA = Buffer.from("org-a,predicted,actual\n1,0,0\n");
    const bufB = Buffer.from("org-b,predicted,actual\n1,0,0\n");
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      jobs.push(uploadCsv(A.eng.token, mA._id, { buffer: bufA, filename: `a${i}.csv` }));
      jobs.push(uploadCsv(B.eng.token, mB._id, { buffer: bufB, filename: `b${i}.csv` }));
    }
    const results = await Promise.all(jobs);
    results.forEach((r) => expect(r.status).toBe(201));
    results.forEach((r, i) => {
      expect(r.body.version.riskTier).toBe(i % 2 === 0 ? "low" : "high");
      expect(String(r.body.version.orgId)).toBe(String(i % 2 === 0 ? orgA._id : orgB._id));
    });
    for (const [m, org, name] of [[mA, orgA, "a"], [mB, orgB, "b"]]) {
      const rows = await sVersion.find({ modelId: m._id }).sort({ versionNumber: 1 }).lean();
      expect(rows.map((r) => r.versionNumber)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(rows.every((r) => String(r.orgId) === String(org._id))).toBe(true);
      expect(rows.every((r) => r.fileName.startsWith(name))).toBe(true);
      const snaps = await sSnapshot.find({ versionId: { $in: rows.map((r) => r._id) } }).lean();
      expect(snaps).toHaveLength(6);
      expect(snaps.every((s) => String(s.orgId) === String(org._id))).toBe(true);
    }
    expect(files()).toBe(filesBefore + 12); // local storage keeps every uploaded file
    // the audit rows of those uploads are filed under the uploader's own organization
    const uploads = await sAudit.find({ action: "upload_version", targetType: "Version", targetId: { $in: (await sVersion.find({ modelId: { $in: [mA._id, mB._id] } }).lean()).map((v) => v._id) } }).lean();
    expect(uploads).toHaveLength(12);
    for (const row of uploads) {
      const v = await sVersion.findById(row.targetId);
      expect(String(row.orgId)).toBe(String(v.orgId));
    }
  });

  test("a batch (monitoring) upload keeps the organization context after multer", async () => {
    computeMetrics.mockResolvedValue(GOOD);
    const [ra, rb] = await Promise.all([
      auth(request(app).post(`/api/versions/${A.v1._id}/monitoring-batch`), A.eng.token).attach("file", CSV, "a.csv"),
      auth(request(app).post(`/api/versions/${B.v1._id}/monitoring-batch`), B.eng.token).attach("file", CSV, "b.csv"),
    ]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(String((await sSnapshot.findById(ra.body.snapshot._id)).orgId)).toBe(String(orgA._id));
    expect(String((await sSnapshot.findById(rb.body.snapshot._id)).orgId)).toBe(String(orgB._id));
  });
});

describe("cleanup job", () => {
  test("sweeps files of every organization and only touches file paths", async () => {
    const { runCleanupOnce } = require("../jobs/cleanup");
    const env = require("../config/env");
    const old = new Date(Date.now() - (env.retentionDays + 2) * 864e5);
    const make = async (ctx) => {
      const m = await createModel(ctx.eng.token, `Cleanup ${Math.random().toString(36).slice(2)}`);
      const v = await newVersion(ctx.eng.token, m._id);
      await del(ctx.eng.token, `/api/versions/${v._id}`).expect(200);
      await sVersion.collection.updateOne({ _id: new mongoose.Types.ObjectId(v._id) }, { $set: { deletedAt: old } });
      return v;
    };
    const va = await make(A);
    const vb = await make(B);
    const res = await runCleanupOnce();
    expect(res.versionsUpdated).toBeGreaterThanOrEqual(2);
    for (const v of [va, vb]) {
      const row = await sVersion.findById(v._id).setOptions({ includeDeleted: true }).lean();
      expect(row.filePath).toBeNull();
      expect(row.isDeleted).toBe(true);
    }
  });
});
