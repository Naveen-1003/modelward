const request = require("supertest");
const express = require("express");
const mongoose = require("mongoose");
const { connect, reset, disconnect, makeUser, auth } = require("./helpers");

let app, env, User, AuditLog, rateLimit;

// reset() drops the DB; index creation is the migrations job (owned elsewhere), but
// our tests must not depend on its timing, so rebuild the indexes we rely on here.
async function fresh() {
  await reset();
  await Promise.all([User.createIndexes(), AuditLog.createIndexes()]);
  rateLimit.resetAll();
}

beforeAll(async () => {
  await connect();
  app = require("../app");
  env = require("../config/env");
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  rateLimit = require("../middleware/rateLimit");
});
afterAll(disconnect);
beforeEach(fresh);

const signup = (body) => request(app).post("/api/auth/signup").send(body);
const valid = (over = {}) => ({ name: "Ada", email: "ada@test.local", password: "Password1!", role: "ml_engineer", ...over });

describe("signup gating", () => {
  const saved = {};
  beforeEach(() => {
    saved.admin = env.adminInviteCode;
    saved.comp = env.complianceInviteCode;
  });
  afterEach(() => {
    env.adminInviteCode = saved.admin;
    env.complianceInviteCode = saved.comp;
  });

  test("ml_engineer is open and returns token + safe user", async () => {
    const res = await signup(valid());
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual(expect.objectContaining({ email: "ada@test.local", role: "ml_engineer", isActive: true }));
    expect(Object.keys(res.body.user).sort()).toEqual(["createdAt", "email", "id", "isActive", "name", "role"]);
  });

  test.each([
    ["admin", () => env.adminInviteCode],
    ["compliance_officer", () => env.complianceInviteCode],
  ])("%s: missing / wrong code => 403, right code => 201", async (role, code) => {
    let res = await signup(valid({ role }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Invalid invite code");

    res = await signup(valid({ role, inviteCode: "nope" }));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(code());
    expect(await User.countDocuments()).toBe(0);

    res = await signup(valid({ role, inviteCode: code() }));
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe(role);
  });

  test("role is disabled when its env code is unset (even if a code is sent)", async () => {
    env.adminInviteCode = "";
    env.complianceInviteCode = "";
    for (const role of ["admin", "compliance_officer"]) {
      for (const inviteCode of [undefined, "", "anything"]) {
        const res = await signup(valid({ role, inviteCode }));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Signup for this role is disabled");
      }
    }
    expect(await User.countDocuments()).toBe(0);
  });

  test("admin code does not unlock compliance_officer and vice versa", async () => {
    let res = await signup(valid({ role: "compliance_officer", inviteCode: env.adminInviteCode }));
    expect(res.status).toBe(403);
    res = await signup(valid({ role: "admin", inviteCode: env.complianceInviteCode }));
    expect(res.status).toBe(403);
  });
});

describe("signup validation", () => {
  test.each([
    ["email operator object", { email: { $gt: "" } }],
    ["email number", { email: 5 }],
    ["not-an-email", { email: "not-an-email" }],
    ["password too short", { password: "short" }],
    ["password too long", { password: "x".repeat(129) }],
    ["password object", { password: { $ne: "" } }],
    ["name empty", { name: "   " }],
    ["name too long", { name: "n".repeat(101) }],
    ["name object", { name: { $gt: "" } }],
    ["bad role", { role: "superuser" }],
    ["role object", { role: { $ne: "x" } }],
    ["inviteCode object", { inviteCode: { $ne: "" } }],
    ["email too long", { email: `${"a".repeat(250)}@test.local` }],
  ])("%s => 400", async (_label, over) => {
    const res = await signup(valid(over));
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(res.body.fields).toBeDefined();
  });

  test("missing body fields => 400", async () => {
    const res = await request(app).post("/api/auth/signup").send({});
    expect(res.status).toBe(400);
  });

  test("duplicate email => 409, case-insensitively", async () => {
    expect((await signup(valid())).status).toBe(201);
    expect((await signup(valid())).status).toBe(409);
    expect((await signup(valid({ email: "ADA@Test.Local" }))).status).toBe(409);
    expect(await User.countDocuments()).toBe(1);
  });

  test("email is lowercased and trimmed; name trimmed", async () => {
    const res = await signup(valid({ email: "  Mixed@Test.Local ", name: "  Bob  " }));
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("mixed@test.local");
    expect(res.body.user.name).toBe("Bob");
  });

  test("signup is audited with the new user as actor", async () => {
    const res = await signup(valid());
    const log = await AuditLog.findOne({ action: "signup" });
    expect(log.actorName).toBe("Ada");
    expect(log.actorRole).toBe("ml_engineer");
    expect(String(log.targetId)).toBe(res.body.user.id);
    expect(log.seq).toBe(1);
  });
});

describe("login", () => {
  test("success returns token+user and audits", async () => {
    const { user, password } = await makeUser("ml_engineer", { email: "u1@test.local" });
    const res = await request(app).post("/api/auth/login").send({ email: "U1@test.local", password });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(String(user._id));
    const me = await auth(request(app).get("/api/auth/me"), res.body.token);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("u1@test.local");
    expect(await AuditLog.countDocuments({ action: "login", actorId: user._id })).toBe(1);
  });

  test("wrong password and unknown email give the same 401, both audited as anonymous", async () => {
    const { user } = await makeUser("ml_engineer", { email: "u2@test.local" });
    const a = await request(app).post("/api/auth/login").send({ email: "u2@test.local", password: "wrong-password" });
    const b = await request(app).post("/api/auth/login").send({ email: "ghost@test.local\u0007", password: "wrong-password" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);

    const logs = await AuditLog.find({ action: "login_failed" }).sort({ seq: 1 });
    expect(logs).toHaveLength(2);
    expect(logs[0].actorName).toBe("anonymous");
    expect(logs[0].actorRole).toBe("none");
    expect(String(logs[0].targetId)).toBe(String(user._id));
    expect(logs[1].targetId).toBeUndefined();
    expect(logs[1].details).toContain("ghost@test.local");
    expect(logs[1].details).not.toMatch(/[\u0000-\u001f]/);
  });

  test("long attempted email is truncated in the audit details", async () => {
    await request(app).post("/api/auth/login").send({ email: "x".repeat(200), password: "wrong-password" });
    const log = await AuditLog.findOne({ action: "login_failed" });
    expect(log.details.length).toBeLessThan(160);
  });

  test.each([
    ["email operator", { email: { $gt: "" }, password: "x" }],
    ["password operator", { email: "a@b.co", password: { $ne: "" } }],
    ["email array", { email: ["a@b.co"], password: "x" }],
    ["password number", { email: "a@b.co", password: 12345678 }],
    ["missing both", {}],
    ["empty password", { email: "a@b.co", password: "" }],
  ])("%s => 400 (never 500)", async (_l, body) => {
    const res = await request(app).post("/api/auth/login").send(body);
    expect(res.status).toBe(400);
  });

  test("malformed JSON => 400", async () => {
    const res = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
  });

  test("deactivated user: correct password => 403; wrong password => 401 (no leak)", async () => {
    const { password } = await makeUser("ml_engineer", { email: "off@test.local", extra: { isActive: false } });
    let res = await request(app).post("/api/auth/login").send({ email: "off@test.local", password });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account is deactivated" });
    res = await request(app).post("/api/auth/login").send({ email: "off@test.local", password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password");
  });

  test("authGuard: deactivated => 401 'Account is deactivated'; deleted user => 401", async () => {
    const { user, token } = await makeUser("ml_engineer");
    expect((await auth(request(app).get("/api/auth/me"), token)).status).toBe(200);
    await User.updateOne({ _id: user._id }, { isActive: false });
    let res = await auth(request(app).get("/api/auth/me"), token);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Account is deactivated");
    await User.deleteOne({ _id: user._id });
    res = await auth(request(app).get("/api/auth/me"), token);
    expect(res.status).toBe(401);
  });

  test("garbage / missing tokens => 401", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await auth(request(app).get("/api/auth/me"), "garbage")).status).toBe(401);
  });

  test("unknown email still runs one bcrypt compare (timing equalised)", async () => {
    const bcrypt = require("bcryptjs");
    const spy = jest.spyOn(bcrypt, "compare");
    await request(app).post("/api/auth/login").send({ email: "nobody@test.local", password: "wrong-password" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("rate limiting", () => {
  test("429 after LOGIN_MAX_FAILURES failed logins; successes don't count", async () => {
    expect(env.loginMaxFailures).toBe(5);
    const { password } = await makeUser("ml_engineer", { email: "rl@test.local" });
    const bad = () => request(app).post("/api/auth/login").send({ email: "rl@test.local", password: "wrong-password" });
    const good = () => request(app).post("/api/auth/login").send({ email: "rl@test.local", password });

    for (let i = 0; i < 4; i += 1) expect((await bad()).status).toBe(401);
    expect((await good()).status).toBe(200); // must not consume budget
    expect((await bad()).status).toBe(401); // 5th failure still answered
    const blocked = await bad();
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.body.error).toMatch(/^Too many failed login attempts\. Try again in \d+ minutes?$/);
    expect((await good()).status).toBe(429); // even the right password is blocked while limited
  });

  test("fresh limiters are constructible with their own limits", async () => {
    const mini = express();
    mini.use(express.json());
    mini.post("/l", rateLimit.createLoginLimiter({ maxFailures: 2 }), (req, res) => res.status(req.body.ok ? 200 : 401).json({}));
    const s = (ok) => request(mini).post("/l").send({ ok });
    expect((await s(false)).status).toBe(401);
    expect((await s(true)).status).toBe(200);
    expect((await s(false)).status).toBe(401);
    expect((await s(false)).status).toBe(429);

    const sign = express();
    sign.post("/s", rateLimit.createSignupLimiter({ maxPerHour: 1 }), (req, res) => res.json({}));
    expect((await request(sign).post("/s")).status).toBe(200);
    const r = await request(sign).post("/s");
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/Too many signup attempts/);
  });
});

describe("public config", () => {
  test("GET /api/config needs no auth and reveals no codes", async () => {
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      allowModelFiles: true,
      maxUploadMb: expect.any(Number),
      enableDriftSimulation: expect.any(Boolean),
      storageMode: "local",
      minPasswordLength: 8,
      signupRolesRequiringCode: ["admin", "compliance_officer"],
    });
    expect(JSON.stringify(res.body)).not.toContain(env.adminInviteCode);
    expect(mongoose.connection.name).toMatch(/jest/);
  });
});
