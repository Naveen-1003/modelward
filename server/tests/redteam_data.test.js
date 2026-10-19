// Red-team review R1: adversarial tenant-isolation tests for the data routes
// (models, versions, comments, trash, stats, settings, audit-log, files) and the middleware around them.
//
// Written independently of the feature's own tests. Principles:
//   * the route inventory is read from the live express router, so a route added later without a
//     test (or an explicit exemption below) FAILS "route inventory";
//   * "another organization's id" must be INDISTINGUISHABLE from "an id that exists nowhere"
//     (same status, same body), for every role, in both directions, live and archived rows;
//   * nothing may change in the other organization, on disk or in the database;
//   * the audit trail must not become an existence oracle for the caller.
jest.mock("../utils/metricsClient");
jest.setTimeout(240000);

const fs = require("fs");
const path = require("path");
const http = require("http");
const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const app = require("../app");
const env = require("../config/env");
const computeMetrics = require("../utils/metricsClient");
const Model = require("../models/Model");
const Version = require("../models/Version");
const MetricSnapshot = require("../models/MetricSnapshot");
const Comment = require("../models/Comment");
const AuditLog = require("../models/AuditLog");
const Settings = require("../models/Settings");
const User = require("../models/User");
const Organization = require("../models/Organization");
const { UPLOAD_DIR } = require("../middleware/upload");
const rateLimit = require("../middleware/rateLimit");
const { runWithOrg, runSystem, TenantContextError } = require("../utils/tenant");
const { connect, reset, disconnect, makeUser, makeOrg, sys, auth } = require("./helpers");
const { GOOD, MEDIUM, BAD, CSV, uploadCsv, createModel, newVersion, post, get, deploy } = require("./domainHelpers");

const sModel = sys(Model);
const sVersion = sys(Version);
const sSnapshot = sys(MetricSnapshot);
const sComment = sys(Comment);
const sAudit = sys(AuditLog);
const sSettings = sys(Settings);
const sUser = sys(User);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => String(new mongoose.Types.ObjectId());
const has = (obj, re) => re.test(JSON.stringify(obj));
const files = () => fs.readdirSync(UPLOAD_DIR).length;

// Every row of an organization carries its token, so a leak is a plain regex match.
const TOKEN = { A: /ALPHAXQ/i, B: /BRAVOXQ/i };

let orgA, orgB;
let A, B; // { org, admin, eng, officer, model, v1..v4, vArch, archModel, archVersion, pending, label }
let sup; // super admin

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------
async function seed(org, label) {
  const tok = `${label}XQ`; // ALPHAXQ / BRAVOXQ
  const ctx = {
    label,
    org,
    admin: await makeUser("admin", { orgId: org._id, name: `${tok} Admin` }),
    eng: await makeUser("ml_engineer", { orgId: org._id, name: `${tok} Eng` }),
    officer: await makeUser("compliance_officer", { orgId: org._id, name: `${tok} Officer` }),
  };
  computeMetrics.mockReset();
  computeMetrics.mockResolvedValue(GOOD);
  ctx.model = await createModel(ctx.eng.token, `${tok} Credit Scorer`);
  ctx.v1 = await deploy(ctx.eng.token, ctx.officer.token, (await newVersion(ctx.eng.token, ctx.model._id))._id);
  ctx.v2 = await newVersion(ctx.eng.token, ctx.model._id);
  ctx.v3 = await newVersion(ctx.eng.token, ctx.model._id);
  await post(ctx.eng.token, `/api/versions/${ctx.v3._id}/submit`).expect(200);
  computeMetrics.mockRejectedValueOnce(Object.assign(new Error("service down"), { retryable: true }));
  ctx.v4 = await newVersion(ctx.eng.token, ctx.model._id);
  expect(ctx.v4.status).toBe("upload_failed");
  // an individually archived version
  ctx.vArch = await newVersion(ctx.eng.token, ctx.model._id);
  await auth(request(app).delete(`/api/versions/${ctx.vArch._id}`), ctx.eng.token).send({ reason: `${tok} gone` }).expect(200);
  // an archived model with a cascade-archived version
  ctx.archModel = await createModel(ctx.eng.token, `${tok} Archived Model`);
  ctx.archVersion = await newVersion(ctx.eng.token, ctx.archModel._id);
  await auth(request(app).delete(`/api/models/${ctx.archModel._id}`), ctx.admin.token).send({ reason: `${tok} retired` }).expect(200);
  ctx.comment = (await post(ctx.eng.token, `/api/versions/${ctx.v2._id}/comments`, { body: `${tok} private comment` })).body.comment;
  ctx.pending = await makeUser("ml_engineer", { orgId: org._id, status: "pending", name: `${tok} Pending` });
  // distinctive thresholds
  await auth(request(app).put("/api/settings"), ctx.admin.token)
    .send(label === "ALPHA"
      ? { lowAccuracy: 0.9137, lowFairnessGap: 0.0411, mediumAccuracy: 0.7311, mediumFairnessGap: 0.2111, driftThreshold: 0.0731 }
      : { lowAccuracy: 0.8837, lowFairnessGap: 0.0611, mediumAccuracy: 0.6811, mediumFairnessGap: 0.2411, driftThreshold: 0.1331 })
    .expect(200);
  return ctx;
}

beforeAll(async () => {
  await connect();
  await reset();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  orgA = await makeOrg({ name: "Org One" });
  orgB = await makeOrg({ name: "Org Two" });
  A = await seed(orgA, "ALPHA");
  B = await seed(orgB, "BRAVO");
  sup = await makeUser("super_admin");
});
afterAll(async () => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  await disconnect();
});
beforeEach(() => {
  rateLimit.resetAll();
  computeMetrics.mockReset();
  computeMetrics.mockResolvedValue(GOOD);
});

const orgHdr = (org) => ({ "X-Org-Id": String(org._id) });
const send = (actor, method, url, { body, upload, headers } = {}) => {
  let req = request(app)[method.toLowerCase()](url);
  req = auth(req, actor.token).set(headers || {});
  if (upload === "version") return req.field("fileType", "csv").field("latencyMs", "5").attach("file", CSV, "x.csv");
  if (upload === "batch") return req.attach("file", CSV, "x.csv");
  return body !== undefined || method !== "GET" ? req.send(body || {}) : req;
};

// Everything that a wrongful write could touch, except the audit log.
async function dbState() {
  return JSON.stringify({
    models: await sModel.find().setOptions({ includeDeleted: true }).sort({ _id: 1 }).lean(),
    versions: await sVersion.find().setOptions({ includeDeleted: true }).sort({ _id: 1 }).lean(),
    snapshots: await sSnapshot.find().sort({ _id: 1 }).lean(),
    comments: await sComment.find().sort({ _id: 1 }).lean(),
    settings: await sSettings.find().sort({ _id: 1 }).lean(),
    users: await sUser.find().sort({ _id: 1 }).lean(),
    orgs: await Organization.find().sort({ _id: 1 }).lean(),
  });
}

// ---------------------------------------------------------------------------------------------
// route inventory
// ---------------------------------------------------------------------------------------------
function mountPath(layer) {
  return layer.regexp.source.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/, "").replace(/\\\//g, "/");
}
// Every route of the live express app: { key: "GET /api/x/:id", authed } -- a router-level
// `router.use(authGuard, ...)` counts for every route registered after it.
function inventory() {
  const out = [];
  const walk = (stack, prefix, inherited) => {
    let authed = inherited;
    for (const layer of stack) {
      if (layer.route) {
        const names = layer.route.stack.map((s) => s.handle.name);
        const full = (prefix + layer.route.path).replace(/(.)\/$/, "$1");
        for (const m of Object.keys(layer.route.methods)) {
          out.push({ key: `${m.toUpperCase()} ${full}`, authed: authed || names.includes("authGuard") });
        }
      } else if (layer.name === "authGuard") authed = true;
      else if (layer.name === "router" && layer.handle.stack) walk(layer.handle.stack, prefix + mountPath(layer), authed);
    }
  };
  walk(app._router.stack, "", false);
  return out;
}

// Routes that answer without a token. Adding one here is a conscious, reviewed decision.
const PUBLIC_ROUTES = [
  "GET /health",
  "GET /api/config",
  "POST /api/auth/signup",
  "POST /api/auth/verify-email/check",
  "POST /api/auth/verify-email",
  "POST /api/auth/resend-verification",
  "POST /api/auth/setup-password/check",
  "POST /api/auth/setup-password",
  "POST /api/auth/login",
];

