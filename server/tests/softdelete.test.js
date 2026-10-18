jest.mock("../utils/metricsClient");

const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../app");
const Model = require("../models/Model");
const Version = require("../models/Version");
const AuditLog = require("../models/AuditLog");
const computeMetrics = require("../utils/metricsClient");
const { connect, reset, disconnect, makeUser, auth } = require("./helpers");
const { GOOD, createModel, newVersion, deploy, post, get } = require("./domainHelpers");

let engineer, engineerUser, engineer2, officer, admin, adminUser, model;

const del = (token, url, body) => auth(request(app).delete(url), token).send(body || {});
const setStatus = (id, status) => Version.updateOne({ _id: id }, { $set: { status } });
const rawVersion = (id) => Version.findById(id).setOptions({ includeDeleted: true });
const rawModel = (id) => Model.findById(id).setOptions({ includeDeleted: true });
const audit = async (targetId) => (await AuditLog.find({ targetId }).sort({ createdAt: 1, seq: 1 }).lean()).map((a) => a.action);

beforeAll(async () => {
  await connect();
  await reset();
  ({ token: engineer, user: engineerUser } = await makeUser("ml_engineer"));
  engineer2 = (await makeUser("ml_engineer")).token;
  officer = (await makeUser("compliance_officer")).token;
  ({ token: admin, user: adminUser } = await makeUser("admin"));
});
afterAll(disconnect);
beforeEach(async () => {
  computeMetrics.mockReset();
  computeMetrics.mockResolvedValue(GOOD);
  model = await createModel(engineer);
});

