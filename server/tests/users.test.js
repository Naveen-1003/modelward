const request = require("supertest");
const { connect, reset, disconnect, makeUser, makeOrg, auth, sys } = require("./helpers");
const { hashToken } = require("../utils/identity");

let app, User, AuditLog, rateLimit;

async function fresh() {
  await reset();
  await Promise.all([User.createIndexes(), AuditLog.createIndexes()]);
  rateLimit.resetAll();
}

beforeAll(async () => {
  await connect();
  app = require("../app");
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  rateLimit = require("../middleware/rateLimit");
});
afterAll(disconnect);
beforeEach(fresh);

describe("RBAC", () => {
  test.each(["ml_engineer", "compliance_officer"])("%s gets 403 on every users endpoint", async (role) => {
    const { token } = await makeUser(role);
    const { user: other } = await makeUser("ml_engineer");
    expect((await auth(request(app).get("/api/users"), token)).status).toBe(403);
    expect((await auth(request(app).post("/api/users"), token).send({})).status).toBe(403);
    expect((await auth(request(app).patch(`/api/users/${other._id}`), token).send({ name: "x" })).status).toBe(403);
  });

  test("unauthenticated => 401", async () => {
    expect((await request(app).get("/api/users")).status).toBe(401);
  });
});

describe("list", () => {
  test("paginates, filters by role, searches name/email, never leaks passwordHash", async () => {
    const { token } = await makeUser("admin", { name: "Root Admin", email: "root@test.local" });
    await makeUser("ml_engineer", { name: "Alice Smith", email: "alice@test.local" });
    await makeUser("ml_engineer", { name: "Bob (Jr.)", email: "bob@test.local" });
    await makeUser("compliance_officer", { name: "Carol", email: "carol@test.local" });

    let res = await auth(request(app).get("/api/users"), token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ page: 1, limit: 25, total: 4, pages: 1 }));
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(res.body.users[0]).toEqual(expect.objectContaining({ id: expect.any(String), isActive: true, status: "active" }));

    res = await auth(request(app).get("/api/users?limit=2&page=2"), token);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.pages).toBe(2);

    res = await auth(request(app).get("/api/users?role=ml_engineer"), token);
    expect(res.body.total).toBe(2);

    res = await auth(request(app).get("/api/users?q=ALICE"), token);
    expect(res.body.users.map((u) => u.name)).toEqual(["Alice Smith"]);
    res = await auth(request(app).get("/api/users?q=carol@test"), token);
    expect(res.body.total).toBe(1);

    // regex metacharacters are literal, not interpreted (and never a 500)
    res = await auth(request(app).get("/api/users").query({ q: "(Jr.)" }), token);
    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.name)).toEqual(["Bob (Jr.)"]);
    res = await auth(request(app).get("/api/users").query({ q: ".*" }), token);
    expect(res.body.total).toBe(0);
    res = await auth(request(app).get("/api/users").query({ q: "(" }), token);
    expect(res.status).toBe(200);
  });

  test("bad role filter => 400; garbage paging => defaults", async () => {
    const { token } = await makeUser("admin");
    expect((await auth(request(app).get("/api/users?role=king"), token)).status).toBe(400);
    const res = await auth(request(app).get("/api/users?limit=-3&page=abc"), token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ page: 1, limit: 25 }));
    expect((await auth(request(app).get("/api/users?limit=9999"), token)).body.limit).toBe(100);
  });
});

