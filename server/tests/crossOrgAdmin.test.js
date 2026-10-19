// Cross-organization isolation of the admin-side routes: settings, stats, trash, audit log
// (list / export / verify), and the super admin's platform view of them.
const request = require("supertest");
const mongoose = require("mongoose");
const { runWithOrg } = require("../utils/tenant");
const { connect, reset, disconnect, makeUser, makeOrg, sys, auth } = require("./helpers");

const { ObjectId } = mongoose.Types;
const oid = () => new ObjectId();
const str = (v) => (v == null ? v : String(v));

let app, Model, Version, Settings, AuditLog, writeAuditLog, rateLimit;
let A, B; // organizations
let ua, ub, sa; // { admin, ml, comp } of A, of B, and the super admin
const raw = () => mongoose.connection.collection("auditlogs");

beforeAll(async () => {
  await connect();
  app = require("../app");
  Model = require("../models/Model");
  Version = require("../models/Version");
  Settings = require("../models/Settings");
  AuditLog = require("../models/AuditLog");
  writeAuditLog = require("../middleware/audit");
  rateLimit = require("../middleware/rateLimit");
});
afterAll(disconnect);

const mkModel = (org, name, owner) => Model.create({ name, createdBy: owner._id, orgId: org._id });
const mkVersion = (org, model, n, owner, extra = {}) =>
  Version.create({ modelId: model._id, versionNumber: n, fileType: "csv", createdBy: owner._id, orgId: org._id, ...extra });
const note = (actor, details, extra = {}) => writeAuditLog({ actor, action: "create_model", targetType: "Model", targetId: oid(), details, ...extra });

// Org A: 2 live models (Alpha: deployed low + submitted, Apex: needs_review high), 1 archived model.
// Org B: 1 live model (Beta: submitted medium), 2 archived models (one with an archived version).
async function seed() {
  await reset();
  rateLimit.resetAll();
  A = await makeOrg({ name: "Org A" });
  B = await makeOrg({ name: "Org B" });
  const mk = async (org) => ({
    admin: await makeUser("admin", { orgId: org._id }),
    ml: await makeUser("ml_engineer", { orgId: org._id }),
    comp: await makeUser("compliance_officer", { orgId: org._id }),
  });
  ua = await mk(A);
  ub = await mk(B);
  sa = await makeUser("super_admin");

  const alpha = await mkModel(A, "A-Alpha", ua.ml.user);
  await mkVersion(A, alpha, 1, ua.ml.user, { status: "deployed", riskTier: "low" });
  await mkVersion(A, alpha, 2, ua.ml.user, { status: "submitted" });
  const apex = await mkModel(A, "A-Apex", ua.ml.user);
  await mkVersion(A, apex, 1, ua.ml.user, { status: "needs_review", riskTier: "high" });
  const aGone = await mkModel(A, "A-Gone", ua.admin.user);
  await aGone.softDelete({ by: ua.admin.user._id, reason: "a-reason" });

  const beta = await mkModel(B, "B-Beta", ub.ml.user);
  await mkVersion(B, beta, 1, ub.ml.user, { status: "submitted", riskTier: "medium" });
  const bGone = await mkModel(B, "B-Gone", ub.admin.user);
  const bgv = await mkVersion(B, bGone, 1, ub.ml.user);
  await bgv.softDelete({ by: ub.admin.user._id, reason: "b-ver", cascade: true });
  await bGone.softDelete({ by: ub.admin.user._id, reason: "b-reason" });
  const bGone2 = await mkModel(B, "B-Gone2", ub.admin.user);
  await bGone2.softDelete({ by: ub.admin.user._id, reason: "b-reason2" });

  // 3 entries per org (one per role), one platform entry, and a legacy-shaped row in B that
  // carries A's engineer's NAME (the legacy-by-name rule must stay inside the org).
  await note(ua.admin.user, "A-admin-note");
  await note(ua.ml.user, "A-ml-note");
  await writeAuditLog({ actor: ua.comp.user, action: "approve", targetType: "Version", targetId: oid(), details: "A-comp-note" });
  await note(ub.admin.user, "B-admin-note");
  await note(ub.ml.user, "B-ml-note");
  await writeAuditLog({ actor: ub.comp.user, action: "approve", targetType: "Version", targetId: oid(), details: "B-comp-note" });
  await writeAuditLog({ actor: sa.user, action: "org_create", targetType: "Organization", targetId: oid(), details: "platform-event", orgId: null });
  await raw().insertOne({
    orgId: B._id, actorName: ua.ml.user.name, actorRole: "ml_engineer", action: "upload_version", targetType: "Version",
    targetId: oid(), details: "B-legacy-with-A-name", createdAt: new Date(1),
  });
}
beforeEach(seed);