describe("archive version", () => {
  test.each(["draft", "changes_requested", "rejected", "upload_failed", "superseded", "retired"])("%s can be archived", async (status) => {
    const v = await newVersion(engineer, model._id);
    await setStatus(v._id, status);
    const res = await del(engineer, `/api/versions/${v._id}`, { reason: "cleanup" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const raw = await rawVersion(v._id);
    expect(raw).toMatchObject({ isDeleted: true, deleteReason: "cleanup", deletedByCascade: false, status });
    expect(String(raw.deletedBy)).toBe(String(engineerUser._id));
    expect(raw.deletedAt).toBeInstanceOf(Date);
    expect(await audit(v._id)).toContain("archive_version");
  });

  test.each(["submitted", "approved", "deployed", "needs_review"])("%s cannot be archived (409)", async (status) => {
    const v = await newVersion(engineer, model._id);
    await setStatus(v._id, status);
    const res = await del(engineer, `/api/versions/${v._id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(status);
    expect((await rawVersion(v._id)).isDeleted).toBe(false);
    expect((await del(admin, `/api/versions/${v._id}`)).status).toBe(409); // admins follow the same rules
  });

  test("owner or admin only; compliance officers and other engineers are refused", async () => {
    const v = await newVersion(engineer, model._id);
    expect((await del(engineer2, `/api/versions/${v._id}`)).status).toBe(403);
    expect((await del(officer, `/api/versions/${v._id}`)).status).toBe(403);
    expect((await request(app).delete(`/api/versions/${v._id}`)).status).toBe(401);
    expect((await del(admin, `/api/versions/${v._id}`, { reason: "admin cleanup" })).status).toBe(200);
  });

  test("reason validation, unknown ids, double archive", async () => {
    const v = await newVersion(engineer, model._id);
    expect((await del(engineer, `/api/versions/${v._id}`, { reason: "x".repeat(501) })).status).toBe(400);
    expect((await del(engineer, `/api/versions/${v._id}`, { reason: 5 })).status).toBe(400);
    expect((await del(engineer, "/api/versions/bad")).status).toBe(400);
    expect((await del(engineer, "/api/versions/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await del(engineer, `/api/versions/${v._id}`, { reason: "x".repeat(500) })).status).toBe(200);
    expect((await del(engineer, `/api/versions/${v._id}`)).status).toBe(404);
  });

  test("archived versions vanish from reads and cannot be acted on; version numbers are never reused", async () => {
    const v1 = await newVersion(engineer, model._id);
    const v2 = await newVersion(engineer, model._id);
    await del(engineer, `/api/versions/${v2._id}`).expect(200); // the LATEST version is archived
    expect((await get(engineer, `/api/versions/${v2._id}`)).status).toBe(404);
    expect((await post(engineer, `/api/versions/${v2._id}/submit`)).status).toBe(404);
    expect((await get(engineer, `/api/versions/${v2._id}/file`)).status).toBe(404);
    expect((await get(engineer, `/api/models/${model._id}/versions`)).body.versions.map((v) => v._id)).toEqual([v1._id]);
    expect((await get(engineer, `/api/models/${model._id}`)).body.model).toMatchObject({ versionCount: 1, latestVersionNumber: 1 });
    const v3 = await newVersion(engineer, model._id);
    expect(v3.versionNumber).toBe(3); // would be 2 with countDocuments-style numbering
    expect(await Version.countDocuments({ modelId: model._id })).toBe(2);
    expect(await Version.countDocuments({ modelId: model._id }).setOptions({ includeDeleted: true })).toBe(3);
  });
});

describe("restore version", () => {
  test("owner and admin can restore; status is preserved; others refused; double restore 409", async () => {
    const v = await newVersion(engineer, model._id);
    await setStatus(v._id, "retired");
    await del(engineer, `/api/versions/${v._id}`).expect(200);
    expect((await post(engineer2, `/api/versions/${v._id}/restore`)).status).toBe(403);
    expect((await post(officer, `/api/versions/${v._id}/restore`)).status).toBe(403);
    const res = await post(engineer, `/api/versions/${v._id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.version).toMatchObject({ _id: v._id, status: "retired" });
    expect(await rawVersion(v._id)).toMatchObject({ isDeleted: false, deleteReason: "", deletedBy: null, deletedAt: null });
    expect((await post(engineer, `/api/versions/${v._id}/restore`)).status).toBe(409);
    expect((await get(engineer, `/api/versions/${v._id}`)).status).toBe(200);
    expect(await audit(v._id)).toEqual(expect.arrayContaining(["archive_version", "restore_version"]));

    await del(engineer, `/api/versions/${v._id}`).expect(200);
    expect((await post(admin, `/api/versions/${v._id}/restore`)).status).toBe(200);
    expect((await post(engineer, "/api/versions/aaaaaaaaaaaaaaaaaaaaaaaa/restore")).status).toBe(404);
  });

  test("409 while the parent model is archived", async () => {
    const v = await newVersion(engineer, model._id);
    await del(engineer, `/api/versions/${v._id}`, { reason: "solo" }).expect(200);
    await del(admin, `/api/models/${model._id}`).expect(200);
    const res = await post(admin, `/api/versions/${v._id}/restore`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/model/i);
  });
});

describe("archive model", () => {
  test("admin only; 409 with a live version (deployed or needs_review); nothing changes on refusal", async () => {
    const v = await deploy(engineer, officer, (await newVersion(engineer, model._id))._id);
    expect((await del(engineer, `/api/models/${model._id}`)).status).toBe(403);
    expect((await del(officer, `/api/models/${model._id}`)).status).toBe(403);
    const r1 = await del(admin, `/api/models/${model._id}`);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toMatch(/live version/);
    await setStatus(v._id, "needs_review");
    expect((await del(admin, `/api/models/${model._id}`)).status).toBe(409);
    expect((await rawModel(model._id)).isDeleted).toBe(false);
    expect((await rawVersion(v._id)).isDeleted).toBe(false);
    await post(officer, `/api/versions/${v._id}/retire`, { comment: "done" }).expect(200);
    expect((await del(admin, `/api/models/${model._id}`, { reason: "x".repeat(501) })).status).toBe(400);
    expect((await del(admin, `/api/models/${model._id}`, { reason: "decommissioned" })).status).toBe(200);
  });

  test("cascades to versions (flagged as cascade), keeps individually archived ones separate, hides everything", async () => {
    const solo = await newVersion(engineer, model._id);
    const a = await newVersion(engineer, model._id);
    const b = await newVersion(engineer, model._id);
    await del(engineer, `/api/versions/${solo._id}`, { reason: "earlier" }).expect(200);

    const res = await del(admin, `/api/models/${model._id}`, { reason: "retiring the product" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const m = await rawModel(model._id);
    expect(m).toMatchObject({ isDeleted: true, deleteReason: "retiring the product", deletedByCascade: false });
    expect(String(m.deletedBy)).toBe(String(adminUser._id));
    for (const v of [a, b]) {
      expect(await rawVersion(v._id)).toMatchObject({ isDeleted: true, deletedByCascade: true, deleteReason: "retiring the product" });
    }
    expect(await rawVersion(solo._id)).toMatchObject({ isDeleted: true, deletedByCascade: false, deleteReason: "earlier" });

    expect((await get(engineer, `/api/models/${model._id}`)).status).toBe(404);
    expect((await get(engineer, `/api/models/${model._id}/versions`)).status).toBe(404);
    expect((await get(engineer, `/api/versions/${a._id}`)).status).toBe(404);
    const list = await get(engineer, `/api/models?q=${encodeURIComponent(model.name)}`);
    expect(list.body.total).toBe(0);
    expect((await post(engineer, `/api/versions/${a._id}/submit`)).status).toBe(404);
    expect((await del(admin, `/api/models/${model._id}`)).status).toBe(404); // already archived
    expect(await audit(model._id)).toEqual(["create_model", "archive_model"]);
  });
});

describe("restore model", () => {
  test("restores the model and only the versions archived with it", async () => {
    const solo = await newVersion(engineer, model._id);
    const a = await newVersion(engineer, model._id);
    await del(engineer, `/api/versions/${solo._id}`, { reason: "earlier" }).expect(200);
    await del(admin, `/api/models/${model._id}`, { reason: "x" }).expect(200);

    expect((await post(engineer, `/api/models/${model._id}/restore`)).status).toBe(403);
    expect((await post(officer, `/api/models/${model._id}/restore`)).status).toBe(403);
    const res = await post(admin, `/api/models/${model._id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.model).toMatchObject({ _id: model._id, name: model.name, versionCount: 1, latestVersionNumber: 2 });
    expect(await rawModel(model._id)).toMatchObject({ isDeleted: false, deleteReason: "", deletedBy: null, deletedAt: null });
    expect(await rawVersion(a._id)).toMatchObject({ isDeleted: false, deletedByCascade: false, deleteReason: "" });
    expect(await rawVersion(solo._id)).toMatchObject({ isDeleted: true, deleteReason: "earlier" }); // stays archived
    expect((await get(engineer, `/api/versions/${a._id}`)).status).toBe(200);
    expect((await post(admin, `/api/models/${model._id}/restore`)).status).toBe(409); // not archived any more
    // version numbering continues past archived ones
    expect((await newVersion(engineer, model._id)).versionNumber).toBe(3);
    expect(await audit(model._id)).toEqual(["create_model", "archive_model", "restore_model"]);
    expect((await post(admin, "/api/models/aaaaaaaaaaaaaaaaaaaaaaaa/restore")).status).toBe(404);
  });

  test("archived names can be reused; restoring into a name clash is 409 until the clash is archived", async () => {
    const name = `Reusable ${Date.now()}`;
    const first = await createModel(engineer, name);
    await del(admin, `/api/models/${first._id}`).expect(200);
    const second = await createModel(engineer, name.toUpperCase()); // same name, different case: allowed because the first is archived
    await del(admin, `/api/models/${second._id}`).expect(200);
    const third = await createModel(engineer, name.toLowerCase());

    const clash = await post(admin, `/api/models/${first._id}/restore`);
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/already exists/);
    expect((await rawModel(first._id)).isDeleted).toBe(true);

    await del(admin, `/api/models/${third._id}`).expect(200);
    expect((await post(admin, `/api/models/${first._id}/restore`)).status).toBe(200);
    // now `second` (archived, same name) cannot come back while `first` is active
    expect((await post(admin, `/api/models/${second._id}/restore`)).status).toBe(409);
  });
});

describe("soft-delete plugin behaviour", () => {
  test("queries exclude archived rows unless includeDeleted is set", async () => {
    const v = await newVersion(engineer, model._id);
    await del(engineer, `/api/versions/${v._id}`).expect(200);
    expect(await Version.findById(v._id)).toBeNull();
    expect(await Version.countDocuments({ modelId: model._id })).toBe(0);
    expect(await Version.findById(v._id).setOptions({ includeDeleted: true })).not.toBeNull();
    const agg = await Version.aggregate([{ $match: { modelId: new mongoose.Types.ObjectId(model._id) } }]);
    expect(agg).toHaveLength(0);
  });
});
