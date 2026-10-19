const request = require("supertest");
const express = require("express");
const mongoose = require("mongoose");
const { connect, reset, disconnect, makeUser, makeOrg, sys, auth } = require("./helpers");

let app, env, User, AuditLog, Organization, rateLimit, email, org;

// reset() drops the DB; index creation is the migrations job (owned elsewhere), but
// our tests must not depend on its timing, so rebuild the indexes we rely on here.
async function fresh() {
  await reset();
  await Promise.all([User.createIndexes(), AuditLog.createIndexes(), Organization.createIndexes()]);
  rateLimit.resetAll();
  email.clearOutbox();
  org = await makeOrg({ name: "Signup Test Org", allowedDomains: ["test.local"] });
}

beforeAll(async () => {
  await connect();
  app = require("../app");
  env = require("../config/env");
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  Organization = require("../models/Organization");
  rateLimit = require("../middleware/rateLimit");
  email = require("../utils/email");
});
afterAll(disconnect);
beforeEach(fresh);

const signup = (body) => request(app).post("/api/auth/signup").send(body);
const valid = (over = {}) => ({ name: "Ada", email: "ada@test.local", joinCode: org.codes.ml_engineer.value, ...over });
const findUser = (filter) => sys(User).findOne(filter);
const logs = (filter) => sys(AuditLog).find(filter).sort({ seq: 1 });

describe("signup gating (join codes)", () => {
  test("a valid code creates an unverified account: no token, no user object, no secrets", async () => {
    const res = await signup(valid());
    expect(res.status).toBe(201);
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    expect(Object.keys(res.body).sort()).toEqual(["devVerifyUrl", "emailSent", "message", "status"]);
    expect(res.body).toMatchObject({ status: "unverified", emailSent: true });
    const user = await findUser({ email: "ada@test.local" });
    expect(user).toMatchObject({ role: "ml_engineer", status: "unverified" });
    expect(String(user.orgId)).toBe(String(org._id));
  });

  test("wrong / missing / malformed code => the same generic 403; nothing is created", async () => {
    const bodies = [];
    for (const joinCode of ["ABCDEFGHJKLM", "nope", "test-admin-code", org.codes.ml_engineer.value.slice(1)]) {
      const res = await signup(valid({ joinCode }));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Invalid code or email not eligible" });
      expect(JSON.stringify(res.body)).not.toContain(org.codes.ml_engineer.value);
      bodies.push(res.text);
    }
    expect(new Set(bodies).size).toBe(1);
    const missing = await signup(valid({ joinCode: undefined }));
    expect(missing.status).toBe(400); // a missing field is a validation error, not a guess
    expect(await sys(User).countDocuments()).toBe(0);
  });

  test.each([
    ["ml_engineer", "ml_engineer"],
    ["compliance_officer", "compliance_officer"],
  ])("the %s code gives the %s role", async (kind, role) => {
    const res = await signup(valid({ joinCode: org.codes[kind].value }));
    expect(res.status).toBe(201);
    expect((await findUser({ email: "ada@test.local" })).role).toBe(role);
  });

  test("the body has no role: whatever it says is ignored (admin / super_admin / garbage)", async () => {
    for (const [i, role] of ["admin", "super_admin", "superuser", { $ne: "x" }].entries()) {
      const res = await signup(valid({ email: `r${i}@test.local`, role }));
      expect(res.status).toBe(201);
      expect((await findUser({ email: `r${i}@test.local` })).role).toBe("ml_engineer");
    }
  });

  test("the old environment invite codes are gone", () => {
    expect(env.adminInviteCode).toBeUndefined();
    expect(env.complianceInviteCode).toBeUndefined();
  });
});

describe("signup validation", () => {
  test.each([
    ["email operator object", { email: { $gt: "" } }],
    ["email number", { email: 5 }],
    ["not-an-email", { email: "not-an-email" }],
    ["name empty", { name: "   " }],
    ["name too long", { name: "n".repeat(101) }],
    ["name object", { name: { $gt: "" } }],
    ["joinCode object", { joinCode: { $ne: "" } }],
    ["joinCode empty", { joinCode: "" }],
    ["email too long", { email: `${"a".repeat(250)}@test.local` }],
  ])("%s => 400", async (_label, over) => {
    const res = await signup(valid(over));
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(res.body.fields).toBeDefined();
    expect(await sys(User).countDocuments()).toBe(0);
  });

  test("the signup form takes no password: a weak or strong one is ignored and never becomes the account's password", async () => {
    const res = await signup(valid({ password: "short" }));
    expect(res.status).toBe(201);
    const bcrypt = require("bcryptjs");
    const user = await findUser({ email: "ada@test.local" });
    expect(await bcrypt.compare("short", user.passwordHash)).toBe(false);
    const login = await request(app).post("/api/auth/login").send({ email: "ada@test.local", password: "short" });
    expect(login.status).toBe(401);
  });

  test("missing body fields => 400", async () => {
    const res = await request(app).post("/api/auth/signup").send({});
    expect(res.status).toBe(400);
  });

  test("duplicate email => 409, case-insensitively (once the first account is verified)", async () => {
    expect((await signup(valid())).status).toBe(201);
    await sys(User).updateOne({ email: "ada@test.local" }, { status: "pending" });
    expect((await signup(valid())).status).toBe(409);
    expect((await signup(valid({ email: "ADA@Test.Local" }))).status).toBe(409);
    expect(await sys(User).countDocuments()).toBe(1);
  });

  test("email is lowercased and trimmed; name trimmed", async () => {
    const res = await signup(valid({ email: "  Mixed@Test.Local ", name: "  Bob  " }));
    expect(res.status).toBe(201);
    const user = await findUser({ email: "mixed@test.local" });
    expect(user.name).toBe("Bob");
    expect(user.emailKey).toBe("mixed@test.local");
  });

  test("signup is audited with the new user as actor", async () => {
    await signup(valid());
    const user = await findUser({ email: "ada@test.local" });
    const log = await sys(AuditLog).findOne({ action: "signup" });
    expect(log.actorName).toBe("Ada");
    expect(log.actorRole).toBe("ml_engineer");
    expect(String(log.targetId)).toBe(String(user._id));
    expect(String(log.orgId)).toBe(String(org._id));
    expect(log.seq).toBe(1);
  });
});

