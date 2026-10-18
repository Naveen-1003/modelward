const request = require("supertest");
const { connect, reset, disconnect, makeUser, auth } = require("./helpers");

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
    expect(res.body.users[0]).toEqual(expect.objectContaining({ id: expect.any(String), isActive: true }));

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

describe("create", () => {
  test("admin creates any role without an invite code; audited; login works", async () => {
    const { token, user: admin } = await makeUser("admin");
    const res = await auth(request(app).post("/api/users"), token).send({
      name: " New Admin ", email: "NewAdmin@Test.Local", password: "Password1!", role: "admin",
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual(expect.objectContaining({ name: "New Admin", email: "newadmin@test.local", role: "admin", isActive: true }));
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");

    const log = await AuditLog.findOne({ action: "create_user" });
    expect(log.actorId.toString()).toBe(String(admin._id));
    expect(log.targetId.toString()).toBe(res.body.user.id);

    const login = await request(app).post("/api/auth/login").send({ email: "newadmin@test.local", password: "Password1!" });
    expect(login.status).toBe(200);
  });

  test("validation + duplicates", async () => {
    const { token } = await makeUser("admin");
    const post = (b) => auth(request(app).post("/api/users"), token).send(b);
    const ok = { name: "A", email: "a@test.local", password: "Password1!", role: "ml_engineer" };
    expect((await post({ ...ok, email: { $gt: "" } })).status).toBe(400);
    expect((await post({ ...ok, email: "nope" })).status).toBe(400);
    expect((await post({ ...ok, password: "short" })).status).toBe(400);
    expect((await post({ ...ok, role: "root" })).status).toBe(400);
    expect((await post({ ...ok, name: "x".repeat(101) })).status).toBe(400);
    expect((await post(ok)).status).toBe(201);
    expect((await post({ ...ok, email: "A@TEST.local" })).status).toBe(409);
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

    const logs = await AuditLog.find({ action: "update_user" }).sort({ seq: 1 });
    expect(logs).toHaveLength(3);
    expect(logs[0].details).toMatch(/role ml_engineer -> compliance_officer/);
    expect(logs[1].details).toMatch(/isActive true -> false/);
  });

  test("no-op patch does not write an audit entry", async () => {
    const { token } = await makeUser("admin");
    const { user } = await makeUser("ml_engineer", { name: "Same" });
    const res = await auth(request(app).patch(`/api/users/${user._id}`), token).send({ name: "Same", isActive: true });
    expect(res.status).toBe(200);
    expect(await AuditLog.countDocuments({ action: "update_user" })).toBe(0);
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
    expect((await User.findById(admin._id)).role).toBe("admin");
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
    expect(await User.countDocuments({ role: "admin", isActive: true })).toBe(1);
  });

  test("deactivated admins stop counting; the sole remaining admin is protected by the self guard", async () => {
    const a = await makeUser("admin");
    const b = await makeUser("admin");
    const c = await makeUser("admin");
    const patch = (who, id, body) => auth(request(app).patch(`/api/users/${id}`), who.token).send(body);
    expect((await patch(a, b.user._id, { isActive: false })).status).toBe(200);
    expect((await patch(a, c.user._id, { isActive: false })).status).toBe(200); // a remains
    expect(await User.countDocuments({ role: "admin", isActive: true })).toBe(1);
    // the sole remaining admin is protected by the self guard
    expect((await patch(a, a.user._id, { isActive: false })).status).toBe(400);
  });
});