// Authenticated routes addressed by an id of some resource: the matrix below probes every one of
// them with the other organization's ids (live and archived) as every role of the acting org.
const R = (method, tpl, kind, extra = {}) => ({ method, tpl, kind, key: `${method} ${tpl}`, ...extra });
const ID_ROUTES = [
  R("GET", "/api/models/:id", "model"),
  R("DELETE", "/api/models/:id", "model", { body: { reason: "pwned" } }),
  R("POST", "/api/models/:id/restore", "model"),
  R("POST", "/api/models/:modelId/versions", "model", { upload: "version" }),
  R("GET", "/api/models/:modelId/versions", "model"),
  R("GET", "/api/versions/:id", "version"),
  R("PATCH", "/api/versions/:id/notes", "version", { body: { trainingNotes: "pwned" } }),
  R("POST", "/api/versions/:id/submit", "version"),
  R("POST", "/api/versions/:id/withdraw", "version"),
  R("POST", "/api/versions/:id/retry", "version"),
  R("POST", "/api/versions/:id/review", "version", { body: { decision: "approve", comment: "pwned" } }),
  R("POST", "/api/versions/:id/deploy", "version"),
  R("POST", "/api/versions/:id/retire", "version", { body: { comment: "pwned" } }),
  R("POST", "/api/versions/:id/resolve-review", "version", { body: { decision: "keep", comment: "pwned" } }),
  R("POST", "/api/versions/:id/simulate-drift", "version"),
  R("POST", "/api/versions/:id/monitoring-batch", "version", { upload: "batch" }),
  R("DELETE", "/api/versions/:id", "version", { body: { reason: "pwned" } }),
  R("POST", "/api/versions/:id/restore", "version"),
  R("GET", "/api/versions/:id/file", "version", { queries: ["", "?which=dataset"] }),
  R("GET", "/api/versions/:id/comments", "version"),
  R("POST", "/api/versions/:id/comments", "version", { body: { body: "pwned" } }),
  R("DELETE", "/api/users/:id", "user"),
  R("PATCH", "/api/users/:id", "user", { body: { name: "pwned" } }),
  R("POST", "/api/users/:id/approve", "user"),
  R("POST", "/api/users/:id/reject", "user"),
  R("POST", "/api/users/:id/setup-link", "user"),
  R("PATCH", "/api/orgs/:id", "org", { body: { name: "pwned" }, platform: true }),
];
// Routes without an id: covered by the "list endpoints" tests below.
const COLLECTION_ROUTES = [
  "POST /api/models",
  "GET /api/models",
  "GET /api/versions",
  "GET /api/stats",
  "GET /api/trash",
  "GET /api/settings",
  "PUT /api/settings",
  "GET /api/audit-log",
  "GET /api/audit-log/export",
  "GET /api/audit-log/verify",
];
// Reviewed elsewhere (the user / organization / auth flows belong to other suites); a route listed
// here must be mentioned by at least one OTHER test file, checked below.
const ELSEWHERE_ROUTES = [
  "GET /api/auth/me",
  "GET /api/orgs",
  "POST /api/orgs",
  "GET /api/orgs/current",
  "PATCH /api/orgs/current",
  "PUT /api/orgs/current/codes/:kind",
  "POST /api/orgs/current/codes/:kind/regenerate",
  "GET /api/users",
  "GET /api/users/pending",
  "POST /api/users/pending/approve-all",
  "POST /api/users",
];