const get = (path, who, orgId) => {
  const r = auth(request(app).get(path), who.token);
  return orgId ? r.set("X-Org-Id", String(orgId)) : r;
};
const put = (path, who, body, orgId) => {
  const r = auth(request(app).put(path), who.token).send(body);
  return orgId ? r.set("X-Org-Id", String(orgId)) : r;
};
const details = (res) => res.body.logs.map((l) => l.details);
const NOTES = ["A-admin-note", "A-ml-note", "A-comp-note", "B-admin-note", "B-ml-note", "B-comp-note", "platform-event", "B-legacy-with-A-name"];
const seenNotes = (res) => details(res).filter((d) => NOTES.includes(d)).sort();
const A_NOTES = ["A-admin-note", "A-comp-note", "A-ml-note"];
const B_NOTES = ["B-admin-note", "B-comp-note", "B-legacy-with-A-name", "B-ml-note"];

const good = { lowAccuracy: 0.9, lowFairnessGap: 0.05, mediumAccuracy: 0.75, mediumFairnessGap: 0.15, driftThreshold: 0.08 };
const other = { lowAccuracy: 0.95, lowFairnessGap: 0.02, mediumAccuracy: 0.8, mediumFairnessGap: 0.1, driftThreshold: 0.05 };

describe("settings", () => {
  test("each org has its own thresholds; A never changes B; defaults are per org", async () => {
    const { DEFAULT_THRESHOLDS } = require("../utils/settings");
    let res = await put("/api/settings", ua.admin, good);
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual(expect.objectContaining({ ...good, updatedBy: String(ua.admin.user._id), updatedByName: ua.admin.user.name }));

    // A reads its own values (the populated author resolves inside the org); B still has defaults
    res = await get("/api/settings", ua.ml);
    expect(res.body.settings).toEqual(expect.objectContaining({ ...good, updatedByName: ua.admin.user.name }));
    for (const who of [ub.admin, ub.ml, ub.comp]) {
      res = await get("/api/settings", who);
      expect(res.body.settings).toEqual(expect.objectContaining({ ...DEFAULT_THRESHOLDS, updatedAt: null, updatedBy: null, updatedByName: null }));
    }

    // B saves different values: A is untouched, one document per org
    expect((await put("/api/settings", ub.admin, other)).status).toBe(200);
    expect((await get("/api/settings", ua.admin)).body.settings).toEqual(expect.objectContaining(good));
    expect((await get("/api/settings", ub.admin)).body.settings).toEqual(expect.objectContaining(other));
    const docs = await sys(Settings).find().lean();
    expect(docs.map((d) => str(d.orgId)).sort()).toEqual([str(A._id), str(B._id)].sort());

    // the scoring thresholds follow the org too
    const { getThresholds } = require("../utils/settings");
    expect(await runWithOrg(A._id, () => getThresholds(A._id))).toEqual(good);
    expect(await runWithOrg(B._id, () => getThresholds(B._id))).toEqual(other);
  });

  test("a second save in the same org updates its document; the audit row belongs to that org", async () => {
    await put("/api/settings", ua.admin, good);
    await put("/api/settings", ua.admin, { ...good, driftThreshold: 0.2 });
    await put("/api/settings", ub.admin, other);
    expect(await sys(Settings).countDocuments({ orgId: A._id })).toBe(1);
    const logs = await sys(AuditLog).find({ action: "update_settings" }).sort({ seq: 1 });
    expect(logs.map((l) => str(l.orgId))).toEqual([str(A._id), str(A._id), str(B._id)]);
    expect(logs[1].details).toBe("Thresholds changed: driftThreshold 0.08->0.2");
    expect(logs[2].details).toContain("lowAccuracy 0.85->0.95"); // B's "before" is B's default, not A's value
  });

  test("a body orgId is ignored", async () => {
    const res = await put("/api/settings", ua.admin, { ...good, orgId: String(B._id) });
    expect(res.status).toBe(200);
    expect(await sys(Settings).countDocuments({ orgId: B._id })).toBe(0);
    expect(await sys(Settings).countDocuments({ orgId: A._id })).toBe(1);
  });

  test("super admin: org required; with X-Org-Id it edits exactly that org and the audit row carries the org", async () => {
    let res = await get("/api/settings", sa);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ORG_REQUIRED");
    res = await put("/api/settings", sa, good);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ORG_REQUIRED");

    res = await put("/api/settings", sa, good, A._id);
    expect(res.status).toBe(200);
    expect(res.body.settings.updatedByName).toBe(sa.user.name);
    expect((await get("/api/settings", sa, A._id)).body.settings).toEqual(expect.objectContaining(good));
    expect((await get("/api/settings", ub.admin)).body.settings.lowAccuracy).toBe(0.85);
    expect(await sys(Settings).countDocuments()).toBe(1);

    const log = await sys(AuditLog).findOne({ action: "update_settings" });
    expect(str(log.orgId)).toBe(str(A._id));
    expect(log.actorRole).toBe("super_admin");
  });
});

