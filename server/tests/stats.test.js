const request = require("supertest");
const app = require("../app");
const Model = require("../models/Model");
const Version = require("../models/Version");
const { connect, reset, disconnect, makeUser, auth } = require("./helpers");

let eng, comp, admin;

beforeAll(async () => {
  await connect();
  await reset();
  eng = await makeUser("ml_engineer");
  comp = await makeUser("compliance_officer");
  admin = await makeUser("admin");
  await makeUser("ml_engineer", { extra: { isActive: false } });
});
afterAll(disconnect);

const get = (token) => auth(request(app).get("/api/stats"), token);

describe("GET /api/stats", () => {
  test("401 without a token", async () => {
    expect((await request(app).get("/api/stats")).status).toBe(401);
  });

  test("zero state is fully populated", async () => {
    const r = await get(eng.token);
    expect(r.status).toBe(200);
    expect(r.body.totals).toEqual({ models: 0, versions: 0, live: 0, awaitingReview: 0, needsReview: 0 });
    expect(Object.keys(r.body.byStatus).sort()).toEqual([...Version.STATUSES].sort());
    expect(Object.values(r.body.byStatus).every((n) => n === 0)).toBe(true);
    expect(r.body.byTier).toEqual({ low: 0, medium: 0, high: 0, unrated: 0 });
    expect(r.body.needsReview).toEqual([]);
    expect(r.body.awaitingReview).toEqual([]);
  });

  describe("seeded dataset", () => {
    beforeAll(async () => {
      const uid = eng.user._id;
      const mk = (name) => Model.create({ name, createdBy: uid });
      const mv = (m, n, status, riskTier) =>
        Version.create({ modelId: m._id, versionNumber: n, fileType: "csv", createdBy: uid, status, riskTier });

      // Alpha: v2 deployed low is live, v3 draft high is latest -> display low
      const alpha = await mk("Alpha");
      await mv(alpha, 1, "superseded", "low");
      await mv(alpha, 2, "deployed", "low");
      await mv(alpha, 3, "draft", "high");
      // Beta: live needs_review high
      const beta = await mk("Beta");
      await mv(beta, 1, "needs_review", "high");
      // Gamma: no live version; latest (v1) is submitted medium
      const gamma = await mk("Gamma");
      await mv(gamma, 1, "submitted", "medium");
      // Delta: no versions -> unrated
      await mk("Delta");
      // Archived model + versions must not count anywhere
      const ghost = await mk("Ghost");
      const gv = await mv(ghost, 1, "needs_review", "high");
      await gv.softDelete({ by: uid, cascade: true });
      await ghost.softDelete({ by: uid });
      const archivedVer = await mv(gamma, 2, "rejected", "low");
      await archivedVer.softDelete({ by: uid });
      // A newer awaiting-review version
      await new Promise((r) => setTimeout(r, 15));
      await mv(alpha, 4, "submitted", null);
    });

    test("totals, byStatus, byTier", async () => {
      const r = await get(comp.token);
      expect(r.status).toBe(200);
      expect(r.body.totals).toEqual({ models: 4, versions: 6, live: 2, awaitingReview: 2, needsReview: 1 });
      expect(r.body.byStatus).toMatchObject({ superseded: 1, deployed: 1, draft: 1, needs_review: 1, submitted: 2, rejected: 0, approved: 0 });
      // Alpha live low, Beta live high, Gamma latest medium, Delta unrated
      expect(r.body.byTier).toEqual({ low: 1, medium: 1, high: 1, unrated: 1 });
    });

    test("needsReview / awaitingReview lists", async () => {
      const r = await get(eng.token);
      expect(r.body.needsReview).toHaveLength(1);
      expect(r.body.needsReview[0]).toMatchObject({ modelName: "Beta", versionNumber: 1, riskTier: "high" });
      expect(r.body.needsReview[0].versionId).toBeTruthy();
      expect(r.body.needsReview[0].modelId).toBeTruthy();
      expect(r.body.awaitingReview.map((v) => `${v.modelName}#${v.versionNumber}`)).toEqual(["Alpha#4", "Gamma#1"]); // newest first
    });

    test("users only for admin", async () => {
      const a = await get(admin.token);
      expect(a.body.users).toEqual({ total: 4, active: 3, byRole: { ml_engineer: 2, compliance_officer: 1, admin: 1 } });
      expect((await get(eng.token)).body.users).toBeUndefined();
      expect((await get(comp.token)).body.users).toBeUndefined();
    });

    test("lists are capped at 10", async () => {
      const m = await Model.create({ name: "Bulk", createdBy: eng.user._id });
      await Version.insertMany(Array.from({ length: 12 }, (_, i) => ({
        modelId: m._id, versionNumber: i + 1, fileType: "csv", createdBy: eng.user._id, status: "submitted",
      })));
      const r = await get(eng.token);
      expect(r.body.awaitingReview).toHaveLength(10);
      expect(r.body.totals.awaitingReview).toBe(14);
    });
  });
});
