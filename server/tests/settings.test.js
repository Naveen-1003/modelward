const request = require("supertest");
const { runWithOrg } = require("../utils/tenant");
const { connect, reset, disconnect, makeUser, defaultOrg, sys, auth } = require("./helpers");

let app, Settings, AuditLog, User, getThresholds, DEFAULT_THRESHOLDS;

async function fresh() {
  await reset();
  await Promise.all([Settings.createIndexes(), AuditLog.createIndexes(), User.createIndexes()]);
}

beforeAll(async () => {
  await connect();
  app = require("../app");
  Settings = require("../models/Settings");
  AuditLog = require("../models/AuditLog");
  User = require("../models/User");
  ({ getThresholds, DEFAULT_THRESHOLDS } = require("../utils/settings"));
});
afterAll(disconnect);
beforeEach(fresh);

// getThresholds(orgId) reads Settings, which is tenant-scoped: outside a request it needs a context.
const thresholds = (orgId) => runWithOrg(orgId, () => getThresholds(orgId));

const good = { lowAccuracy: 0.9, lowFairnessGap: 0.05, mediumAccuracy: 0.75, mediumFairnessGap: 0.15, driftThreshold: 0.08 };

describe("GET", () => {
  test("defaults when no document; any authenticated role; 401 without token", async () => {
    expect((await request(app).get("/api/settings")).status).toBe(401);
    for (const role of ["ml_engineer", "compliance_officer", "admin"]) {
      const { token } = await makeUser(role);
      const res = await auth(request(app).get("/api/settings"), token);
      expect(res.status).toBe(200);
      expect(res.body.settings).toEqual(expect.objectContaining({ ...DEFAULT_THRESHOLDS, updatedAt: null, updatedBy: null }));
    }
    expect(await thresholds((await defaultOrg())._id)).toEqual({ ...DEFAULT_THRESHOLDS });
  });
});

describe("PUT", () => {
  test("non-admins get 403 and nothing changes", async () => {
    for (const role of ["ml_engineer", "compliance_officer"]) {
      const { token } = await makeUser(role);
      expect((await auth(request(app).put("/api/settings"), token).send(good)).status).toBe(403);
    }
    expect(await sys(Settings).countDocuments()).toBe(0);
  });

  test("admin saves; GET + getThresholds reflect it at once; one document per org; audited with before->after", async () => {
    const { token, user } = await makeUser("admin", { name: "Boss" });
    const orgId = (await defaultOrg())._id;
    let res = await auth(request(app).put("/api/settings"), token).send(good);
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual(expect.objectContaining({ ...good, updatedBy: String(user._id) }));
    expect(res.body.settings.updatedAt).toBeTruthy();

    res = await auth(request(app).get("/api/settings"), token);
    expect(res.body.settings).toEqual(expect.objectContaining(good));
    expect(await thresholds(orgId)).toEqual(good);

    await auth(request(app).put("/api/settings"), token).send({ ...good, driftThreshold: 0.2 });
    expect(await sys(Settings).countDocuments()).toBe(1);
    expect(String((await sys(Settings).findOne()).orgId)).toBe(String(orgId));
    expect((await thresholds(orgId)).driftThreshold).toBe(0.2);

    const logs = await sys(AuditLog).find({ action: "update_settings" }).sort({ seq: 1 });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => String(l.orgId) === String(orgId))).toBe(true);
    expect(logs[0].details).toContain("lowAccuracy 0.85->0.9");
    expect(logs[1].details).toBe("Thresholds changed: driftThreshold 0.08->0.2");
    expect(logs[1].actorName).toBe("Boss");
  });

  test.each([
    ["missing field", (b) => { delete b.driftThreshold; }],
    ["zero", (b) => { b.lowFairnessGap = 0; }],
    ["negative", (b) => { b.driftThreshold = -0.1; }],
    ["above 1", (b) => { b.lowAccuracy = 1.5; }],
    ["numeric string", (b) => { b.lowAccuracy = "0.9"; }],
    ["null", (b) => { b.mediumAccuracy = null; }],
    ["operator object", (b) => { b.lowAccuracy = { $gt: 0 }; }],
    ["lowAccuracy < mediumAccuracy", (b) => { b.lowAccuracy = 0.6; b.mediumAccuracy = 0.7; }],
    ["lowFairnessGap > mediumFairnessGap", (b) => { b.lowFairnessGap = 0.3; b.mediumFairnessGap = 0.2; }],
  ])("invalid: %s => 400 and nothing stored", async (_l, mutate) => {
    const { token } = await makeUser("admin");
    const body = { ...good };
    mutate(body);
    const res = await auth(request(app).put("/api/settings"), token).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(await sys(Settings).countDocuments()).toBe(0);
  });

  test("boundary values are accepted (equal tiers, 1.0)", async () => {
    const { token } = await makeUser("admin");
    const body = { lowAccuracy: 1, lowFairnessGap: 0.2, mediumAccuracy: 1, mediumFairnessGap: 0.2, driftThreshold: 1 };
    expect((await auth(request(app).put("/api/settings"), token).send(body)).status).toBe(200);
  });
});