describe("stats", () => {
  test("counts, lists and tiers are per organization", async () => {
    let res = await get("/api/stats", ua.ml);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ models: 2, versions: 3, live: 2, awaitingReview: 1, needsReview: 1 });
    expect(res.body.byTier).toEqual({ low: 1, medium: 0, high: 1, unrated: 0 });
    expect(res.body.needsReview.map((v) => v.modelName)).toEqual(["A-Apex"]);
    expect(res.body.awaitingReview.map((v) => v.modelName)).toEqual(["A-Alpha"]);

    res = await get("/api/stats", ub.comp);
    expect(res.body.totals).toEqual({ models: 1, versions: 1, live: 0, awaitingReview: 1, needsReview: 0 });
    expect(res.body.byTier).toEqual({ low: 0, medium: 1, high: 0, unrated: 0 });
    expect(res.body.needsReview).toEqual([]);
    expect(res.body.awaitingReview.map((v) => v.modelName)).toEqual(["B-Beta"]);
  });

  test("users block counts the org's own people; pending is separate; unverified is nowhere", async () => {
    await makeUser("ml_engineer", { orgId: A._id, status: "pending" });
    await makeUser("ml_engineer", { orgId: A._id, status: "pending" });
    await makeUser("compliance_officer", { orgId: A._id, status: "unverified" });
    await makeUser("ml_engineer", { orgId: A._id, status: "invited" });
    await makeUser("ml_engineer", { orgId: A._id, extra: { isActive: false } });
    await makeUser("ml_engineer", { orgId: B._id, status: "pending" });

    let res = await get("/api/stats", ua.admin);
    expect(res.body.users).toEqual({ total: 5, active: 4, pending: 2, byRole: { admin: 1, ml_engineer: 3, compliance_officer: 1 } });
    res = await get("/api/stats", ub.admin);
    expect(res.body.users).toEqual({ total: 3, active: 3, pending: 1, byRole: { admin: 1, ml_engineer: 1, compliance_officer: 1 } });
    expect((await get("/api/stats", ua.ml)).body.users).toBeUndefined();
    expect((await get("/api/stats", ub.comp)).body.users).toBeUndefined();
  });

  test("super admin: org required; with X-Org-Id it sees that org's numbers and users block (not itself)", async () => {
    const res0 = await get("/api/stats", sa);
    expect(res0.status).toBe(400);
    expect(res0.body.code).toBe("ORG_REQUIRED");

    const a = await get("/api/stats", sa, A._id);
    expect(a.status).toBe(200);
    expect(a.body.totals.models).toBe(2);
    expect(a.body.users).toEqual({ total: 3, active: 3, pending: 0, byRole: { admin: 1, ml_engineer: 1, compliance_officer: 1 } });
    const b = await get("/api/stats", sa, B._id);
    expect(b.body.totals.models).toBe(1);
    expect(b.body.users.total).toBe(3);
  });
});

