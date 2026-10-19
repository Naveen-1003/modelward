const request = require("supertest");
const mongoose = require("mongoose");
const { connect, reset, disconnect, makeUser, makeOrg, sys, auth } = require("./helpers");

let app, AuditLog, User, writeAuditLog, rateLimit;
const raw = () => mongoose.connection.collection("auditlogs");

async function fresh() {
  await reset();
  await Promise.all([AuditLog.createIndexes(), User.createIndexes()]);
  rateLimit.resetAll();
}

beforeAll(async () => {
  await connect();
  app = require("../app");
  AuditLog = require("../models/AuditLog");
  User = require("../models/User");
  writeAuditLog = require("../middleware/audit");
  rateLimit = require("../middleware/rateLimit");
});
afterAll(disconnect);
beforeEach(fresh);

const oid = () => new mongoose.Types.ObjectId();
const entry = (actor, over = {}) => writeAuditLog({ actor, action: "create_model", targetType: "Model", targetId: oid(), details: "d", ...over });

describe("writeAuditLog + hash chain", () => {
  test("assigns consecutive seq, links prevHash, GENESIS first; verify ok", async () => {
    const { user } = await makeUser("admin");
    await entry(user);
    await entry(user);
    await entry(user);
    const logs = await sys(AuditLog).find().sort({ seq: 1 });
    expect(logs.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(logs[0].prevHash).toBe("GENESIS");
    expect(logs[1].prevHash).toBe(logs[0].hash);
    expect(logs[2].prevHash).toBe(logs[1].hash);
    expect(logs[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs[0].actorId.toString()).toBe(String(user._id));

    const { token } = await makeUser("super_admin"); // the full output (head, totals) is the super admin's
    const res = await auth(request(app).get("/api/audit-log/verify"), token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, checked: 3, legacyUnchained: 0, keyed: false });
    expect(res.body.brokenSeqs).toBeUndefined();
    expect(res.body.head.seq).toBe(3);
    expect(res.body.head.hash).toBe((await sys(AuditLog).findOne({ seq: 3 }).lean()).hash);
  });

  test("concurrent writers still produce a gap-free valid chain", async () => {
    const { user } = await makeUser("admin");
    await Promise.all(Array.from({ length: 15 }, (_, i) => entry(user, { details: `n${i}` })));
    const seqs = (await sys(AuditLog).find().sort({ seq: 1 })).map((l) => l.seq);
    expect(seqs).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  test("writers racing on the same seq (bypassing the in-process queue) retry on duplicate key", async () => {
    const { user } = await makeUser("admin");
    const fields = (i) => ({ orgId: user.orgId, actorName: user.name, actorRole: "admin", actorId: user._id, action: "login", targetType: "User", targetId: user._id, details: `r${i}` });
    await Promise.all(Array.from({ length: 5 }, (_, i) => writeAuditLog.appendEntry(fields(i))));
    const seqs = (await sys(AuditLog).find().sort({ seq: 1 })).map((l) => l.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    const { token } = await makeUser("admin");
    const ok = (await auth(request(app).get("/api/audit-log/verify"), token)).body;
    expect(ok).toMatchObject({ ok: true, entries: 5, brokenInOrg: [] });
  });

  test("never throws, tolerates null actor and missing fields, caps details", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(writeAuditLog({ actor: null, action: "login_failed", targetType: "User", details: "x".repeat(5000) })).resolves.not.toThrow();
    await expect(writeAuditLog({ actor: null, action: "not-a-real-action", targetType: "User" })).resolves.toBeUndefined();
    await expect(writeAuditLog()).resolves.toBeUndefined();
    const l = await sys(AuditLog).findOne();
    expect(l.actorName).toBe("anonymous");
    expect(l.actorRole).toBe("none");
    expect(l.targetId).toBeUndefined();
    expect(l.details).toHaveLength(2000);
    expect(await sys(AuditLog).countDocuments()).toBe(1);
    expect(errSpy).toHaveBeenCalledTimes(2); // the two invalid calls were logged, not thrown
    errSpy.mockRestore();
  });

  test("verify detects a modified entry, then a deleted entry (gap); counts legacy entries", async () => {
    const { user } = await makeUser("admin");
    for (let i = 0; i < 5; i += 1) await entry(user, { details: `row ${i}` });
    await raw().insertOne({ actorName: "Old", actorRole: "admin", action: "approve", targetType: "Version", targetId: oid(), details: "legacy", createdAt: new Date(0) });
    const { token } = await makeUser("super_admin");
    const verify = () => auth(request(app).get("/api/audit-log/verify"), token);

    let res = await verify();
    expect(res.body).toMatchObject({ ok: true, checked: 5, legacyUnchained: 1 });

    await raw().updateOne({ seq: 3 }, { $set: { details: "tampered" } });
    res = await verify();
    // the walk continues past the first break: all 5 rows examined, only row 3 flagged
    expect(res.body).toMatchObject({ ok: false, checked: 5, brokenAtSeq: 3, brokenSeqs: [3], legacyUnchained: 1 });

    await raw().updateOne({ seq: 3 }, { $set: { details: "row 2" } });
    expect((await verify()).body.ok).toBe(true);

    await raw().deleteOne({ seq: 2 });
    res = await verify();
    expect(res.body.ok).toBe(false);
    expect(res.body.brokenAtSeq).toBe(2);
  });

  test("verify: only admins; others 403", async () => {
    for (const role of ["ml_engineer", "compliance_officer"]) {
      const { token } = await makeUser(role);
      expect((await auth(request(app).get("/api/audit-log/verify"), token)).status).toBe(403);
    }
    expect((await request(app).get("/api/audit-log/verify")).status).toBe(401);
  });
});

describe("append-only", () => {
  test("update / delete / replace operations are blocked with AUDIT_LOG_IMMUTABLE", async () => {
    const { user } = await makeUser("admin");
    await entry(user);
    const doc = await sys(AuditLog).findOne();
    const id = doc._id;
    await expect(sys(AuditLog).updateOne({ _id: id }, { details: "x" })).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).updateMany({}, { details: "x" })).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).findOneAndUpdate({ _id: id }, { details: "x" })).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).findByIdAndUpdate(id, { details: "x" })).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).findOneAndReplace({ _id: id }, { actorName: "a" })).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).replaceOne({ _id: id }, { actorName: "a" })).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).deleteOne({ _id: id })).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).deleteMany({})).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).findOneAndDelete({ _id: id })).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(sys(AuditLog).findByIdAndDelete(id)).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    await expect(doc.deleteOne()).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    doc.details = "changed";
    await expect(doc.save()).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/);
    expect((await sys(AuditLog).findById(id)).details).toBe("d");
    expect(await sys(AuditLog).countDocuments()).toBe(1);
  });
});

