jest.mock("../utils/metricsClient");

const request = require("supertest");
const app = require("../app");
const computeMetrics = require("../utils/metricsClient");
const { connect, reset, disconnect, makeUser, auth } = require("./helpers");
const { GOOD, BAD, createModel, newVersion, deploy, post, get } = require("./domainHelpers");

let engineer, officer, admin;

beforeAll(async () => {
  await connect();
  await reset();
  engineer = (await makeUser("ml_engineer")).token;
  officer = (await makeUser("compliance_officer")).token;
  admin = (await makeUser("admin")).token;
});
afterAll(disconnect);
beforeEach(() => computeMetrics.mockReset());

describe("POST /api/models", () => {
  test("creates, trims, returns summary fields", async () => {
    const res = await post(engineer, "/api/models", { name: "  Credit Scorer  ", description: "d", useCase: "loans" });
    expect(res.status).toBe(201);
    expect(res.body.model).toMatchObject({
      name: "Credit Scorer",
      description: "d",
      useCase: "loans",
      versionCount: 0,
      latestVersionNumber: null,
      latestRiskTier: "unrated",
      liveVersionNumber: null,
      liveRiskTier: null,
      displayRiskTier: "unrated",
    });
    expect(res.body.model.__v).toBeUndefined();
  });

  test("admin may create, compliance officer may not", async () => {
    expect((await post(admin, "/api/models", { name: "Admin made" })).status).toBe(201);
    expect((await post(officer, "/api/models", { name: "Nope" })).status).toBe(403);
  });

  test.each([
    ["missing name", {}],
    ["empty name", { name: "" }],
    ["blank name", { name: "   " }],
    ["non-string name", { name: 5 }],
    ["operator object name", { name: { $gt: "" } }],
    ["name too long", { name: "x".repeat(121) }],
    ["description too long", { name: "ok", description: "x".repeat(2001) }],
    ["useCase too long", { name: "ok", useCase: "x".repeat(201) }],
    ["non-string description", { name: "ok", description: 5 }],
    ["client riskTier", { name: "ok", riskTier: "low" }],
    ["unknown key", { name: "ok", surprise: 1 }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await post(engineer, "/api/models", body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  test("accepts max-length boundary values", async () => {
    const res = await post(engineer, "/api/models", { name: "n".repeat(120), description: "d".repeat(2000), useCase: "u".repeat(200) });
    expect(res.status).toBe(201);
  });

  test("duplicate name is 409 case-insensitively; parallel duplicates yield exactly one 201", async () => {
    expect((await post(engineer, "/api/models", { name: "Dup Model" })).status).toBe(201);
    expect((await post(engineer, "/api/models", { name: "dup MODEL" })).status).toBe(409);
    expect((await post(engineer, "/api/models", { name: "  DUP model  " })).status).toBe(409);
    const results = await Promise.all(Array.from({ length: 6 }, () => post(engineer, "/api/models", { name: "Race Model" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });
});

describe("GET /api/models", () => {
  let a, b, c;
  beforeAll(async () => {
    a = await createModel(engineer, "Tier-Alpha (v1.0) [beta]");
    b = await createModel(engineer, "Tier-Bravo");
    c = await createModel(engineer, "Tier-Charlie");
    computeMetrics.mockResolvedValue(GOOD);
    const va = await newVersion(engineer, a._id);
    await deploy(engineer, officer, va._id); // Alpha: live low
    computeMetrics.mockResolvedValue(BAD);
    await newVersion(engineer, b._id); // Bravo: only a high draft
    // Charlie: unrated (no versions)
  });

  test("summary fields reflect live vs latest", async () => {
    computeMetrics.mockResolvedValue(BAD);
    await newVersion(engineer, a._id); // Alpha v2: high draft (latest), v1 still live low
    const res = await get(engineer, "/api/models?q=Tier-");
    expect(res.status).toBe(200);
    const alpha = res.body.models.find((m) => m._id === a._id);
    expect(alpha).toMatchObject({
      versionCount: 2,
      latestVersionNumber: 2,
      latestVersionStatus: "draft",
      latestRiskTier: "high",
      liveVersionNumber: 1,
      liveVersionStatus: "deployed",
      liveRiskTier: "low",
      displayRiskTier: "low", // live wins over the latest draft
    });
    const bravo = res.body.models.find((m) => m._id === b._id);
    expect(bravo).toMatchObject({ displayRiskTier: "high", liveVersionNumber: null, liveRiskTier: null });
    const charlie = res.body.models.find((m) => m._id === c._id);
    expect(charlie).toMatchObject({ displayRiskTier: "unrated", latestRiskTier: "unrated", versionCount: 0 });
  });

  test("pagination envelope + newest first", async () => {
    const res = await get(engineer, "/api/models?q=Tier-&limit=2&page=1");
    expect(res.body).toMatchObject({ page: 1, limit: 2, total: 3, pages: 2 });
    expect(res.body.models.map((m) => m.name)).toEqual(["Tier-Charlie", "Tier-Bravo"]);
    const p2 = await get(engineer, "/api/models?q=Tier-&limit=2&page=2");
    expect(p2.body.models.map((m) => m.name)).toEqual(["Tier-Alpha (v1.0) [beta]"]);
    expect((await get(engineer, "/api/models?q=Tier-")).body.limit).toBe(12);
  });

  test("q is a case-insensitive substring match with regex characters escaped", async () => {
    expect((await get(engineer, "/api/models?q=tier-brav")).body.models.map((m) => m.name)).toEqual(["Tier-Bravo"]);
    expect((await get(engineer, "/api/models?q=(v1.0)%20[beta]")).body.total).toBe(1);
    expect((await get(engineer, "/api/models?q=.*")).body.total).toBe(0);
    expect((await get(engineer, "/api/models?q=(")).status).toBe(200);
  });

  test("tier filter applies to displayRiskTier", async () => {
    const low = await get(engineer, "/api/models?q=Tier-&tier=low");
    expect(low.body.models.map((m) => m.name)).toEqual(["Tier-Alpha (v1.0) [beta]"]);
    expect((await get(engineer, "/api/models?q=Tier-&tier=high")).body.models.map((m) => m.name)).toEqual(["Tier-Bravo"]);
    expect((await get(engineer, "/api/models?q=Tier-&tier=unrated")).body.models.map((m) => m.name)).toEqual(["Tier-Charlie"]);
    expect((await get(engineer, "/api/models?q=Tier-&tier=medium")).body.total).toBe(0);
    const paged = await get(engineer, "/api/models?q=Tier-&tier=high&limit=1&page=2");
    expect(paged.body).toMatchObject({ total: 1, pages: 1, models: [] });
  });

  test.each(["page=0", "page=-1", "page=abc", "page=1.5", "limit=0", "limit=-3", "limit=x", "tier=bogus", "q[a]=1", "q=a&q=b"])(
    "invalid query %s is 400",
    async (qs) => {
      expect((await get(engineer, `/api/models?${qs}`)).status).toBe(400);
    }
  );

  test("limit above 100 is clamped", async () => {
    expect((await get(engineer, "/api/models?limit=1000")).body.limit).toBe(100);
  });

  test("requires auth", async () => {
    expect((await request(app).get("/api/models")).status).toBe(401);
  });
});

describe("GET /api/models/:id", () => {
  test("detail with summary, 400 on bad id, 404 on unknown", async () => {
    const m = await createModel(engineer);
    computeMetrics.mockResolvedValue(GOOD);
    await newVersion(engineer, m._id);
    const res = await get(officer, `/api/models/${m._id}`);
    expect(res.status).toBe(200);
    expect(res.body.model).toMatchObject({ _id: m._id, versionCount: 1, latestRiskTier: "low", displayRiskTier: "low" });
    expect((await get(officer, "/api/models/nope")).status).toBe(400);
    expect((await get(officer, "/api/models/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
  });
});

describe("summarizeModels", () => {
  test("is one aggregation for the whole list and tolerates unknown/empty ids", async () => {
    const { summarizeModels } = require("../utils/modelSummary");
    const mongoose = require("mongoose");
    const Version = require("../models/Version");
    const spy = jest.spyOn(Version, "aggregate");
    const m1 = await createModel(engineer);
    const m2 = await createModel(engineer);
    const out = await summarizeModels([m1._id, m2._id, String(new mongoose.Types.ObjectId()), "garbage"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.size).toBe(3);
    expect((await summarizeModels([])).size).toBe(0);
    spy.mockRestore();
  });
});