describe("trash", () => {
  test("lists only the org's archived rows", async () => {
    let res = await get("/api/trash", ua.admin);
    expect(res.status).toBe(200);
    expect(res.body.models.map((m) => m.name)).toEqual(["A-Gone"]);
    expect(res.body.models[0].deletedByName).toBe(ua.admin.user.name);
    expect(res.body.versions).toEqual([]);

    res = await get("/api/trash", ub.admin);
    expect(res.body.models.map((m) => m.name).sort()).toEqual(["B-Gone", "B-Gone2"]);
    expect(JSON.stringify(res.body)).not.toContain("A-");
    expect(res.body.versions).toEqual([]); // B's archived version came back with its archived model
  });

  test("an individually archived version shows its parent name only from its own org; non-admins get 403", async () => {
    const m = await Model.findOne({ name: "A-Alpha" }).setOptions({ bypassTenant: true });
    const v = await sys(Version).findOne({ modelId: m._id, versionNumber: 2 });
    await v.softDelete({ by: ua.ml.user._id, reason: "oops" });
    const res = await get("/api/trash", ua.admin);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0]).toMatchObject({ modelName: "A-Alpha", deletedByName: ua.ml.user.name });
    expect((await get("/api/trash", ub.admin)).body.versions).toEqual([]);
    for (const who of [ua.ml, ua.comp]) expect((await get("/api/trash", who)).status).toBe(403);
  });

  test("super admin: org required; with X-Org-Id exactly that org", async () => {
    const res0 = await get("/api/trash", sa);
    expect(res0.status).toBe(400);
    expect(res0.body.code).toBe("ORG_REQUIRED");
    expect((await get("/api/trash", sa, A._id)).body.models.map((m) => m.name)).toEqual(["A-Gone"]);
    expect((await get("/api/trash", sa, B._id)).body.models).toHaveLength(2);
  });
});