describe("login", () => {
  test("success returns token+user and audits", async () => {
    const { user, password } = await makeUser("ml_engineer", { email: "u1@test.local" });
    const res = await request(app).post("/api/auth/login").send({ email: "U1@test.local", password });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(String(user._id));
    expect(res.body.user.orgName).toBe("Default Test Org");
    const me = await auth(request(app).get("/api/auth/me"), res.body.token);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("u1@test.local");
    expect(await sys(AuditLog).countDocuments({ action: "login", actorId: user._id })).toBe(1);
  });

  test("wrong password and unknown email give the same 401, both audited as anonymous", async () => {
    const { user } = await makeUser("ml_engineer", { email: "u2@test.local" });
    const a = await request(app).post("/api/auth/login").send({ email: "u2@test.local", password: "wrong-password" });
    const b = await request(app).post("/api/auth/login").send({ email: "ghost@test.local\u0007", password: "wrong-password" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);

    const rows = await logs({ action: "login_failed" });
    expect(rows).toHaveLength(2);
    expect(rows[0].actorName).toBe("anonymous");
    expect(rows[0].actorRole).toBe("none");
    expect(String(rows[0].targetId)).toBe(String(user._id));
    expect(String(rows[0].orgId)).toBe(String(user.orgId));
    expect(rows[1].targetId).toBeUndefined();
    expect(rows[1].orgId == null).toBe(true);
    expect(rows[1].details).toContain("ghost@test.local");
    expect(rows[1].details).not.toMatch(/[\u0000-\u001f]/);
  });

  test("long attempted email is truncated in the audit details", async () => {
    await request(app).post("/api/auth/login").send({ email: "x".repeat(200), password: "wrong-password" });
    const log = await sys(AuditLog).findOne({ action: "login_failed" });
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

  test("deactivated user: correct password => 403 + code; wrong password => 401 (no leak)", async () => {
    const { password } = await makeUser("ml_engineer", { email: "off@test.local", extra: { isActive: false } });
    let res = await request(app).post("/api/auth/login").send({ email: "off@test.local", password });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account is deactivated", code: "ACCOUNT_DEACTIVATED" });
    res = await request(app).post("/api/auth/login").send({ email: "off@test.local", password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password");
  });

  test("authGuard: deactivated => 401 'Account is deactivated'; deleted user => 401", async () => {
    const { user, token } = await makeUser("ml_engineer");
    expect((await auth(request(app).get("/api/auth/me"), token)).status).toBe(200);
    await sys(User).updateOne({ _id: user._id }, { isActive: false });
    let res = await auth(request(app).get("/api/auth/me"), token);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Account is deactivated");
    await sys(User).deleteOne({ _id: user._id });
    res = await auth(request(app).get("/api/auth/me"), token);
    expect(res.status).toBe(401);
  });

  test("authGuard: a token of an account that is not (or no longer) active, or of a suspended organization, is refused", async () => {
    const { user, token } = await makeUser("ml_engineer");
    await sys(User).updateOne({ _id: user._id }, { status: "pending" });
    expect((await auth(request(app).get("/api/auth/me"), token)).status).toBe(401);
    await sys(User).updateOne({ _id: user._id }, { status: "active" });
    expect((await auth(request(app).get("/api/auth/me"), token)).status).toBe(200);
    await Organization.updateOne({ _id: user.orgId }, { status: "suspended" });
    const res = await auth(request(app).get("/api/auth/me"), token);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Organization is suspended");
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

  test("a known user with a blocked status also runs exactly one bcrypt compare, before any status answer", async () => {
    const bcrypt = require("bcryptjs");
    const { password } = await makeUser("ml_engineer", { email: "wait@test.local", status: "pending" });
    const spy = jest.spyOn(bcrypt, "compare");
    const wrong = await request(app).post("/api/auth/login").send({ email: "wait@test.local", password: "wrong-password" });
    expect(wrong.status).toBe(401); // status is only revealed to somebody who knows the password
    const right = await request(app).post("/api/auth/login").send({ email: "wait@test.local", password });
    expect(right.status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(2);
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

  test("the real signup route is limited per IP (SIGNUP_MAX_PER_HOUR)", async () => {
    expect(env.signupMaxPerHour).toBe(20);
    let last;
    for (let i = 0; i < 21; i += 1) last = await signup(valid({ email: `bulk${i}@test.local` }));
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/Too many signup attempts/);
    expect(await sys(User).countDocuments()).toBe(20);
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
      signupEnabled: true,
    });
    expect(JSON.stringify(res.body)).not.toContain(org.codes.ml_engineer.value);
    expect(mongoose.connection.name).toMatch(/jest/);
  });
});