describe("create (Add user: invited + setup link)", () => {
  test("admin creates any org role without a password; invited; one-time setup link; audited; cannot sign in yet", async () => {
    const { token, user: admin } = await makeUser("admin");
    const res = await auth(request(app).post("/api/users"), token).send({
      name: " New Admin ", email: "NewAdmin@Test.Local", role: "admin",
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual(expect.objectContaining({ name: "New Admin", email: "newadmin@test.local", role: "admin", isActive: true, status: "invited" }));
    expect(String(res.body.user.orgId)).toBe(String(admin.orgId));
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|setupTokenHash|\$2[aby]\$/);
    // console provider: nothing left the server, so the link is handed back
    expect(res.body.emailSent).toBe(false);
    expect(res.body.setupLink).toMatch(/\/setup-password\?token=[a-f0-9]{64}$/);

    // only the hash of that token is stored, valid for ~72 h
    const rawToken = new URL(res.body.setupLink).searchParams.get("token");
    const stored = await sys(User).findById(res.body.user.id).select("+setupTokenHash");
    expect(stored.setupTokenHash).toBe(hashToken(rawToken));
    expect(stored.setupTokenHash).not.toBe(rawToken);
    const hours = (stored.setupExpiresAt.getTime() - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);

    const log = await sys(AuditLog).findOne({ action: "create_user" });
    expect(log.actorId.toString()).toBe(String(admin._id));
    expect(log.targetId.toString()).toBe(res.body.user.id);
    expect(String(log.orgId)).toBe(String(admin.orgId));
    expect(log.details).not.toContain(rawToken);

    // no password exists yet: a login attempt fails like any wrong password
    const login = await request(app).post("/api/auth/login").send({ email: "newadmin@test.local", password: "Password1!" });
    expect(login.status).toBe(401);
  });

  test("a password in the body is ignored (there is no password field any more)", async () => {
    const { token } = await makeUser("admin");
    const res = await auth(request(app).post("/api/users"), token).send({ name: "P", email: "p@test.local", role: "ml_engineer", password: "Password1!" });
    expect(res.status).toBe(201);
    const login = await request(app).post("/api/auth/login").send({ email: "p@test.local", password: "Password1!" });
    expect(login.status).toBe(401);
  });

  test("validation + duplicates", async () => {
    const { token } = await makeUser("admin");
    const post = (b) => auth(request(app).post("/api/users"), token).send(b);
    const ok = { name: "A", email: "a@test.local", role: "ml_engineer" };
    expect((await post({ ...ok, email: { $gt: "" } })).status).toBe(400);
    expect((await post({ ...ok, email: "nope" })).status).toBe(400);
    expect((await post({ ...ok, role: "root" })).status).toBe(400);
    expect((await post({ ...ok, role: "super_admin" })).status).toBe(400);
    expect((await post({ ...ok, role: undefined })).status).toBe(400);
    expect((await post({ ...ok, name: "x".repeat(101) })).status).toBe(400);
    expect((await post({ ...ok, name: "" })).status).toBe(400);
    expect((await post({ ...ok, allowExternalEmail: "yes" })).status).toBe(400);
    expect((await post(ok)).status).toBe(201);
    expect((await post({ ...ok, email: "A@TEST.local" })).status).toBe(409);
    // "one person, one account": a +tag alias is the same account
    expect((await post({ ...ok, email: "a+hr@test.local" })).status).toBe(409);
  });

  test("an email that exists in ANOTHER organization is a 409 too (global uniqueness)", async () => {
    const other = await makeOrg({ allowedDomains: ["other.local"] });
    await makeUser("ml_engineer", { orgId: other._id, email: "taken@test.local" });
    const { token } = await makeUser("admin");
    const res = await auth(request(app).post("/api/users"), token).send({ name: "T", email: "taken@test.local", role: "ml_engineer" });
    expect(res.status).toBe(409);
  });
});

describe("patch", () => {
  test("changes name/role/isActive and audits; deactivation kills existing tokens at once", async () => {
    const { token } = await makeUser("admin");
    const { user, token: userToken } = await makeUser("ml_engineer", { name: "Old Name" });
    const patch = (b) => auth(request(app).patch(`/api/users/${user._id}`), token).send(b);

    let res = await patch({ name: "New Name", role: "compliance_officer" });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(expect.objectContaining({ name: "New Name", role: "compliance_officer" }));

    res = await patch({ isActive: false });
    expect(res.body.user.isActive).toBe(false);
    const me = await auth(request(app).get("/api/auth/me"), userToken);
    expect(me.status).toBe(401);
    expect(me.body.error).toBe("Account is deactivated");

    res = await patch({ isActive: true });
    expect(res.body.user.isActive).toBe(true);
    expect((await auth(request(app).get("/api/auth/me"), userToken)).status).toBe(200);

    const logs = await sys(AuditLog).find({ action: "update_user" }).sort({ seq: 1 });
    expect(logs).toHaveLength(3);
    expect(logs[0].details).toMatch(/role ml_engineer -> compliance_officer/);
    expect(logs[1].details).toMatch(/isActive true -> false/);
  });

  test("no-op patch does not write an audit entry", async () => {
    const { token } = await makeUser("admin");
    const { user } = await makeUser("ml_engineer", { name: "Same" });
    const res = await auth(request(app).patch(`/api/users/${user._id}`), token).send({ name: "Same", isActive: true });
    expect(res.status).toBe(200);
    expect(await sys(AuditLog).countDocuments({ action: "update_user" })).toBe(0);
  });

  test("validation: empty body, bad types, bad id, unknown id", async () => {
    const { token, user: admin } = await makeUser("admin");
    const { user } = await makeUser("ml_engineer");
    const p = (id, b) => auth(request(app).patch(`/api/users/${id}`), token).send(b);
    expect((await p(user._id, {})).status).toBe(400);
    expect((await p(user._id, { role: "king" })).status).toBe(400);
    expect((await p(user._id, { role: { $ne: "" } })).status).toBe(400);
    expect((await p(user._id, { isActive: "false" })).status).toBe(400);
    expect((await p(user._id, { name: "" })).status).toBe(400);
    expect((await p("not-an-id", { name: "x" })).status).toBe(400);
    expect((await p("64b64b64b64b64b64b64b64b", { name: "x" })).status).toBe(404);
    expect(String(admin._id)).toBeTruthy();
  });

  test("an admin cannot change their own role or deactivate themselves (400); renaming self is fine", async () => {
    const { token, user: admin } = await makeUser("admin");
    await makeUser("admin"); // a second admin exists, so only the self-guard applies
    const p = (b) => auth(request(app).patch(`/api/users/${admin._id}`), token).send(b);
    let res = await p({ role: "ml_engineer" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own role/);
    res = await p({ isActive: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deactivate your own/);
    expect((await p({ role: "admin", name: "Renamed" })).status).toBe(200);
    expect((await sys(User).findById(admin._id)).role).toBe("admin");
  });

  test("admins can demote/deactivate each other while another active admin remains", async () => {
    const a = await makeUser("admin");
    const b = await makeUser("admin");
    const res = await auth(request(app).patch(`/api/users/${b.user._id}`), a.token).send({ role: "ml_engineer" });
    expect(res.status).toBe(200);
    // b is no longer an admin: its token is now rejected on admin routes
    expect((await auth(request(app).get("/api/users"), b.token)).status).toBe(403);
    // and a (the only admin left) cannot touch itself, so the system keeps >= 1 admin
    expect((await auth(request(app).patch(`/api/users/${a.user._id}`), a.token).send({ role: "ml_engineer" })).status).toBe(400);
    expect(await sys(User).countDocuments({ role: "admin", isActive: true })).toBe(1);
  });

  test("deactivated admins stop counting; the sole remaining admin is protected by the self guard", async () => {
    const a = await makeUser("admin");
    const b = await makeUser("admin");
    const c = await makeUser("admin");
    const patch = (who, id, body) => auth(request(app).patch(`/api/users/${id}`), who.token).send(body);
    expect((await patch(a, b.user._id, { isActive: false })).status).toBe(200);
    expect((await patch(a, c.user._id, { isActive: false })).status).toBe(200); // a remains
    expect(await sys(User).countDocuments({ role: "admin", isActive: true })).toBe(1);
    // the sole remaining admin is protected by the self guard
    expect((await patch(a, a.user._id, { isActive: false })).status).toBe(400);
  });
});

describe("delete", () => {
  const del = (token, id) => auth(request(app).delete(`/api/users/${id}`), token);

  test("removes the account, frees the email, keeps an audit row; the user's token stops working", async () => {
    const { token } = await makeUser("admin");
    const { user, token: userToken } = await makeUser("ml_engineer", { email: "gone@test.local" });
    const res = await del(token, user._id);
    expect(res.status).toBe(200);
    expect(await sys(User).countDocuments({ _id: user._id })).toBe(0);
    expect((await auth(request(app).get("/api/models"), userToken)).status).toBe(401);
    const row = await sys(AuditLog).findOne({ action: "user_delete", targetId: user._id });
    expect(row.details).toMatch(/gone@test\.local/);
    // the address is free again
    expect((await auth(request(app).post("/api/users"), token).send({ name: "Back Again", email: "gone@test.local", role: "ml_engineer", allowExternalEmail: true })).status).toBe(201);
  });

  test("cannot delete yourself or the last active admin; 404 for unknown / pending / other org", async () => {
    const { user: admin, token } = await makeUser("admin");
    expect((await del(token, admin._id)).status).toBe(400);
    const { token: t2, user: admin2 } = await makeUser("admin");
    expect((await del(t2, admin._id)).status).toBe(200); // one admin remains (themself)
    expect((await del(t2, admin2._id)).status).toBe(400);
    expect((await del(t2, "64b000000000000000000000")).status).toBe(404);
    const { user: pending } = await makeUser("ml_engineer", { status: "pending" });
    expect((await del(t2, pending._id)).status).toBe(404);
    const other = await makeOrg();
    const { user: foreign } = await makeUser("ml_engineer", { orgId: other._id });
    expect((await del(t2, foreign._id)).status).toBe(404);
    expect(await sys(User).countDocuments({ _id: foreign._id })).toBe(1);
  });

  test("ml engineers and compliance officers get 403", async () => {
    const { user: victim } = await makeUser("ml_engineer");
    for (const role of ["ml_engineer", "compliance_officer"]) {
      const { token } = await makeUser(role);
      expect((await del(token, victim._id)).status).toBe(403);
    }
  });
});