describe("audit log: org users", () => {
  test("org admin and compliance see their own org only; rows expose orgId, no orgName", async () => {
    for (const who of [ua.admin, ua.comp]) {
      const res = await get("/api/audit-log?limit=100", who);
      expect(res.status).toBe(200);
      expect(res.body.scoped).toBe(false);
      expect(seenNotes(res)).toEqual(A_NOTES);
      expect(res.body.logs.every((l) => str(l.orgId) === str(A._id))).toBe(true);
      expect(res.body.logs.some((l) => "orgName" in l)).toBe(false);
      expect(res.body.total).toBe(res.body.logs.length);
    }
    const resB = await get("/api/audit-log?limit=100", ub.admin);
    expect(seenNotes(resB)).toEqual(B_NOTES);
    expect(resB.body.logs.every((l) => str(l.orgId) === str(B._id))).toBe(true);
  });

  test("?orgId= never widens or moves the scope of a non-super user", async () => {
    const base = await get("/api/audit-log?limit=100", ua.admin);
    for (const q of [`orgId=${B._id}`, `orgId=${A._id}`, "orgId=", `orgId=${oid()}`]) {
      const res = await get(`/api/audit-log?limit=100&${q}`, ua.admin);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(base.body.total);
      expect(seenNotes(res)).toEqual(A_NOTES);
    }
    expect((await get("/api/audit-log?orgId=not-an-id", ua.admin)).status).toBe(400);
    expect((await get("/api/audit-log?orgId[$ne]=x", ua.admin)).status).toBe(400);
    expect(seenNotes(await get(`/api/audit-log?limit=100&orgId=${B._id}`, ua.comp))).toEqual(A_NOTES);
    // export and verify too
    const ex = await get(`/api/audit-log/export?orgId=${B._id}`, ua.admin);
    expect(ex.text).toContain("A-admin-note");
    expect(ex.text).not.toContain("B-admin-note");
  });

  test("a filter that matches another org's rows returns nothing", async () => {
    expect((await get("/api/audit-log?q=B-admin-note", ua.admin)).body.total).toBe(0);
    expect((await get("/api/audit-log?q=platform-event", ua.admin)).body.total).toBe(0);
    expect((await get("/api/audit-log?actorRole=super_admin", ua.admin)).body.total).toBe(0);
  });

  test("ml_engineer keeps the narrow scope inside the org, and the legacy-by-name rule stops at the org border", async () => {
    // a legacy row of A under the engineer's name IS visible, the one in B with the same name is not
    await raw().insertOne({
      orgId: A._id, actorName: ua.ml.user.name, actorRole: "ml_engineer", action: "upload_version", targetType: "Version",
      targetId: oid(), details: "A-legacy-own", createdAt: new Date(2),
    });
    const res = await get("/api/audit-log?limit=100", ua.ml);
    expect(res.body.scoped).toBe(true);
    expect(details(res).sort()).toEqual(["A-legacy-own", "A-ml-note"]);
    expect(res.body.logs.every((l) => str(l.orgId) === str(A._id))).toBe(true);
    expect(details(await get("/api/audit-log?limit=100", ub.ml)).sort()).toEqual(["B-ml-note"]);
  });

  test("ml_engineer cannot reach org entries through ?orgId= either", async () => {
    const res = await get(`/api/audit-log?limit=100&orgId=${B._id}`, ua.ml);
    expect(details(res).sort()).toEqual(["A-ml-note"]);
  });

  test("export: admin and compliance get only their org (header unchanged); ml is 403", async () => {
    for (const who of [ua.admin, ua.comp]) {
      const res = await get("/api/audit-log/export", who);
      expect(res.status).toBe(200);
      expect(res.text.split("\r\n")[0]).toBe("seq,createdAt,actorName,actorRole,action,targetType,targetId,details,hash");
      for (const n of A_NOTES) expect(res.text).toContain(n);
      for (const n of ["B-admin-note", "B-ml-note", "B-comp-note", "B-legacy", "platform-event"]) expect(res.text).not.toContain(n);
    }
    expect((await get("/api/audit-log/export", ua.ml)).status).toBe(403);
  });

  test("failed logins are attributed to the account's org (unknown emails to no org)", async () => {
    const fail = (email) => request(app).post("/api/auth/login").send({ email, password: "wrong-Password1" });
    expect((await fail(ua.admin.user.email)).status).toBe(401);
    expect((await fail(ub.ml.user.email)).status).toBe(401);
    expect((await fail("nobody@nowhere.test")).status).toBe(401);

    const failed = await sys(AuditLog).find({ action: "login_failed" }).sort({ seq: 1 }).lean();
    expect(failed).toHaveLength(3);
    expect(str(failed[0].orgId)).toBe(str(A._id));
    expect(str(failed[1].orgId)).toBe(str(B._id));
    expect(failed[2].orgId == null).toBe(true);

    const asA = await get("/api/audit-log?limit=100&action=login_failed", ua.admin);
    expect(asA.body.logs).toHaveLength(1);
    expect(str(asA.body.logs[0].orgId)).toBe(str(A._id));
    const asB = await get("/api/audit-log?limit=100&action=login_failed", ub.admin);
    expect(asB.body.logs).toHaveLength(1);
    expect(str(asB.body.logs[0].orgId)).toBe(str(B._id));
    // the unknown-email attempt is a platform event: only the super admin sees it
    const all = await get("/api/audit-log?limit=100&action=login_failed", sa);
    expect(all.body.logs).toHaveLength(3);
    expect(all.body.logs.filter((l) => l.orgId === null)).toHaveLength(1);
  });
});