describe("route inventory", () => {
  const routes = inventory();
  const authed = routes.filter((r) => r.authed).map((r) => r.key);
  const open = routes.filter((r) => !r.authed).map((r) => r.key);

  test("only the reviewed public routes answer without authGuard", () => {
    expect(open.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });

  test("every authenticated route is covered by the matrix, the list tests or an explicit exemption (and nothing stale is listed)", () => {
    const covered = [...ID_ROUTES.map((r) => r.key), ...COLLECTION_ROUTES, ...ELSEWHERE_ROUTES];
    const missing = authed.filter((k) => !covered.includes(k));
    const stale = covered.filter((k) => !authed.includes(k));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  test("exempted routes are at least exercised by another test file", () => {
    const dir = __dirname;
    const corpus = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".test.js") && f !== path.basename(__filename))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    for (const key of ELSEWHERE_ROUTES) {
      const stem = key.split(" ")[1].split("/:")[0]; // "/api/orgs/current/codes"
      expect([key, corpus.includes(stem)]).toEqual([key, true]);
    }
  });

  test("a super admin without a selected organization is refused (400 ORG_REQUIRED) by every organization route", async () => {
    const platform = new Set(["PATCH /api/orgs/:id"]); // platform routes may run without an organization
    for (const r of ID_ROUTES.filter((x) => !platform.has(x.key))) {
      const url = r.tpl.replace(/:\w+/, rid());
      const res = await send(sup, r.method, url, { body: r.body, upload: r.upload });
      expect([r.key, res.status, res.body.code]).toEqual([r.key, 400, "ORG_REQUIRED"]);
    }
    for (const key of ["POST /api/models", "GET /api/models", "GET /api/versions", "GET /api/stats", "GET /api/trash", "GET /api/settings", "PUT /api/settings"]) {
      const [m, u] = key.split(" ");
      const res = await send(sup, m, u, { body: m === "GET" ? undefined : {} });
      expect([key, res.status, res.body.code]).toEqual([key, 400, "ORG_REQUIRED"]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// the id matrix
// ---------------------------------------------------------------------------------------------
function targetsOf(ctx) {
  return {
    model: [["live model", ctx.model._id], ["archived model", ctx.archModel._id]],
    version: [
      ["deployed", ctx.v1._id],
      ["draft", ctx.v2._id],
      ["submitted", ctx.v3._id],
      ["upload_failed", ctx.v4._id],
      ["archived on its own", ctx.vArch._id],
      ["archived with its model", ctx.archVersion._id],
    ],
    user: [["admin", ctx.admin.user._id], ["engineer", ctx.eng.user._id], ["officer", ctx.officer.user._id], ["pending", ctx.pending.user._id]],
    org: [["org", ctx.org._id]],
  };
}

describe("another organization's ids are indistinguishable from ids that exist nowhere", () => {
  const probed = new Set();

  // Runs every id route as `actor` (a member of org `me`, or the super admin inside it) against the
  // ids of `other`, and compares each answer with the answer for a random, nonexistent id.
  async function sweep(actorsOf, me, other) {
    const before = await dbState();
    const filesBefore = files();
    const lastSeq = ((await sAudit.findOne({ seq: { $exists: true } }).sort({ seq: -1 }).lean()) || {}).seq || 0;
    for (const [actorName, actor, headers] of actorsOf(me)) {
      rateLimit.resetAll();
      for (const route of ID_ROUTES) {
        if (route.platform && actor.user.role === "super_admin") continue; // super admin edits organizations legitimately
        const targets = targetsOf(other)[route.kind];
        for (const query of route.queries || [""]) {
          const call = (id) => send(actor, route.method, route.tpl.replace(/:\w+/, id) + query, { body: route.body, upload: route.upload, headers });
          const baseline = await call(rid());
          if (baseline.status === 404) probed.add(route.key);
          for (const [label, id] of targets) {
            const res = await call(String(id));
            const where = `${route.key}${query} as ${me.label}/${actorName} on ${other.label} ${label}`;
            expect([where, res.status]).toEqual([where, baseline.status]);
            expect([where, res.body]).toEqual([where, baseline.body]);
            expect([where, res.status < 300]).toEqual([where, false]);
            expect([where, has(res.body, TOKEN[other.label[0]])]).toEqual([where, false]);
            expect([where, has(res.text, /BRAVOXQ|ALPHAXQ/i) && !has(res.text, TOKEN[me.label[0]])]).toEqual([where, false]);
          }
        }
      }
    }
    expect(await dbState()).toBe(before);
    expect(files()).toBe(filesBefore);
    // only probe records may appear: nothing else was written by any of those requests
    const fresh = await sAudit.find({ seq: { $gt: lastSeq } }).lean();
    for (const row of fresh) expect(["cross_org_attempt", "org_access"]).toContain(row.action);
  }

  const orgActors = (ctx) => [
    ["admin", ctx.admin],
    ["engineer", ctx.eng],
    ["officer", ctx.officer],
    ["super admin", sup, orgHdr(ctx.org)],
  ];

  test("A -> B: every role, every route, live and archived rows", async () => {
    await sweep(orgActors, A, B);
  });
  test("B -> A: every role, every route, live and archived rows", async () => {
    await sweep(orgActors, B, A);
  });

  test("every id route really was probed (a 404 baseline existed for at least one role)", () => {
    const unprobed = ID_ROUTES.filter((r) => !probed.has(r.key)).map((r) => r.key);
    // PATCH /api/orgs/:id answers 403 to every org user: nothing to compare there
    expect(unprobed.filter((k) => k !== "PATCH /api/orgs/:id")).toEqual([]);
  });

  test("sanity: the same routes do work on the caller's own ids (the matrix is not vacuous)", async () => {
    expect((await get(A.eng.token, `/api/models/${A.model._id}`)).status).toBe(200);
    expect((await get(A.eng.token, `/api/versions/${A.v2._id}`)).status).toBe(200);
    expect((await get(A.eng.token, `/api/versions/${A.v2._id}/comments`)).status).toBe(200);
    expect((await get(A.eng.token, `/api/versions/${A.v1._id}/file`)).status).toBe(200);
    expect((await get(B.officer.token, `/api/models/${B.model._id}/versions`)).status).toBe(200);
    expect((await auth(request(app).get(`/api/versions/${A.v2._id}`), sup.token).set(orgHdr(orgA))).status).toBe(200);
    expect((await auth(request(app).get(`/api/versions/${A.v2._id}`), sup.token).set(orgHdr(orgB))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// list / aggregate endpoints
// ---------------------------------------------------------------------------------------------
describe("lists, counts, aggregates and search never include the other organization", () => {
  const LISTS = (me, other) => {
    const o = other.label[0] === "A" ? "ALPHAXQ" : "BRAVOXQ";
    return [
      "/api/models?limit=100",
      `/api/models?q=${o}`,
      "/api/models?tier=low&limit=100",
      "/api/models?tier=unrated&limit=100",
      "/api/models?tier=high&limit=100",
      "/api/versions?limit=100",
      `/api/versions?q=${o}`,
      "/api/versions?status=deployed,submitted,draft,upload_failed&limit=100",
      `/api/models/${me.model._id}/versions`,
      "/api/stats",
      "/api/settings",
      `/api/audit-log?q=${o}`,
      `/api/audit-log?limit=100&actorRole=ml_engineer&orgId=${other.org._id}`,
      "/api/audit-log/export",
    ];
  };

  for (const [name, me, other] of [["ALPHA", () => A, () => B], ["BRAVO", () => B, () => A]]) {
    test(`${name} members see only their own rows, totals are exact, searching for the other organization's names finds nothing`, async () => {
      const M = me();
      const O = other();
      for (const who of [M.admin, M.officer, M.eng]) {
        for (const url of LISTS(M, O)) {
          const res = await get(who.token, url);
          if (res.status === 403) continue; // role not allowed for this view
          expect([url, res.status]).toEqual([url, 200]);
          expect([M.label, who.user.role, url, has(res.status === 200 ? res.text : "", TOKEN[O.label[0]])]).toEqual([M.label, who.user.role, url, false]);
        }
      }
      // totals are exactly this organization's counts
      const models = await get(M.eng.token, "/api/models?limit=100");
      expect(models.body.total).toBe(await sModel.countDocuments({ orgId: M.org._id }));
      const stats = await get(M.admin.token, "/api/stats");
      expect(stats.body.totals.models).toBe(await sModel.countDocuments({ orgId: M.org._id }));
      expect(stats.body.totals.versions).toBe(
        await sVersion.countDocuments({ orgId: M.org._id, modelId: { $in: (await sModel.find({ orgId: M.org._id }).lean()).map((m) => m._id) } })
      );
      expect(stats.body.users.total).toBe(await sUser.countDocuments({ orgId: M.org._id, status: { $in: ["active", "invited"] } }));
      expect(stats.body.users.pending).toBe(1);
      // the model-name search of the other organization is empty, not "no permission"
      const q = await get(M.eng.token, `/api/models?q=${O.label}XQ`);
      expect(q.body).toMatchObject({ total: 0, models: [] });
      const vq = await get(M.eng.token, `/api/versions?q=${O.label}XQ`);
      expect(vq.body).toMatchObject({ total: 0, versions: [] });
    });
  }

  test("trash and thresholds are per organization", async () => {
    const tA = await get(A.admin.token, "/api/trash");
    expect(tA.status).toBe(200);
    expect(has(tA.body, TOKEN.B)).toBe(false);
    expect(tA.body.models.map((m) => m._id)).toEqual([String(A.archModel._id)]);
    expect(tA.body.versions.map((v) => v._id)).toEqual([String(A.vArch._id)]);
    expect((await get(A.eng.token, "/api/trash")).status).toBe(403);
    expect((await get(A.admin.token, "/api/settings")).body.settings.lowAccuracy).toBe(0.9137);
    expect((await get(B.admin.token, "/api/settings")).body.settings.lowAccuracy).toBe(0.8837);
    // a PUT in A never touches B
    const beforeB = JSON.stringify(await sSettings.findOne({ orgId: orgB._id }).lean());
    await auth(request(app).put("/api/settings"), A.admin.token)
      .send({ lowAccuracy: 0.9137, lowFairnessGap: 0.0411, mediumAccuracy: 0.7311, mediumFairnessGap: 0.2111, driftThreshold: 0.0731, orgId: String(orgB._id) })
      .expect(200);
    expect(JSON.stringify(await sSettings.findOne({ orgId: orgB._id }).lean())).toBe(beforeB);
    expect(await sSettings.countDocuments({ orgId: orgA._id })).toBe(1);
  });

  test("versions are scored with the caller's own thresholds only", async () => {
    // 0.95 accuracy / 0.02 gap: low under both, but a MEDIUM result lands differently per org
    computeMetrics.mockResolvedValue({ ...MEDIUM, accuracy: 0.9, fairnessGap: 0.05 });
    const vA = await newVersion(A.eng.token, A.model._id); // A: lowAccuracy 0.9137 -> not low
    const vB = await newVersion(B.eng.token, B.model._id); // B: lowAccuracy 0.8837 / gap 0.0611 -> low
    expect(vA.riskTier).toBe("medium");
    expect(vB.riskTier).toBe("low");
    expect(vA.thresholdsUsed.lowAccuracy).toBe(0.9137);
    expect(vB.thresholdsUsed.lowAccuracy).toBe(0.8837);
  });
});

// ---------------------------------------------------------------------------------------------
// the audit trail must not be an existence oracle
// ---------------------------------------------------------------------------------------------
describe("audit trail does not reveal that another organization's id exists", () => {
  test("cross_org_attempt rows are written, but invisible to organization users (list, filter, export, verify)", async () => {
    const target = await createModel(B.eng.token, "BRAVOXQ probe target");
    const probeId = String(target._id);
    const missId = rid();
    const verifyBefore = (await get(A.admin.token, "/api/audit-log/verify")).body;
    const totalBefore = (await get(A.admin.token, "/api/audit-log?limit=1")).body.total;

    expect((await get(A.eng.token, `/api/models/${probeId}`)).status).toBe(404);
    expect((await get(A.eng.token, `/api/models/${missId}`)).status).toBe(404);

    // 1. the probe IS recorded (the platform owner must be able to see it) ...
    const rows = await sAudit.find({ action: "cross_org_attempt", actorId: A.eng.user._id, targetId: new mongoose.Types.ObjectId(probeId) }).lean();
    expect(rows).toHaveLength(1);
    expect(await sAudit.countDocuments({ action: "cross_org_attempt", targetId: new mongoose.Types.ObjectId(missId) })).toBe(0);

    // 2. ... but no organization user can tell: not the one who probed, not an admin or officer of that org
    for (const who of [A.eng, A.admin, A.officer]) {
      for (const url of [
        "/api/audit-log?limit=100",
        "/api/audit-log?limit=100&action=cross_org_attempt",
        `/api/audit-log?q=${probeId}`,
        `/api/audit-log?targetType=Model&limit=100`,
        "/api/audit-log/export",
      ]) {
        const res = await get(who.token, url);
        if (res.status === 403) continue;
        expect([who.user.role, url, res.status]).toEqual([who.user.role, url, 200]);
        expect([who.user.role, url, /cross_org_attempt|outside this organization/.test(res.text), res.text.includes(probeId)]).toEqual([who.user.role, url, false, false]);
      }
    }
    expect((await get(A.admin.token, "/api/audit-log?limit=1")).body.total).toBe(totalBefore);
    const verifyAfter = (await get(A.admin.token, "/api/audit-log/verify")).body;
    expect(verifyAfter.entries).toBe(verifyBefore.entries); // the hidden row is not even counted

    // 3. the platform owner still sees it, inside the organization it happened in and in the all-orgs view
    const inOrg = await auth(request(app).get("/api/audit-log?action=cross_org_attempt&limit=100"), sup.token).set(orgHdr(orgA));
    expect(inOrg.body.logs.map((l) => l.targetId)).toContain(probeId);
    const all = await get(sup.token, `/api/audit-log?action=cross_org_attempt&orgId=${orgA._id}&limit=100`);
    expect(all.body.logs.map((l) => l.targetId)).toContain(probeId);
  });

  test("the other organization never sees the probe either", async () => {
    expect((await get(A.eng.token, `/api/versions/${B.v1._id}`)).status).toBe(404);
    for (const url of ["/api/audit-log?limit=100", "/api/audit-log?action=cross_org_attempt"]) {
      const res = await get(B.admin.token, url);
      expect(/cross_org_attempt/.test(res.text)).toBe(false);
      expect(res.text.includes(String(A.eng.user._id))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// X-Org-Id, JWT claims, status checks
// ---------------------------------------------------------------------------------------------
describe("X-Org-Id and identity", () => {
  const DATA_URLS = (ctx) => ["/api/models?limit=100", "/api/versions?limit=100", "/api/stats", "/api/settings", `/api/versions/${ctx.v1._id}`];

  test("non-super users: the header is ignored (valid foreign id, garbage, duplicates, empty), never honoured, never an error", async () => {
    const lastSeq = ((await sAudit.findOne({ seq: { $exists: true } }).sort({ seq: -1 }).lean()) || {}).seq || 0;
    const variants = [String(orgB._id), String(orgB._id).toUpperCase(), "not-an-id", "", `${orgB._id}, ${orgB._id}`, "0".repeat(24), "*", "$ne"];
    for (const who of [A.admin, A.eng, A.officer]) {
      for (const v of variants) {
        for (const url of DATA_URLS(A)) {
          const res = await auth(request(app).get(url), who.token).set("X-Org-Id", v);
          expect([who.user.role, v, url, res.status]).toEqual([who.user.role, v, url, 200]);
          expect(has(res.text, TOKEN.B)).toBe(false);
        }
        const b = await auth(request(app).get(`/api/versions/${B.v1._id}`), who.token).set("X-Org-Id", v);
        expect(b.status).toBe(404);
        // a write with the header goes to the caller's own organization
        if (who === A.eng) {
          const m = await auth(request(app).post("/api/models"), who.token).set("X-Org-Id", v).send({ name: `hdr-${Date.now()}-${Math.random()}` });
          expect(m.status).toBe(201);
          expect(String((await sModel.findById(m.body.model._id)).orgId)).toBe(String(orgA._id));
        }
      }
    }
    // duplicated header lines (node joins them with ", ")
    const dup = await auth(request(app).get("/api/models"), A.eng.token).set("X-Org-Id", [String(orgB._id), String(orgA._id)]);
    expect(dup.status).toBe(200);
    expect(has(dup.text, TOKEN.B)).toBe(false);
    // and none of it was recorded as a super admin entering an organization
    const fresh = await sAudit.find({ seq: { $gt: lastSeq } }).lean();
    expect(fresh.filter((r) => r.action === "org_access")).toEqual([]);
  });

  test("super admin: malformed, unknown, duplicated or injected headers are 400 ORG_REQUIRED, never an unscoped view", async () => {
    const bad = ["not-an-id", "0".repeat(24), `${orgA._id}, ${orgB._id}`, `${orgA._id}x`, "$ne", "{}", `[${orgA._id}]`];
    for (const v of bad) {
      for (const url of ["/api/models", "/api/stats", "/api/audit-log"]) {
        const res = await auth(request(app).get(url), sup.token).set("X-Org-Id", v);
        expect([v, url, res.status, res.body.code]).toEqual([v, url, 400, "ORG_REQUIRED"]);
      }
    }
    const dup = await auth(request(app).get("/api/models"), sup.token).set("X-Org-Id", [String(orgA._id), String(orgB._id)]);
    expect(dup.status).toBe(400);
    const upper = await auth(request(app).get("/api/models?limit=100"), sup.token).set("X-Org-Id", String(orgB._id).toUpperCase());
    expect(upper.status).toBe(200);
    expect(has(upper.text, TOKEN.A)).toBe(false);
    expect(has(upper.text, TOKEN.B)).toBe(true);
  });

  test("super admin holding data in A and then selecting B: everything of A becomes a 404 / absent", async () => {
    const mine = await auth(request(app).post("/api/models"), sup.token).set(orgHdr(orgA)).send({ name: "ALPHAXQ made by super" });
    expect(mine.status).toBe(201);
    const c = await auth(request(app).post(`/api/versions/${A.v2._id}/comments`), sup.token).set(orgHdr(orgA)).send({ body: "ALPHAXQ from platform" });
    expect(c.status).toBe(201);
    const id = mine.body.model._id;
    const asB = (url, m = "get") => auth(request(app)[m](url), sup.token).set(orgHdr(orgB));
    expect((await asB(`/api/models/${id}`)).status).toBe(404);
    expect((await asB(`/api/versions/${A.v2._id}/comments`)).status).toBe(404);
    expect((await asB(`/api/models/${id}`, "delete").send({})).status).toBe(404);
    expect(has((await asB("/api/models?limit=100")).text, TOKEN.A)).toBe(false);
    expect(has((await asB("/api/stats")).text, TOKEN.A)).toBe(false);
    expect(has((await asB("/api/audit-log?limit=100")).text, TOKEN.A)).toBe(false);
    expect(has((await asB("/api/trash")).text, TOKEN.A)).toBe(false);
    expect(has((await asB("/api/settings")).text, TOKEN.A)).toBe(false);
    expect((await sModel.findById(id)).isDeleted).toBe(false);
    // a tight loop of switching organizations never mixes the two views
    const calls = [];
    for (let i = 0; i < 24; i += 1) {
      const org = i % 2 ? orgA : orgB;
      calls.push(auth(request(app).get("/api/models?limit=100"), sup.token).set(orgHdr(org)).then((r) => [org, r]));
    }
    for (const [org, r] of await Promise.all(calls)) {
      expect(r.status).toBe(200);
      expect(has(r.text, org === orgA ? TOKEN.B : TOKEN.A)).toBe(false);
      expect(has(r.text, org === orgA ? TOKEN.A : TOKEN.B)).toBe(true);
    }
    // every entry into an organization is on record, with that organization's orgId
    const access = await sAudit.find({ action: "org_access", actorId: sup.user._id }).lean();
    expect(new Set(access.map((r) => String(r.orgId)))).toEqual(new Set([String(orgA._id), String(orgB._id)]));
  });

  test("token claims are not trusted: a forged role/org claim changes nothing, a demoted user is demoted at once", async () => {
    const forged = jwt.sign({ sub: String(A.eng.user._id), role: "super_admin", orgId: String(orgB._id), admin: true }, env.jwtSecret, { expiresIn: "1h" });
    const res = await auth(request(app).get("/api/models?limit=100"), forged);
    expect(res.status).toBe(200);
    expect(has(res.text, TOKEN.B)).toBe(false);
    expect((await auth(request(app).get("/api/audit-log/verify"), forged)).status).toBe(403);
    expect((await auth(request(app).get("/api/orgs"), forged)).status).toBe(403);
    expect((await get(forged, "/api/versions/" + B.v1._id)).status).toBe(404);
    // the claim role of an admin token does not survive a demotion
    const u = await makeUser("admin", { orgId: orgA._id });
    await sUser.updateOne({ _id: u.user._id }, { $set: { role: "ml_engineer" } });
    expect((await auth(request(app).put("/api/settings"), u.token).send({})).status).toBe(403);
    expect((await get(u.token, "/api/trash")).status).toBe(403);
    // alg none / bad signature / wrong secret / no sub
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: String(sup.user._id) })).toString("base64url")}.`;
    for (const t of [none, jwt.sign({ sub: String(sup.user._id) }, "wrong secret wrong secret wrong secret"), jwt.sign({ role: "super_admin" }, env.jwtSecret)]) {
      expect((await get(t, "/api/models")).status).toBe(401);
    }
  });

  test("deactivated, pending, unverified, invited users and users of a suspended organization are refused by every authenticated route", async () => {
    const org = await makeOrg({ name: "Suspendable" });
    const admin = await makeUser("admin", { orgId: org._id });
    const eng = await makeUser("ml_engineer", { orgId: org._id });
    const cases = {
      deactivated: await makeUser("ml_engineer", { orgId: orgA._id, extra: { isActive: false } }),
      pending: await makeUser("ml_engineer", { orgId: orgA._id, status: "pending" }),
      unverified: await makeUser("ml_engineer", { orgId: orgA._id, status: "unverified" }),
      invited: await makeUser("ml_engineer", { orgId: orgA._id, status: "invited" }),
    };
    const urls = [
      "/api/models", "/api/versions", "/api/stats", "/api/settings", "/api/trash", "/api/audit-log", "/api/auth/me",
      `/api/models/${A.model._id}`, `/api/versions/${A.v1._id}`, `/api/versions/${A.v1._id}/comments`, `/api/versions/${A.v1._id}/file`,
    ];
    for (const [label, who] of Object.entries(cases)) {
      for (const url of urls) expect([label, url, (await get(who.token, url)).status]).toEqual([label, url, 401]);
      expect((await post(who.token, "/api/models", { name: "x" })).status).toBe(401);
    }
    // suspend: tokens that were fine a second ago stop working on the next request
    expect((await get(eng.token, "/api/models")).status).toBe(200);
    await Organization.updateOne({ _id: org._id }, { $set: { status: "suspended" } });
    for (const who of [admin, eng]) {
      for (const url of urls) expect([url, (await get(who.token, url)).status]).toEqual([url, 401]);
    }
    // the super admin can still look into a suspended organization (audited), without being locked out
    expect((await auth(request(app).get("/api/models"), sup.token).set(orgHdr(org))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// mass assignment
// ---------------------------------------------------------------------------------------------
describe("orgId is never taken from the client", () => {
  const FOREIGN = () => String(orgB._id);

  test("create model / version / comment / settings / review ignore or reject an orgId in the body, query and form", async () => {
    // strict schema: rejected, nothing created
    const strict = await auth(request(app).post("/api/models"), A.eng.token).send({ name: "mass-1", orgId: FOREIGN() });
    expect(strict.status).toBe(400);
    expect(await sModel.countDocuments({ name: "mass-1" })).toBe(0);
    // non-strict schemas strip it
    const m = await createModel(A.eng.token, "mass-2");
    const v = await auth(request(app).post(`/api/models/${m._id}/versions?orgId=${FOREIGN()}`), A.eng.token)
      .field("fileType", "csv").field("latencyMs", "3").field("orgId", FOREIGN()).field("modelId", String(B.model._id)).field("createdBy", String(B.eng.user._id))
      .attach("file", CSV, "m.csv");
    expect(v.status).toBe(201);
    const row = await sVersion.findById(v.body.version._id).lean();
    expect(String(row.orgId)).toBe(String(orgA._id));
    expect(String(row.modelId)).toBe(String(m._id));
    expect(String(row.createdBy)).toBe(String(A.eng.user._id));
    expect(String((await sSnapshot.findOne({ versionId: row._id }).lean()).orgId)).toBe(String(orgA._id));
    const c = await auth(request(app).post(`/api/versions/${row._id}/comments`), A.eng.token).send({ body: "mass-3", orgId: FOREIGN(), versionId: String(B.v2._id), authorId: String(B.eng.user._id) });
    expect(c.status).toBe(201);
    const crow = await sComment.findById(c.body.comment._id).lean();
    expect([String(crow.orgId), String(crow.versionId), String(crow.authorId)]).toEqual([String(orgA._id), String(row._id), String(A.eng.user._id)]);
    expect(await sComment.countDocuments({ versionId: B.v2._id, body: "mass-3" })).toBe(0);
    const settingsBefore = JSON.stringify(await sSettings.findOne({ orgId: orgB._id }).lean());
    await auth(request(app).put(`/api/settings?orgId=${FOREIGN()}`), A.admin.token)
      .send({ lowAccuracy: 0.9137, lowFairnessGap: 0.0411, mediumAccuracy: 0.7311, mediumFairnessGap: 0.2111, driftThreshold: 0.0731, orgId: FOREIGN(), _id: String(B.admin.user._id) })
      .expect(200);
    expect(JSON.stringify(await sSettings.findOne({ orgId: orgB._id }).lean())).toBe(settingsBefore);
    // a review body that names a foreign org / reviewer changes nothing but the caller's own version
    await post(A.eng.token, `/api/versions/${row._id}/submit`).expect(200);
    const rv = await post(A.officer.token, `/api/versions/${row._id}/review`, { decision: "approve", comment: "ok", orgId: FOREIGN(), reviewedBy: String(B.officer.user._id) });
    expect(rv.status).toBe(200);
    const after = await sVersion.findById(row._id).lean();
    expect([String(after.orgId), String(after.reviewedBy)]).toEqual([String(orgA._id), String(A.officer.user._id)]);
  });

  test("list filters cannot be turned into other-org reads (operators are stripped or rejected)", async () => {
    for (const url of [
      `/api/models?orgId=${orgB._id}`,
      `/api/models?orgId[$ne]=${orgA._id}`,
      `/api/models?q[$ne]=zzz`,
      `/api/versions?orgId=${orgB._id}&status=deployed`,
      `/api/versions?status[$ne]=x`,
      `/api/audit-log?orgId[$ne]=${orgA._id}`,
      `/api/audit-log?action[$ne]=x&actorRole[$regex]=.*`,
    ]) {
      const res = await get(A.admin.token, url);
      expect([url, res.status < 500]).toEqual([url, true]);
      expect([url, has(res.text, TOKEN.B)]).toEqual([url, false]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------------------------
describe("files", () => {
  test("a version file is served inside its organization only; no other URL serves the upload dir", async () => {
    const ok = await get(A.eng.token, `/api/versions/${A.v1._id}/file`);
    expect(ok.status).toBe(200);
    const bytes = Buffer.from(CSV).toString();
    expect(ok.text || ok.body.toString()).toContain("predicted");
    for (const who of [B.admin, B.eng, B.officer]) {
      for (const q of ["", "?which=dataset", "?which=model"]) {
        const res = await get(who.token, `/api/versions/${A.v1._id}/file${q}`);
        expect([who.user.role, q, res.status]).toEqual([who.user.role, q, 404]);
        expect(res.text.includes(bytes.slice(0, 9)) && res.status === 200).toBe(false);
      }
    }
    const asB = await auth(request(app).get(`/api/versions/${A.v1._id}/file`), sup.token).set(orgHdr(orgB));
    expect(asB.status).toBe(404);
    // the stored file name is not guessable from the response: no path, no directory in headers
    expect(String(ok.headers["content-disposition"])).not.toMatch(/[\\/]/);
    // no static route exposes the upload directory
    const stored = fs.readdirSync(UPLOAD_DIR)[0];
    for (const url of [`/uploads/${stored}`, `/api/uploads/${stored}`, `/${stored}`, `/api/versions/${A.v1._id}/../../uploads/${stored}`]) {
      const res = await request(app).get(url);
      expect([url, res.status === 404 || res.status === 401 || res.status === 400]).toEqual([url, true]);
    }
    // which= is an enum: no traversal parameter reaches the file system
    for (const q of ["?which=../../etc/passwd", "?which=model%00", "?which[]=model"]) {
      expect([q, (await get(A.eng.token, `/api/versions/${A.v1._id}/file${q}`)).status]).toEqual([q, 400]);
    }
  });

  test("two versions can never point at the same stored file, and a failed upload leaves no file behind", async () => {
    const paths = (await sVersion.find({ filePath: { $ne: null } }).setOptions({ includeDeleted: true }).lean()).map((v) => v.filePath);
    expect(new Set(paths).size).toBe(paths.length);
    const before = files();
    // foreign model: the upload is refused AFTER multer wrote it; it must be removed again
    const res = await uploadCsv(A.eng.token, String(B.model._id));
    expect(res.status).toBe(404);
    const res2 = await uploadCsv(A.eng.token, rid());
    expect(res2.status).toBe(404);
    expect(res.body).toEqual(res2.body);
    expect(files()).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------------------------
describe("concurrency", () => {
  test("interleaved reads and writes of two organizations (slow handlers) never mix", async () => {
    const mA = await createModel(A.eng.token, "ALPHAXQ concurrent");
    const mB = await createModel(B.eng.token, "BRAVOXQ concurrent");
    computeMetrics.mockImplementation(async ({ primaryFilePath }) => {
      await sleep(5 + Math.floor(Math.random() * 60));
      return fs.readFileSync(primaryFilePath, "utf8").startsWith("alpha") ? GOOD : BAD;
    });
    const bufA = Buffer.from("alpha,predicted,actual\n1,0,0\n");
    const bufB = Buffer.from("bravo,predicted,actual\n1,0,0\n");
    const jobs = [];
    const expectOnly = (label, org) => (res) => {
      if (res.status >= 400) throw new Error(`${label}: ${res.status} ${res.text}`);
      const text = res.text || "";
      if (has(text, org === "A" ? TOKEN.B : TOKEN.A)) throw new Error(`${label}: leaked the other organization`);
      return res;
    };
    for (let i = 0; i < 8; i += 1) {
      const side = i % 2 ? "B" : "A";
      const ctx = side === "A" ? A : B;
      const model = side === "A" ? mA : mB;
      jobs.push(uploadCsv(ctx.eng.token, model._id, { buffer: side === "A" ? bufA : bufB, filename: `${side}${i}.csv` }).then((r) => {
        expect(r.status).toBe(201);
        expect(r.body.version.riskTier).toBe(side === "A" ? "low" : "high");
        return r;
      }));
      jobs.push(get(ctx.eng.token, "/api/models?limit=100").then(expectOnly(`models ${side}`, side)));
      jobs.push(get(ctx.admin.token, "/api/stats").then(expectOnly(`stats ${side}`, side)));
      jobs.push(get(ctx.officer.token, "/api/versions?limit=100").then(expectOnly(`queue ${side}`, side)));
      jobs.push(get(ctx.admin.token, "/api/audit-log?limit=100").then(expectOnly(`audit ${side}`, side)));
      jobs.push(get(ctx.admin.token, "/api/settings").then(expectOnly(`settings ${side}`, side)));
      jobs.push(post(ctx.eng.token, `/api/versions/${ctx.v2._id}/comments`, { body: `${ctx.label}XQ concurrent ${i}` }).then((r) => {
        expect(r.status).toBe(201);
        return r;
      }));
      jobs.push(auth(request(app).get("/api/models?limit=100"), sup.token).set(orgHdr(side === "A" ? orgA : orgB)).then(expectOnly(`super ${side}`, side)));
      // the other side's ids, in the middle of all that
      jobs.push(get(ctx.eng.token, `/api/versions/${(side === "A" ? B : A).v1._id}`).then((r) => expect(r.status).toBe(404)));
    }
    await Promise.all(jobs);
    // storage: every row of the burst is in the right organization
    for (const [m, org] of [[mA, orgA], [mB, orgB]]) {
      const rows = await sVersion.find({ modelId: m._id }).sort({ versionNumber: 1 }).lean();
      expect(rows.map((r) => r.versionNumber)).toEqual([1, 2, 3, 4]);
      expect(rows.every((r) => String(r.orgId) === String(org._id))).toBe(true);
      const snaps = await sSnapshot.find({ versionId: { $in: rows.map((r) => r._id) } }).lean();
      expect(snaps).toHaveLength(4);
      expect(snaps.every((s) => String(s.orgId) === String(org._id))).toBe(true);
    }
    expect((await sComment.find({ body: /ALPHAXQ concurrent/ }).lean()).every((c) => String(c.orgId) === String(orgA._id))).toBe(true);
    expect((await sComment.find({ body: /BRAVOXQ concurrent/ }).lean()).every((c) => String(c.orgId) === String(orgB._id))).toBe(true);
    // audit: a row's organization is its actor's organization (or the selected one for the super admin), and
    // equals the organization of the row it is about
    const rows = await sAudit.find({ seq: { $exists: true } }).lean();
    const orgOfUser = new Map((await sUser.find().lean()).map((u) => [String(u._id), u.orgId ? String(u.orgId) : null]));
    for (const r of rows) {
      const actorOrg = r.actorId ? orgOfUser.get(String(r.actorId)) : null;
      if (actorOrg && r.actorRole !== "super_admin") expect([r.action, String(r.orgId)]).toEqual([r.action, actorOrg]);
      if (r.targetId && ["Model", "Version"].includes(r.targetType) && r.orgId && r.action !== "cross_org_attempt") {
        const target = r.targetType === "Model"
          ? await sModel.findById(r.targetId).setOptions({ includeDeleted: true }).lean()
          : await sVersion.findById(r.targetId).setOptions({ includeDeleted: true }).lean();
        if (target) expect([r.action, String(r.orgId)]).toEqual([r.action, String(target.orgId)]);
      }
    }
  });

  test("a keep-alive connection carrying alternating organizations keeps every request in its own context", async () => {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const call = (token, url, { method = "GET", body, headers = {} } = {}) =>
      new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(
          { host: "127.0.0.1", port, path: url, method, agent, headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers } },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, text }));
          }
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
      });
    try {
      for (let i = 0; i < 24; i += 1) {
        const [ctx, other] = i % 2 ? [B, A] : [A, B];
        const list = await call(ctx.eng.token, "/api/models?limit=100");
        expect(list.status).toBe(200);
        expect(has(list.text, TOKEN[other.label[0]])).toBe(false);
        expect(has(list.text, TOKEN[ctx.label[0]])).toBe(true);
        const created = await call(ctx.eng.token, "/api/models", { method: "POST", body: { name: `${ctx.label}XQ keepalive ${i} ${Date.now()}` } });
        expect(created.status).toBe(201);
        expect(String((await sModel.findById(JSON.parse(created.text).model._id)).orgId)).toBe(String(ctx.org._id));
      }
      // the same socket also carries a super admin switching organization on every request
      for (let i = 0; i < 10; i += 1) {
        const org = i % 2 ? orgA : orgB;
        const res = await call(sup.token, "/api/models?limit=100", { headers: orgHdr(org) });
        expect(has(res.text, org === orgA ? TOKEN.B : TOKEN.A)).toBe(false);
      }
      const noOrg = await call(sup.token, "/api/models");
      expect(noOrg.status).toBe(400);
    } finally {
      agent.destroy();
      await new Promise((r) => server.close(r));
    }
  });

  test("two admins of two organizations saving settings at once, first time, each get their own document", async () => {
    const o1 = await makeOrg({ name: "Race One" });
    const o2 = await makeOrg({ name: "Race Two" });
    const a1 = await makeUser("admin", { orgId: o1._id });
    const a2 = await makeUser("admin", { orgId: o2._id });
    const body1 = { lowAccuracy: 0.91, lowFairnessGap: 0.05, mediumAccuracy: 0.71, mediumFairnessGap: 0.21, driftThreshold: 0.07 };
    const body2 = { lowAccuracy: 0.89, lowFairnessGap: 0.06, mediumAccuracy: 0.69, mediumFairnessGap: 0.22, driftThreshold: 0.08 };
    const rs = await Promise.all([
      auth(request(app).put("/api/settings"), a1.token).send(body1),
      auth(request(app).put("/api/settings"), a2.token).send(body2),
      auth(request(app).put("/api/settings"), a1.token).send(body1),
      auth(request(app).put("/api/settings"), a2.token).send(body2),
    ]);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    expect((await sSettings.find({ orgId: o1._id }).lean()).map((s) => s.lowAccuracy)).toEqual([0.91]);
    expect((await sSettings.find({ orgId: o2._id }).lean()).map((s) => s.lowAccuracy)).toEqual([0.89]);
  });

  test("archiving and restoring in one organization while the other deploys: no cascade crosses the border", async () => {
    const mA = await createModel(A.eng.token, "ALPHAXQ cascade");
    const mB = await createModel(B.eng.token, "BRAVOXQ cascade");
    const vA = await newVersion(A.eng.token, mA._id);
    const vB = await newVersion(B.eng.token, mB._id);
    const state = async (id) => (await sVersion.findById(id).setOptions({ includeDeleted: true }).lean());
    await Promise.all([
      auth(request(app).delete(`/api/models/${mA._id}`), A.admin.token).send({ reason: "r" }).expect(200),
      post(B.eng.token, `/api/versions/${vB._id}/submit`).expect(200),
    ]);
    expect((await state(vA._id)).isDeleted).toBe(true);
    expect((await state(vB._id)).isDeleted).toBe(false);
    expect((await state(vB._id)).status).toBe("submitted");
    await post(A.admin.token, `/api/models/${mA._id}/restore`).expect(200);
    expect((await state(vA._id)).isDeleted).toBe(false);
    expect((await state(vB._id)).status).toBe("submitted");
  });
});

// ---------------------------------------------------------------------------------------------
// separation of duties and roles
// ---------------------------------------------------------------------------------------------
describe("roles and separation of duties", () => {
  test("whoever uploaded a version can never approve, reject, request changes, deploy, retire or resolve it, whatever role they hold now", async () => {
    const eng = await makeUser("ml_engineer", { orgId: orgA._id });
    const model = await createModel(eng.token, "ALPHAXQ duties");
    const v = await newVersion(eng.token, model._id);
    await post(eng.token, `/api/versions/${v._id}/submit`).expect(200);
    // promoted to compliance officer AND to admin: both lists are asked
    for (const role of ["compliance_officer", "admin"]) {
      await sUser.updateOne({ _id: eng.user._id }, { $set: { role } });
      if (role === "compliance_officer") {
        for (const decision of ["approve", "reject", "request_changes"]) {
          const res = await post(eng.token, `/api/versions/${v._id}/review`, { decision, comment: "self review" });
          expect([role, decision, res.status]).toEqual([role, decision, 403]);
        }
      }
      for (const [url, body] of [
        [`/api/versions/${v._id}/deploy`, {}],
        [`/api/versions/${v._id}/retire`, { comment: "self" }],
        [`/api/versions/${v._id}/resolve-review`, { decision: "keep", comment: "self" }],
      ]) {
        if (role === "admin" || url.endsWith("deploy") || url.endsWith("retire") || url.endsWith("resolve-review")) {
          const res = await post(eng.token, url, body);
          expect([role, url, res.status]).toEqual([role, url, 403]);
        }
      }
    }
    expect((await sVersion.findById(v._id)).status).toBe("submitted");
    // a super admin is not a reviewer, even inside the organization
    const res = await auth(request(app).post(`/api/versions/${v._id}/review`), sup.token).set(orgHdr(orgA)).send({ decision: "approve", comment: "x" });
    expect(res.status).toBe(403);
    // an unrelated officer can
    await post(A.officer.token, `/api/versions/${v._id}/review`, { decision: "approve", comment: "fine" }).expect(200);
  });

  test("roleGuard: super_admin counts as admin only where 'admin' is listed", () => {
    const roleGuard = require("../middleware/role");
    const run = (role, list) => {
      let out = "next";
      roleGuard(list)({ user: { role } }, { status: (c) => ({ json: () => (out = c) }) }, () => (out = "next"));
      return out;
    };
    expect(run("super_admin", ["admin"])).toBe("next");
    expect(run("super_admin", ["ml_engineer", "admin"])).toBe("next");
    expect(run("super_admin", ["compliance_officer"])).toBe(403);
    expect(run("super_admin", ["ml_engineer"])).toBe(403);
    expect(run("super_admin", ["super_admin"])).toBe("next");
    expect(run("admin", ["super_admin"])).toBe(403);
    expect(run("ml_engineer", ["admin"])).toBe(403);
    expect(run(undefined, ["admin"])).toBe(403);
  });

  test("an organization admin cannot mint a platform role or move a user between organizations (read-only probe of the user routes)", async () => {
    const before = JSON.stringify(await sUser.find().sort({ _id: 1 }).lean());
    const self = A.admin.user._id;
    for (const body of [{ role: "super_admin" }, { orgId: String(orgB._id) }, { role: "super_admin", orgId: String(orgB._id), name: "x" }, { status: "active", orgId: null }]) {
      const res = await auth(request(app).patch(`/api/users/${self}`), A.admin.token).send(body);
      expect([JSON.stringify(body), res.status < 500]).toEqual([JSON.stringify(body), true]);
    }
    const add = await auth(request(app).post("/api/users"), A.admin.token).send({ name: "Mint", email: `mint.${Date.now()}@test.local`, role: "super_admin" });
    expect(add.status).toBe(400);
    const add2 = await auth(request(app).post("/api/users"), A.admin.token).send({ name: "Mint", email: `mint2.${Date.now()}@test.local`, role: "admin", orgId: String(orgB._id) });
    if (add2.status === 201) {
      const row = await sUser.findOne({ email: add2.body.user.email }).lean();
      expect(String(row.orgId)).toBe(String(orgA._id));
      await sUser.deleteOne({ _id: row._id });
    }
    const now = (await sUser.find().sort({ _id: 1 }).lean()).filter((u) => String(u._id) !== String(self));
    const was = JSON.parse(before).filter((u) => String(u._id) !== String(self));
    expect(JSON.stringify(now)).toBe(JSON.stringify(was));
    const me = await sUser.findById(self).lean();
    expect([me.role, String(me.orgId)]).toEqual(["admin", String(orgA._id)]);
  });

  test("every route's role list (live): an organization user never reaches a platform-only route", async () => {
    for (const who of [A.admin, A.eng, A.officer]) {
      expect((await get(who.token, "/api/orgs")).status).toBe(403);
      expect((await post(who.token, "/api/orgs", { name: "x" })).status).toBe(403);
      expect((await auth(request(app).patch(`/api/orgs/${orgB._id}`), who.token).send({ name: "x" })).status).toBe(403);
    }
    expect((await Organization.findById(orgB._id)).name).toBe("Org Two");
  });
});

// ---------------------------------------------------------------------------------------------
// the plugin itself: ways to walk around it
// ---------------------------------------------------------------------------------------------
describe("tenant plugin cannot be walked around", () => {
  let mA, mB;
  beforeAll(async () => {
    mA = await runWithOrg(orgA._id, () => Model.create({ name: "plugin-a", createdBy: A.eng.user._id }));
    mB = await runWithOrg(orgB._id, () => Model.create({ name: "plugin-b", createdBy: B.eng.user._id }));
  });
  const inA = (fn) => runWithOrg(orgA._id, fn);
  const rejects = async (p) => {
    let err = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    return err;
  };

  test("fail closed: no organization context means an error, not an unfiltered answer", async () => {
    for (const M of [Model, Version, Comment, MetricSnapshot, Settings, User, AuditLog]) {
      for (const run of [
        () => M.find(),
        () => M.findOne(),
        () => M.countDocuments(),
        () => M.exists({}),
        () => M.distinct("_id"),
        () => M.aggregate([{ $match: {} }]),
        () => M.find().cursor().next(),
        () => M.find().lean(),
      ]) {
        const err = await rejects(run());
        expect([M.modelName, err.name]).toEqual([M.modelName, "TenantContextError"]);
      }
    }
    // a super admin's "no organization selected" context is the same thing
    const err = await rejects(runWithOrg(null, () => Model.find()));
    expect(err).toBeInstanceOf(TenantContextError);
  });

  test("cursors, explain, distinct, where/setQuery and populate stay inside the organization", async () => {
    const names = [];
    await inA(async () => {
      for await (const d of Model.find().cursor()) names.push(d.name);
    });
    expect(names).toContain("plugin-a");
    expect(names).not.toContain("plugin-b");
    const agg = [];
    await inA(async () => {
      for await (const d of Model.aggregate([{ $project: { name: 1 } }]).cursor()) agg.push(d.name);
    });
    expect(agg).toContain("plugin-a");
    expect(agg).not.toContain("plugin-b");
    const plan = await inA(() => Model.aggregate([{ $match: {} }]).explain());
    expect(JSON.stringify(plan)).toContain(String(orgA._id));
    expect(await inA(() => Model.find().where("orgId", orgB._id).lean())).toEqual([]);
    expect(await inA(() => Model.where({ orgId: orgB._id }).find().lean())).toEqual([]);
    expect(await inA(() => Model.findOne({ $or: [{ orgId: orgB._id }, { _id: mB._id }] }).lean())).toBeNull();
    expect(await inA(() => Model.find({ orgId: { $in: [orgA._id, orgB._id] } }).lean()).then((r) => r.every((m) => String(m.orgId) === String(orgA._id)))).toBe(true);
    expect(await inA(() => Model.distinct("name"))).not.toContain("plugin-b");
    expect(await inA(() => Model.countDocuments({ name: "plugin-b" }))).toBe(0);
    expect(await inA(() => Model.find().setOptions({ bypassTenant: "true" }).lean()).then((r) => r.some((m) => m.name === "plugin-b"))).toBe(false);
    expect(await inA(() => Model.find().setOptions({ bypassTenant: 1 }).lean()).then((r) => r.some((m) => m.name === "plugin-b"))).toBe(false);
    // populate does not reach into the other organization
    const v = await runSystem(() => Version.create({ modelId: mB._id, orgId: orgA._id, versionNumber: 1, fileType: "csv", createdBy: A.eng.user._id }));
    const pop = await inA(() => Version.findById(v._id).populate("modelId", "name"));
    expect(pop.modelId).toBeNull();
    await sVersion.deleteOne({ _id: v._id });
  });

  test("updates, replacements, upserts and saves cannot move or rewrite another organization's rows or an orgId", async () => {
    const snapshotB = JSON.stringify(await sModel.findById(mB._id).lean());
    const attempts = [
      () => Model.updateOne({ _id: mB._id }, { $set: { name: "hijack" } }),
      () => Model.updateMany({ _id: mB._id }, { $set: { description: "hijack" } }),
      () => Model.findOneAndUpdate({ _id: mB._id }, { $set: { name: "hijack" } }),
      () => Model.findOneAndUpdate({ _id: mB._id }, { name: "hijack" }, { upsert: false, overwrite: true }),
      () => Model.replaceOne({ _id: mB._id }, { name: "hijack", createdBy: A.eng.user._id }),
      () => Model.findOneAndReplace({ _id: mB._id }, { name: "hijack", createdBy: A.eng.user._id }),
      () => Model.deleteOne({ _id: mB._id }),
      () => Model.deleteMany({ name: "plugin-b" }),
      () => Model.findOneAndDelete({ _id: mB._id }),
      () => Model.updateOne({ _id: mB._id }, [{ $set: { name: "hijack" } }]),
    ];
    for (const a of attempts) {
      const r = await inA(async () => {
        try {
          return await a();
        } catch (e) {
          return e;
        }
      });
      // either nothing matched, or the plugin refused: never a modification of B
      if (!(r instanceof Error)) {
        const n = r && (r.modifiedCount ?? r.deletedCount ?? (r._id ? 1 : 0));
        expect(n || 0).toBe(0);
      }
    }
    expect(JSON.stringify(await sModel.findById(mB._id).lean())).toBe(snapshotB);
    // an unfiltered write inside A touches A's rows only
    await inA(() => Model.updateMany({}, { $set: { description: "a-only" } }));
    expect(JSON.stringify(await sModel.findById(mB._id).lean())).toBe(snapshotB);
    expect((await sModel.find({ orgId: orgA._id, description: "a-only" }).lean()).length).toBeGreaterThan(0);
    // an orgId can never be written by an update, in any operator or pipeline spelling
    for (const upd of [
      { orgId: orgB._id },
      { $set: { orgId: orgB._id } },
      { $setOnInsert: { orgId: orgB._id } },
      { $unset: { orgId: "" } },
      { $rename: { name: "orgId" } },
      { $rename: { orgId: "x" } },
      { $min: { orgId: orgB._id } },
      [{ $set: { orgId: orgB._id } }],
      [{ $replaceWith: { name: "x" } }],
    ]) {
      const err = await rejects(inA(() => Model.updateOne({ _id: mA._id }, upd)));
      expect([JSON.stringify(upd), err.name]).toEqual([JSON.stringify(upd), "TenantViolationError"]);
    }
    expect(String((await sModel.findById(mA._id).lean()).orgId)).toBe(String(orgA._id));
    // a loaded document of B cannot be saved or deleted from A, and orgId cannot be re-assigned on a document
    const loaded = await sModel.findById(mB._id);
    loaded.description = "hijack";
    await rejects(inA(() => loaded.save()));
    const own = await inA(() => Model.findById(mA._id));
    own.orgId = orgB._id;
    await rejects(inA(() => own.save()));
    expect(String((await sModel.findById(mA._id).lean()).orgId)).toBe(String(orgA._id));
    expect(JSON.stringify(await sModel.findById(mB._id).lean())).toBe(snapshotB);
    // an upsert whose filter names B conflicts instead of inserting into B
    await rejects(inA(() => Model.findOneAndUpdate({ orgId: orgB._id, name: "up-b" }, { $set: { createdBy: A.eng.user._id } }, { upsert: true })));
    expect(await sModel.countDocuments({ name: "up-b" })).toBe(0);
  });

  test("creates: an orgId of another organization is refused, a missing one takes the context's", async () => {
    await rejects(inA(() => Model.create({ name: "x1", createdBy: A.eng.user._id, orgId: orgB._id })));
    await rejects(inA(() => Model.insertMany([{ name: "x2", createdBy: A.eng.user._id, orgId: orgB._id }])));
    await rejects(inA(() => Model.create([{ name: "x3", createdBy: A.eng.user._id }, { name: "x4", createdBy: A.eng.user._id, orgId: orgB._id }])));
    await rejects(inA(() => new Model({ name: "x5", createdBy: A.eng.user._id, orgId: orgB._id }).save()));
    await rejects(Model.create({ name: "x6", createdBy: A.eng.user._id })); // no context and no explicit org
    await rejects(inA(() => Model.bulkWrite([{ insertOne: { document: { name: "x7", createdBy: A.eng.user._id, orgId: orgB._id } } }])));
    await rejects(inA(() => Model.estimatedDocumentCount()));
    expect(await sModel.countDocuments({ name: /^x\d$/ })).toBeLessThanOrEqual(1); // x3 may be created in A by create([...]) before x4 fails
    const ok = await inA(() => Model.insertMany([{ name: "x8", createdBy: A.eng.user._id }]));
    expect(String(ok[0].orgId)).toBe(String(orgA._id));
  });

  test("aggregations: joins carry the organization of the row they join", async () => {
    const { ACTIVE_MODEL_STAGES } = require("../utils/modelSummary");
    // a version of A that (wrongly) points at B's model: the join must not surface B's model
    const bad = await runSystem(() => Version.create({ modelId: mB._id, orgId: orgA._id, versionNumber: 99, fileType: "csv", status: "submitted", createdBy: A.eng.user._id }));
    const rows = await inA(() => Version.aggregate([{ $match: { _id: bad._id } }, ...ACTIVE_MODEL_STAGES]));
    expect(rows).toEqual([]);
    const stats = await get(A.admin.token, "/api/stats");
    expect(has(stats.text, /plugin-b/)).toBe(false);
    expect(stats.body.awaitingReview.map((v) => v.versionId)).not.toContain(String(bad._id));
    await sVersion.deleteOne({ _id: bad._id });
  });
});

// ---------------------------------------------------------------------------------------------
// background work
// ---------------------------------------------------------------------------------------------
describe("background work", () => {
  test("the cleanup job runs system-wide but only unlinks files and clears file paths", async () => {
    const { runCleanupOnce } = require("../jobs/cleanup");
    const before = JSON.stringify(
      (await sVersion.find().setOptions({ includeDeleted: true }).sort({ _id: 1 }).lean()).map(({ filePath, datasetPath, updatedAt, ...rest }) => rest)
    );
    const live = (await sVersion.find({ filePath: { $ne: null }, isDeleted: false, status: { $ne: "upload_failed" } }).lean()).map((v) => v.filePath);
    await runCleanupOnce();
    const after = JSON.stringify(
      (await sVersion.find().setOptions({ includeDeleted: true }).sort({ _id: 1 }).lean()).map(({ filePath, datasetPath, updatedAt, ...rest }) => rest)
    );
    expect(after).toBe(before);
    for (const p of live) expect(fs.existsSync(p)).toBe(true);
    // and the request path is unaffected afterwards (no leaked bypass context)
    expect((await get(A.eng.token, `/api/versions/${B.v1._id}`)).status).toBe(404);
    await expect(Model.find()).rejects.toBeInstanceOf(TenantContextError);
  });
});

// ---------------------------------------------------------------------------------------------
// robustness: hostile input never turns into a 5xx (an unhandled rejection stops the whole server,
// i.e. every organization) and never reaches another organization
// ---------------------------------------------------------------------------------------------
describe("hostile input", () => {
  test("odd query strings, bodies and ids on every organization route answer 4xx, never 5xx, never a leak", async () => {
    const weirdQueries = [
      "?q=a&q=b", "?q[]=a", "?q[$regex]=.*", "?limit=-1", "?limit=1e9", "?limit=abc", "?page=0", "?page=99999999999", "?status=a&status=b",
      "?status=" + "x".repeat(5000), "?tier=high&tier=low", "?which=a&which=b", "?orgId=" + orgB._id, "?from=2020-01-01&to=nonsense", "?q=%00", "?q=" + encodeURIComponent("(((((((("),
    ];
    for (const q of weirdQueries) {
      for (const url of ["/api/models", "/api/versions", "/api/audit-log", "/api/audit-log/export", "/api/stats", "/api/trash", `/api/versions/${A.v1._id}/file`, `/api/models/${A.model._id}/versions`]) {
        const res = await get(A.admin.token, url + q);
        expect([url + q, res.status < 500]).toEqual([url + q, true]);
        expect([url + q, has(res.text, TOKEN.B)]).toEqual([url + q, false]);
      }
    }
    const bodies = [[], "str", 5, null, { $ne: 1 }, { name: { $ne: "x" } }, { name: ["a"] }, { reason: { $gt: "" } }, { decision: ["approve"], comment: {} }, JSON.parse('{"__proto__":{"orgId":"x"},"name":"p"}')];
    for (const route of ID_ROUTES.filter((r) => !r.upload && r.method !== "GET")) {
      for (const body of bodies) {
        for (const actor of [A.admin, A.eng, A.officer]) {
          const url = route.tpl.replace(/:\w+/, String(A.v2._id));
          if (route.kind === "model" || route.kind === "user" || route.kind === "org") continue;
          const res = await auth(request(app)[route.method.toLowerCase()](url), actor.token).set("Content-Type", "application/json").send(JSON.stringify(body));
          expect([route.key, JSON.stringify(body), res.status < 500]).toEqual([route.key, JSON.stringify(body), true]);
        }
      }
    }
    // bad ids
    for (const bad of ["xyz", "123", "g".repeat(24), "%00", "..", "0".repeat(23), "0".repeat(25)]) {
      for (const url of [`/api/models/${bad}`, `/api/versions/${bad}`, `/api/versions/${bad}/file`, `/api/versions/${bad}/comments`, `/api/models/${bad}/versions`]) {
        const res = await get(A.admin.token, url);
        expect([url, res.status === 400 || res.status === 404]).toEqual([url, true]);
      }
    }
    // the process-level state survived: still isolated
    expect((await get(A.eng.token, `/api/versions/${B.v1._id}`)).status).toBe(404);
  });

  test("a super admin runs monitoring batches inside the selected organization only", async () => {
    computeMetrics.mockResolvedValue(GOOD);
    const inA = await auth(request(app).post(`/api/versions/${A.v1._id}/monitoring-batch`), sup.token).set(orgHdr(orgA)).attach("file", CSV, "s.csv");
    expect(inA.status).toBe(201);
    expect(String((await sSnapshot.findById(inA.body.snapshot._id)).orgId)).toBe(String(orgA._id));
    const before = await sSnapshot.countDocuments({});
    const inB = await auth(request(app).post(`/api/versions/${A.v1._id}/monitoring-batch`), sup.token).set(orgHdr(orgB)).attach("file", CSV, "s.csv");
    expect(inB.status).toBe(404);
    expect(await sSnapshot.countDocuments({})).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
// source: the other ways out of the tenant boundary stay in reviewed files
// ---------------------------------------------------------------------------------------------
describe("source guard: other ways around the tenant plugin", () => {
  const ROOT = path.join(__dirname, "..");
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!["node_modules", "tests", "uploads", "coverage", ".git"].includes(e.name)) walk(path.join(dir, e.name), out);
      } else if (/\.js$/.test(e.name)) out.push(path.join(dir, e.name));
    }
    return out;
  };
  // whole-line comments do not count: only code can leave the boundary
  const sources = walk(ROOT).map((f) => [path.relative(ROOT, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "")]);
  const offenders = (re, allowed) => sources.filter(([f, src]) => re.test(src) && !allowed.includes(f)).map(([f]) => f);

  test("raw driver access (Model.collection.*, connection.db) only in the audit verify (super admin), super admin seed migrations and the dev-only demo seed script (refuses NODE_ENV=production)", () => {
    expect(offenders(/\.collection\.(?!name\b)\w+|connection\.db\b|\.getClient\(|\.db\.collection\(/, ["routes/audit.js", "utils/superAdmin.js", "migrations/index.js", "scripts/seedDemo.js"])).toEqual([]);
  });
  test("$lookup / $unionWith / $graphLookup / $merge / $out only in the model summary (which joins on orgId)", () => {
    expect(offenders(/\$(lookup|unionWith|graphLookup|merge|out)\b/, ["utils/modelSummary.js", "utils/tenant.js", "utils/softDelete.js"])).toEqual([]);
    const summary = sources.find(([f]) => f === "utils/modelSummary.js")[1];
    expect(summary).toMatch(/\$eq: \["\$orgId", "\$\$orgId"\]/);
  });
  test("bulkWrite / estimatedDocumentCount / change streams only in migrations", () => {
    expect(offenders(/\.bulkWrite\(|estimatedDocumentCount\(|\.watch\(/, ["migrations/index.js", "utils/tenant.js", "utils/softDelete.js", "models/AuditLog.js"])).toEqual([]);
  });
  test("the organization context is entered in exactly two places: authGuard and the upload middleware", () => {
    expect(offenders(/\brunWithOrg\(|als\.(run|enterWith|exit)\(|\.enterWith\(/, ["middleware/auth.js", "middleware/upload.js", "utils/tenant.js"])).toEqual([]);
  });
  test("no route reads an organization id from the request", () => {
    for (const [f, src] of sources.filter(([f]) => /^routes\//.test(f) && !/^routes\/(orgs|auth)\.js$/.test(f))) {
      const m = src.match(/req\.(body|query|params|headers)[.\[]\s*["']?(orgId|org|organization|x-org-id)\b/i);
      expect([f, m && m[0]]).toEqual([f, null]);
    }
    // the only reader of X-Org-Id is authGuard
    expect(offenders(/x-org-id/i, ["middleware/auth.js", "routes/orgs.js"])).toEqual([]);
  });
});