describe("GET /api/audit-log", () => {
  test("pagination envelope; filters; q search is literal; strict limit/page parsing", async () => {
    const { user, token } = await makeUser("admin", { name: "Zed" });
    const { user: comp } = await makeUser("compliance_officer", { name: "Cora" });
    for (let i = 0; i < 30; i += 1) await entry(user, { details: `bulk ${i}` });
    await entry(comp, { action: "approve", targetType: "Version", details: "needle (1) .* ok" });
    await entry(comp, { action: "reject", targetType: "Version", details: "Reject now" });
    const get = (qs) => auth(request(app).get(`/api/audit-log${qs}`), token);

    let res = await get("");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ page: 1, limit: 25, total: 32, pages: 2, scoped: false }));
    expect(res.body.logs).toHaveLength(25);
    expect(Object.keys(res.body.logs[0]).sort()).toEqual(["_id", "action", "actorName", "actorRole", "createdAt", "details", "hash", "orgId", "seq", "targetId", "targetType"]);
    expect(res.body.logs[0].seq).toBe(32); // newest first

    res = await get("?page=2");
    expect(res.body.logs).toHaveLength(7);

    expect((await get("?action=approve")).body.total).toBe(1);
    expect((await get("?actorRole=compliance_officer")).body.total).toBe(2);
    expect((await get("?targetType=Version")).body.total).toBe(2);
    expect((await get("?q=CORA")).body.total).toBe(2); // actorName, case-insensitive
    expect((await get("?q=" + encodeURIComponent("(1) .*"))).body.total).toBe(1); // literal
    expect((await get("?q=" + encodeURIComponent("("))).status).toBe(200);
    expect((await get("?from=2999-01-01")).body.total).toBe(0);
    expect((await get("?to=2000-01-01")).body.total).toBe(0);
    expect((await get("?from=2000-01-01&to=2999-12-31")).body.total).toBe(32);
    const today = new Date().toISOString().slice(0, 10);
    expect((await get(`?to=${today}`)).body.total).toBe(32); // date-only `to` is inclusive of that day
    expect((await get("?from=not-a-date")).status).toBe(400);
    expect((await get("?action[$ne]=x")).status).toBe(400); // operator object rejected, not a 500
    expect((await get("?action=a&action=b")).status).toBe(400);

    // limit/page parsing
    expect((await get("?limit=-3")).body.limit).toBe(25);
    expect((await get("?limit=abc")).body.limit).toBe(25);
    expect((await get("?limit=0")).body.limit).toBe(25);
    expect((await get("?limit=9999")).body.limit).toBe(100);
    expect((await get("?limit=5")).body.logs).toHaveLength(5);
    expect((await get("?limit=1.5")).body.limit).toBe(25);
    expect((await get("?page=-2")).body.page).toBe(1);
    expect((await get("?page=abc")).body.page).toBe(1);
    expect((await get("?page=0")).body.page).toBe(1);
    expect((await get("?limit[]=3")).body.limit).toBe(25);
  });

  test("compliance_officer sees everything, unscoped", async () => {
    const { user } = await makeUser("admin");
    const { token } = await makeUser("compliance_officer");
    await entry(user);
    const res = await auth(request(app).get("/api/audit-log"), token);
    expect(res.body.scoped).toBe(false);
    expect(res.body.total).toBe(1);
  });

  test("401 without a token", async () => {
    expect((await request(app).get("/api/audit-log")).status).toBe(401);
  });

  test("ml_engineer is scoped to own actions + own models/versions (incl. archived) + legacy by name", async () => {
    const A = await makeUser("ml_engineer", { name: "Alice ML" });
    const B = await makeUser("ml_engineer", { name: "Bob ML" });
    const comp = await makeUser("compliance_officer");

    const orgId = A.user.orgId; // raw inserts bypass the tenant plugin, so the org is set by hand
    const modelA = oid(), modelB = oid(), archivedModelA = oid();
    const verA = oid(), verOnAModelByOther = oid(), verB = oid(), verByAOnBModel = oid();
    // raw inserts so this test doesn't depend on the domain schemas' required fields
    await mongoose.connection.collection("models").insertMany([
      { _id: modelA, name: "A model", createdBy: A.user._id, orgId },
      { _id: modelB, name: "B model", createdBy: B.user._id, orgId },
      { _id: archivedModelA, name: "A archived", createdBy: A.user._id, isDeleted: true, orgId },
    ]);
    await mongoose.connection.collection("versions").insertMany([
      { _id: verA, modelId: modelA, versionNumber: 1, createdBy: A.user._id, orgId },
      { _id: verOnAModelByOther, modelId: modelA, versionNumber: 2, createdBy: B.user._id, orgId },
      { _id: verB, modelId: modelB, versionNumber: 1, createdBy: B.user._id, orgId },
      { _id: verByAOnBModel, modelId: modelB, versionNumber: 2, createdBy: A.user._id, orgId },
    ]);

    await entry(A.user, { targetId: oid(), details: "A acted on unrelated" }); // actorId = A
    await entry(B.user, { targetId: modelB, details: "B model" });
    await entry(comp.user, { action: "approve", targetType: "Version", targetId: verA, details: "review of A version" });
    await entry(comp.user, { action: "approve", targetType: "Version", targetId: verOnAModelByOther, details: "review on A model, other's version" });
    await entry(comp.user, { action: "approve", targetType: "Version", targetId: verB, details: "review of B version" });
    await entry(comp.user, { action: "archive_model", targetType: "Model", targetId: archivedModelA, details: "archived A model" });
    await entry(comp.user, { action: "approve", targetType: "Version", targetId: verByAOnBModel, details: "review of A's version on B model" });
    await raw().insertOne({ orgId, actorName: "Alice ML", actorRole: "ml_engineer", action: "upload_version", targetType: "Version", targetId: oid(), details: "legacy by Alice", createdAt: new Date(1) });
    await raw().insertOne({ orgId, actorName: "Bob ML", actorRole: "ml_engineer", action: "upload_version", targetType: "Version", targetId: oid(), details: "legacy by Bob", createdAt: new Date(2) });

    const res = await auth(request(app).get("/api/audit-log?limit=100"), A.token);
    expect(res.status).toBe(200);
    expect(res.body.scoped).toBe(true);
    const details = res.body.logs.map((l) => l.details).sort();
    expect(details).toEqual(
      [
        "A acted on unrelated",
        "review of A version",
        "review on A model, other's version",
        "archived A model",
        "review of A's version on B model",
        "legacy by Alice",
      ].sort()
    );
    expect(res.body.total).toBe(6);

    // filters compose with scope instead of widening it
    const f = await auth(request(app).get("/api/audit-log?action=approve"), A.token);
    expect(f.body.total).toBe(3);
    const q = await auth(request(app).get("/api/audit-log?q=review%20of%20B%20version"), A.token);
    expect(q.body.logs.map((l) => l.details)).toEqual([]);

    const resB = await auth(request(app).get("/api/audit-log?limit=100"), B.token);
    expect(resB.body.logs.map((l) => l.details)).not.toContain("review of A version");
  });
});