describe("audit log: super admin", () => {
  test("works without a selected org: everything, platform entries included, with orgId and orgName on every row", async () => {
    const res = await get("/api/audit-log?limit=100", sa);
    expect(res.status).toBe(200);
    expect(seenNotes(res)).toEqual([...A_NOTES, ...B_NOTES, "platform-event"].sort());
    const row = (d) => res.body.logs.find((l) => l.details === d);
    expect(str(row("A-admin-note").orgId)).toBe(str(A._id));
    expect(row("A-admin-note").orgName).toBe("Org A");
    expect(row("B-ml-note").orgName).toBe("Org B");
    expect(row("platform-event").orgId).toBeNull();
    expect(row("platform-event").orgName).toBeNull();
    expect(res.body.logs.every((l) => "orgId" in l && "orgName" in l)).toBe(true);
    expect(res.body.scoped).toBe(false);
  });

  test("?orgId= narrows the all-orgs view; unknown id is empty; malformed is 400", async () => {
    let res = await get(`/api/audit-log?limit=100&orgId=${B._id}`, sa);
    expect(seenNotes(res)).toEqual(B_NOTES);
    expect(res.body.logs.every((l) => str(l.orgId) === str(B._id) && l.orgName === "Org B")).toBe(true);
    res = await get(`/api/audit-log?limit=100&orgId=${oid()}`, sa);
    expect(res.body.total).toBe(0);
    expect((await get("/api/audit-log?orgId=xyz", sa)).status).toBe(400);
    // composes with the other filters
    res = await get(`/api/audit-log?orgId=${A._id}&action=approve`, sa);
    expect(details(res)).toEqual(["A-comp-note"]);
  });

  test("with an org selected it is exactly that org (no orgName, ?orgId= cannot leave it)", async () => {
    let res = await get("/api/audit-log?limit=100", sa, A._id);
    expect(res.status).toBe(200);
    expect(seenNotes(res)).toEqual(A_NOTES);
    expect(res.body.logs.every((l) => str(l.orgId) === str(A._id))).toBe(true);
    expect(res.body.logs.some((l) => "orgName" in l)).toBe(false);
    res = await get(`/api/audit-log?limit=100&orgId=${B._id}`, sa, A._id);
    expect(seenNotes(res)).toEqual(A_NOTES);
    expect(seenNotes(await get("/api/audit-log?limit=100", sa, B._id))).toEqual(B_NOTES);
  });

  test("an unknown X-Org-Id is 400 ORG_REQUIRED, never the all-orgs view", async () => {
    const res = await get("/api/audit-log", sa, oid());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ORG_REQUIRED");
    expect((await get("/api/audit-log", sa).set("X-Org-Id", "not-an-id")).status).toBe(400);
  });

  test("an org admin's X-Org-Id header is ignored: still only the own org", async () => {
    const res = await get("/api/audit-log?limit=100", ua.admin, B._id);
    expect(seenNotes(res)).toEqual(A_NOTES);
  });

  test("audit rows of a super admin acting in org A carry orgId A (and org_access is A's too)", async () => {
    await put("/api/settings", sa, good, A._id);
    await get("/api/stats", sa, B._id);
    const rows = await sys(AuditLog).find({ actorRole: "super_admin", action: { $in: ["update_settings", "org_access"] } }).sort({ seq: 1 }).lean();
    expect(rows.map((r) => [r.action, str(r.orgId)])).toEqual([
      ["org_access", str(A._id)],
      ["update_settings", str(A._id)],
      ["org_access", str(B._id)],
    ]);
    // A's admin sees what happened in A, B's admin does not
    const asA = await get("/api/audit-log?limit=100&actorRole=super_admin", ua.admin);
    expect(asA.body.logs.map((l) => l.action).sort()).toEqual(["org_access", "update_settings"]);
    const asB = await get("/api/audit-log?limit=100&actorRole=super_admin", ub.admin);
    expect(asB.body.logs.map((l) => l.action)).toEqual(["org_access"]);
  });

  test("export: all orgs (with orgId/orgName columns), one org via header or ?orgId=", async () => {
    let res = await get("/api/audit-log/export", sa);
    expect(res.status).toBe(200);
    expect(res.text.split("\r\n")[0]).toBe("seq,createdAt,actorName,actorRole,action,targetType,targetId,details,hash,orgId,orgName");
    for (const n of NOTES) expect(res.text).toContain(n);
    const line = res.text.split("\r\n").find((l) => l.includes("B-admin-note"));
    expect(line.endsWith(`,${B._id},Org B`)).toBe(true);
    const plat = res.text.split("\r\n").find((l) => l.includes("platform-event"));
    expect(plat.endsWith(",,")).toBe(true);

    res = await get(`/api/audit-log/export?orgId=${A._id}`, sa);
    expect(res.text).toContain("A-admin-note");
    expect(res.text).not.toContain("B-admin-note");
    expect(res.text).not.toContain("platform-event");

    res = await get("/api/audit-log/export", sa, B._id);
    expect(res.text.split("\r\n")[0]).toBe("seq,createdAt,actorName,actorRole,action,targetType,targetId,details,hash");
    expect(res.text).toContain("B-admin-note");
    expect(res.text).not.toContain("A-admin-note");
    expect((await get("/api/audit-log/export?orgId=zzz", sa)).status).toBe(400);
  });
});

