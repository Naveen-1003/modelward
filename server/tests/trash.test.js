const request = require("supertest");
const app = require("../app");
const Model = require("../models/Model");
const Version = require("../models/Version");
const { connect, reset, disconnect, makeUser, defaultOrg, auth } = require("./helpers");

let eng, comp, admin, orgId;
const mk = (name, owner) => Model.create({ name, createdBy: owner._id, orgId });
const mv = (model, n, extra = {}) => Version.create({ modelId: model._id, versionNumber: n, fileType: "csv", createdBy: eng.user._id, orgId, ...extra });

beforeAll(async () => {
  await connect();
  await reset();
  orgId = (await defaultOrg())._id;
  eng = await makeUser("ml_engineer");
  comp = await makeUser("compliance_officer");
  admin = await makeUser("admin", { name: "Ada Admin" });
});
afterAll(disconnect);

describe("GET /api/trash", () => {
  test("401 / 403", async () => {
    expect((await request(app).get("/api/trash")).status).toBe(401);
    expect((await auth(request(app).get("/api/trash"), eng.token)).status).toBe(403);
    expect((await auth(request(app).get("/api/trash"), comp.token)).status).toBe(403);
  });

  test("empty trash", async () => {
    const r = await auth(request(app).get("/api/trash"), admin.token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ models: [], versions: [] });
  });

  test("lists archived models/versions, omits cascade children of archived models", async () => {
    // Live model with one individually archived version
    const live = await mk("Live model", eng.user);
    await mv(live, 1);
    const solo = await mv(live, 2, { status: "rejected" });
    await solo.softDelete({ by: eng.user._id, reason: "bad run" });

    // Archived model with a cascade-archived version (omitted) and one that was
    // archived on its own before the model (still listed)
    const gone = await mk("Gone model", admin.user);
    const c1 = await mv(gone, 1);
    const own = await mv(gone, 2, { status: "retired" });
    await own.softDelete({ by: admin.user._id, reason: "old" });
    await c1.softDelete({ by: admin.user._id, reason: "model archived", cascade: true });
    await new Promise((r) => setTimeout(r, 10));
    await gone.softDelete({ by: admin.user._id, reason: "obsolete" });

    // Cascade-flagged version whose model is NOT archived is not hidden
    const back = await mk("Restored model", admin.user);
    const orphanCascade = await mv(back, 1);
    await orphanCascade.softDelete({ by: admin.user._id, cascade: true });

    const r = await auth(request(app).get("/api/trash"), admin.token);
    expect(r.status).toBe(200);
    expect(r.body.models).toHaveLength(1);
    expect(r.body.models[0]).toMatchObject({ name: "Gone model", deleteReason: "obsolete", deletedByName: "Ada Admin" });

    const ids = r.body.versions.map((v) => String(v._id));
    expect(ids).toHaveLength(3);
    expect(ids).toContain(String(solo._id));
    expect(ids).toContain(String(own._id));
    expect(ids).toContain(String(orphanCascade._id));
    expect(ids).not.toContain(String(c1._id));

    const s = r.body.versions.find((v) => String(v._id) === String(solo._id));
    expect(s).toMatchObject({
      versionNumber: 2, status: "rejected", modelName: "Live model", deleteReason: "bad run",
      deletedByName: eng.user.name, deletedByCascade: false,
    });
    const o = r.body.versions.find((v) => String(v._id) === String(own._id));
    expect(o.modelName).toBe("Gone model"); // parent name resolved even though it's archived
    const times = r.body.versions.map((v) => new Date(v.deletedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a)); // newest first
  });
});