describe("GET /api/audit-log/export", () => {
  test("ml_engineer 403; compliance_officer + admin get CSV with attachment header", async () => {
    const ml = await makeUser("ml_engineer");
    expect((await auth(request(app).get("/api/audit-log/export"), ml.token)).status).toBe(403);
    expect((await request(app).get("/api/audit-log/export")).status).toBe(401);

    const { user } = await makeUser("admin", { name: "Zed" });
    await entry(user, { details: "plain" });
    for (const role of ["compliance_officer", "admin"]) {
      const { token } = await makeUser(role);
      const res = await auth(request(app).get("/api/audit-log/export"), token);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
      expect(res.text.split("\r\n")[0]).toBe("seq,createdAt,actorName,actorRole,action,targetType,targetId,details,hash");
    }
  });

  test("RFC4180 quoting + formula-injection guard + filters", async () => {
    const { user, token } = await makeUser("admin", { name: "=cmd|calc" });
    await entry(user, { details: '=HYPERLINK("http://evil")' });
    await entry(user, { details: "+1+1" });
    await entry(user, { details: "-2" });
    await entry(user, { details: "@SUM(A1)" });
    await entry(user, { details: 'has, comma and "quote"\nand newline' });
    await entry(user, { details: "safe", action: "approve" });

    const res = await auth(request(app).get("/api/audit-log/export"), token);
    const text = res.text;
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(text).toContain(",'+1+1,");
    expect(text).toContain(",'-2,");
    expect(text).toContain(",'@SUM(A1),");
    expect(text).toContain(`'=cmd|calc`); // actorName guarded too
    expect(text).toContain(`"has, comma and ""quote""\nand newline"`);
    expect(text).not.toMatch(/,=HYPERLINK/);
    expect(text).not.toMatch(/,=cmd/);

    const filtered = await auth(request(app).get("/api/audit-log/export?action=approve"), token);
    const lines = filtered.text.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect((await auth(request(app).get("/api/audit-log/export?from=bad"), token)).status).toBe(400);
  });
});