describe("audit log: verify", () => {
  const FOREIGN_KEYS = ["head", "checked", "brokenAtSeq", "brokenSeqs", "brokenCount", "hashAlgs.total"];
  const seqOf = async (d) => (await sys(AuditLog).findOne({ details: d })).seq;

  test("org admin: { ok, entries, brokenInOrg, ... } about its own entries only; no head or foreign counts", async () => {
    const resA = await get("/api/audit-log/verify", ua.admin);
    expect(resA.status).toBe(200);
    expect(Object.keys(resA.body).sort()).toEqual(["brokenInOrg", "entries", "hashAlgs", "keyed", "legacyUnchained", "ok"]);
    expect(resA.body).toEqual({ ok: true, entries: 3, brokenInOrg: [], hashAlgs: { sha256: 3, "hmac-sha256": 0 }, keyed: false, legacyUnchained: 0 });

    const resB = await get("/api/audit-log/verify", ub.admin);
    expect(resB.body).toMatchObject({ ok: true, entries: 3, brokenInOrg: [], legacyUnchained: 1 });
    expect(resB.body.hashAlgs).toEqual({ sha256: 3, "hmac-sha256": 0 });
    for (const k of FOREIGN_KEYS) expect(resA.body[k]).toBeUndefined();
    // the platform entry and the other org's entries are in nobody else's numbers
    expect(resA.body.entries + resB.body.entries).toBe(6);
    expect((await get("/api/audit-log/verify", sa)).body.checked).toBe(7);
  });

  test("a tampered row of org B: ok=false for everyone, but only B's admin is told which seq; A learns no seq", async () => {
    const bSeq = await seqOf("B-ml-note");
    await raw().updateOne({ seq: bSeq }, { $set: { details: "tampered" } });

    const resA = await get("/api/audit-log/verify", ua.admin);
    expect(resA.body.ok).toBe(false);
    expect(resA.body.brokenInOrg).toEqual([]);
    for (const k of FOREIGN_KEYS) expect(resA.body[k]).toBeUndefined();

    const resB = await get("/api/audit-log/verify", ub.admin);
    expect(resB.body.ok).toBe(false);
    expect(resB.body.brokenInOrg).toEqual([bSeq]);

    const resS = await get("/api/audit-log/verify", sa);
    expect(resS.body).toMatchObject({ ok: false, brokenAtSeq: bSeq, brokenSeqs: [bSeq] });
    expect(resS.body.head).toBeTruthy();

    // a break in A shows up in A's list too, B's list is unchanged
    const aSeq = await seqOf("A-admin-note");
    await raw().updateOne({ seq: aSeq }, { $set: { details: "tampered too" } });
    expect((await get("/api/audit-log/verify", ua.admin)).body.brokenInOrg).toEqual([aSeq]);
    expect((await get("/api/audit-log/verify", ub.admin)).body.brokenInOrg).toEqual([bSeq]);
  });

  test("super admin gets the full output (also with an org selected); non-admins 403", async () => {
    // (entering org A the first time writes one org_access entry, so the second chain has 8 rows)
    for (const [orgId, rows] of [[undefined, 7], [A._id, 8]]) {
      const res = await get("/api/audit-log/verify", sa, orgId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, checked: rows, legacyUnchained: 1, keyed: false });
      expect(res.body.head.seq).toBe(rows);
    }
    for (const who of [ua.ml, ua.comp, ub.ml]) expect((await get("/api/audit-log/verify", who)).status).toBe(403);
  });

  test("expectedHead*: an org admin can only confirm its own entries; seqs above 9 are accepted", async () => {
    // pad the chain so seqs have two digits
    for (let i = 0; i < 6; i += 1) await note(ub.admin.user, `B-pad-${i}`);
    const aRow = await sys(AuditLog).findOne({ details: "A-ml-note" }).lean();
    const bRow = await sys(AuditLog).findOne({ details: "B-pad-5" }).lean();
    expect(bRow.seq).toBeGreaterThan(9);
    const q = (r) => `?expectedHeadSeq=${r.seq}&expectedHeadHash=${r.hash}`;

    expect((await get(`/api/audit-log/verify${q(aRow)}`, ua.admin)).body.headMatches).toBe(true);
    // B's row, asked by A: no confirmation, exactly like a missing row
    expect((await get(`/api/audit-log/verify${q(bRow)}`, ua.admin)).body.headMatches).toBe(false);
    expect((await get(`/api/audit-log/verify${q(bRow)}`, ub.admin)).body.headMatches).toBe(true);
    expect((await get(`/api/audit-log/verify${q(bRow)}`, sa)).body.headMatches).toBe(true);
    expect((await get(`/api/audit-log/verify${q(bRow)}`, sa, A._id)).body.headMatches).toBe(true);
  });
});
