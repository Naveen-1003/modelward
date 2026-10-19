// Self-registration end to end: join code -> domain rule -> email verification -> approval -> login,
// plus every race / leak / bypass the flow has to survive.
const request = require("supertest");
const bcrypt = require("bcryptjs");
const { connect, reset, disconnect, makeUser, makeOrg, sys, auth } = require("./helpers");
const { hashToken, newToken } = require("../utils/identity");
const { formatCode } = require("../utils/joinCodes");

let app, env, User, AuditLog, Organization, rateLimit, email;

async function fresh() {
  await reset();
  await Promise.all([User.createIndexes(), AuditLog.createIndexes(), Organization.createIndexes()]);
  rateLimit.resetAll();
  email.clearOutbox();
}

beforeAll(async () => {
  await connect();
  env = require("../config/env");
  app = require("../app");
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  Organization = require("../models/Organization");
  rateLimit = require("../middleware/rateLimit");
  email = require("../utils/email");
});
afterAll(disconnect);
beforeEach(fresh);
afterEach(() => jest.restoreAllMocks());

const JOIN_DENIED = { error: "Invalid code or email not eligible" };

const api = (path, body) => request(app).post(`/api/auth/${path}`).send(body);
const code = (org, kind = "ml_engineer") => org.codes[kind].value;
const body = (org, over = {}, kind = "ml_engineer") => ({ name: "Ada", email: "ada@acme.com", joinCode: code(org, kind), ...over });
const signup = (org, over, kind) => api("signup", body(org, over, kind));
const acme = (over = {}) => makeOrg({ name: `Acme ${Date.now()}-${Math.random()}`, allowedDomains: ["acme.com"], ...over });

const dbUser = (filter) => sys(User).findOne(filter).select("+verifyTokenHash +setupTokenHash");
const dbOrg = (id) => Organization.findById(id);
const used = async (org, kind = "ml_engineer") => (await dbOrg(org._id)).codes[kind].used;
const audits = (filter) => sys(AuditLog).find(filter).sort({ seq: 1 });

const lastMail = () => email.outbox[email.outbox.length - 1];
const tokenFromMail = (mail = lastMail()) => new URL(email.extractLinks(mail.text).find((l) => l.includes("/verify-email"))).searchParams.get("token");

// Signs up and returns { res, token } (token = the verification token from the mail).
async function signedUp(org, over, kind) {
  const res = await signup(org, over, kind);
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { res, token: tokenFromMail() };
}
const verify = (token, password = "Password1!") => api("verify-email", { token, password });
const checkLink = (token) => api("verify-email/check", { token });
const login = (e, password = "Password1!") => api("login", { email: e, password });

describe("signup: the happy path and the whole lifecycle", () => {
  test("code -> verification mail -> pending (login blocked) -> approval -> login", async () => {
    const org = await acme();
    const res = await signup(org);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      message: expect.stringMatching(/verification link/i),
      status: "unverified",
      emailSent: true,
      devVerifyUrl: expect.stringMatching(/^http:\/\/localhost:5173\/verify-email\?token=[a-f0-9]{64}$/),
    });
    expect(res.body.token).toBeUndefined();

    // the account: unverified, role from the code, a seat, a hashed token valid for 7 days
    const user = await dbUser({ email: "ada@acme.com" });
    expect(user).toMatchObject({ status: "unverified", role: "ml_engineer", seatKind: "ml_engineer", seatGen: org.codes.ml_engineer.gen });
    expect(String(user.orgId)).toBe(String(org._id));
    const token = tokenFromMail();
    expect(user.verifyTokenHash).toBe(hashToken(token));
    expect(user.verifyTokenHash).not.toBe(token);
    expect(res.body.devVerifyUrl).toContain(token);
    const days = (user.verifyExpiresAt.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    expect(await used(org)).toBe(1);

    // the mail: exactly one, to the signer, naming the organization
    expect(email.outbox).toHaveLength(1);
    expect(lastMail().to).toBe("ada@acme.com");
    expect(lastMail().text).toContain(org.name);

    // unverified: nobody has a password yet, so there is nothing to sign in with
    let r = await login("ada@acme.com");
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "Invalid email or password" });

    // verify -> pending (manual approval is the default)
    r = await verify(token);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("pending");
    expect(r.body.token).toBeUndefined();
    expect((await dbUser({ email: "ada@acme.com" })).verifyTokenHash).toBeUndefined();
    r = await login("ada@acme.com");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Your account is awaiting approval from your organization's admin.", code: "ACCOUNT_PENDING" });

    // admin-style approval (the Pending list does exactly this)
    await sys(User).updateOne({ _id: user._id }, { status: "active" });
    r = await login("ada@acme.com");
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: "ada@acme.com", role: "ml_engineer", status: "active", orgName: org.name });
    expect(String(r.body.user.orgId)).toBe(String(org._id));
    const me = await auth(request(app).get("/api/auth/me"), r.body.token);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ orgName: org.name, status: "active" });

    // audit trail, in the organization, actor = the new user
    const [sign, verified] = await audits({ action: { $in: ["signup", "email_verified"] } });
    expect(sign).toMatchObject({ action: "signup", actorName: "Ada", actorRole: "ml_engineer" });
    expect(String(sign.orgId)).toBe(String(org._id));
    expect(String(sign.targetId)).toBe(String(user._id));
    expect(verified.action).toBe("email_verified");
    expect(String(verified.orgId)).toBe(String(org._id));
  });

  test("the code decides the role: ml_engineer code and compliance code; display form (dashes, lowercase) works", async () => {
    const org = await acme();
    let res = await signup(org, { email: "ml@acme.com" }, "ml_engineer");
    expect(res.status).toBe(201);
    expect((await dbUser({ email: "ml@acme.com" })).role).toBe("ml_engineer");

    res = await signup(org, { email: "co@acme.com", joinCode: formatCode(code(org, "compliance_officer")).toLowerCase() }, "compliance_officer");
    expect(res.status).toBe(201);
    const co = await dbUser({ email: "co@acme.com" });
    expect(co).toMatchObject({ role: "compliance_officer", seatKind: "compliance_officer" });
    expect(await used(org, "compliance_officer")).toBe(1);
    expect(await used(org, "ml_engineer")).toBe(1);
  });

  test("role / orgId / status / isActive / seat fields in the body can never matter", async () => {
    const org = await acme();
    const other = await makeOrg({ name: "Other Corp", allowedDomains: ["acme.com"] });
    const res = await signup(org, {
      role: "admin",
      orgId: String(other._id),
      status: "active",
      isActive: true,
      seatKind: "compliance_officer",
      seatGen: 99,
      verifyTokenHash: "x",
      passwordHash: "x",
    });
    expect(res.status).toBe(201);
    const user = await dbUser({ email: "ada@acme.com" });
    expect(user).toMatchObject({ role: "ml_engineer", status: "unverified", seatKind: "ml_engineer", seatGen: org.codes.ml_engineer.gen });
    expect(String(user.orgId)).toBe(String(org._id));
    expect(user.verifyTokenHash).not.toBe("x");
    expect(await used(other)).toBe(0);

    // the same with the other org's code but our orgId in the body: the CODE decides the org
    const res2 = await signup(other, { email: "bob@acme.com", orgId: String(org._id), role: "admin" }, "compliance_officer");
    expect(res2.status).toBe(201);
    const bob = await dbUser({ email: "bob@acme.com" });
    expect(String(bob.orgId)).toBe(String(other._id));
    expect(bob.role).toBe("compliance_officer");
  });

  test("no admin or super_admin can ever come out of signup", async () => {
    const org = await acme();
    await signup(org, { email: "a@acme.com", role: "admin" });
    await signup(org, { email: "b@acme.com", role: "super_admin" }, "compliance_officer");
    const roles = (await sys(User).find({})).map((u) => u.role).sort();
    expect(roles).toEqual(["compliance_officer", "ml_engineer"]);
  });

  test("an email failure never loses the account: 201, emailSent false, 'Resend' message", async () => {
    const org = await acme();
    const savedProvider = env.emailProvider;
    env.emailProvider = "apps_script"; // URL / secret empty in tests -> sendMail fails
    let res;
    try {
      res = await signup(org);
    } finally {
      env.emailProvider = savedProvider;
    }
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.message).toMatch(/Resend/);
    expect(res.body.devVerifyUrl).toBeUndefined(); // only with the console provider
    expect(await sys(User).countDocuments({ email: "ada@acme.com", status: "unverified" })).toBe(1);
    expect(await used(org)).toBe(1);
  });

  test("devVerifyUrl is never returned in production", async () => {
    const org = await acme();
    const saved = env.isProd;
    env.isProd = true;
    try {
      const res = await signup(org);
      expect(res.status).toBe(201);
      expect(res.body.devVerifyUrl).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/verify-email\?token/);
    } finally {
      env.isProd = saved;
    }
  });

  test("response and audit never contain the token or its hash", async () => {
    const org = await acme();
    await signup(org);
    const token = tokenFromMail();
    const rows = await audits({});
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(hashToken(token));
  });
});

describe("signup validation", () => {
  test.each([
    ["missing joinCode", { joinCode: undefined }],
    ["empty joinCode", { joinCode: "   " }],
    ["joinCode object", { joinCode: { $ne: "" } }],
    ["joinCode number", { joinCode: 123456789012 }],
    ["joinCode too long", { joinCode: "A".repeat(65) }],
    ["email operator", { email: { $gt: "" } }],
    ["bad email", { email: "not-an-email" }],
    ["trailing-dot domain", { email: "ada@acme.com." }],
    ["two @", { email: "x@evil.com@acme.com" }],
    ["empty name", { name: "  " }],
    ["name object", { name: { $gt: "" } }],
  ])("%s => 400, nothing created, no seat taken", async (_l, over) => {
    const org = await acme();
    const res = await signup(org, over);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(res.body.fields).toBeDefined();
    expect(await sys(User).countDocuments()).toBe(0);
    expect(await used(org)).toBe(0);
    expect(email.outbox).toHaveLength(0);
  });

  test("the signup form has no password: any password key (weak, object, strong) is ignored", async () => {
    const org = await acme();
    for (const [i, password] of ["x", { $ne: "" }, 12345678, "Strong1!password"].entries()) {
      const res = await signup(org, { email: `p${i}@acme.com`, password });
      expect(res.status).toBe(201);
      expect(res.body.token).toBeUndefined();
    }
  });

  test("empty body => 400", async () => {
    expect((await api("signup", {})).status).toBe(400);
  });
});

describe("generic 403 for every code / domain / expiry / seat / suspension failure", () => {
  test("all failures answer byte-identical bodies and are audited without the code", async () => {
    const org = await acme();
    const expired = await acme({ name: "Expired Co" });
    await Organization.updateOne({ _id: expired._id }, { "codes.ml_engineer.expiresAt": new Date(Date.now() - 1000) });
    const full = await acme({ name: "Full Co" });
    await Organization.updateOne({ _id: full._id }, { "codes.ml_engineer.seatLimit": 1, "codes.ml_engineer.used": 1 });
    const suspended = await acme({ name: "Suspended Co", status: "suspended" });
    const regen = await acme({ name: "Regen Co" });
    const oldCode = code(regen);
    const { newCodeEntry } = require("../utils/joinCodes");
    await Organization.updateOne({ _id: regen._id }, { "codes.ml_engineer": newCodeEntry(regen.codes.ml_engineer) });
    const [freshExpired, freshFull, freshSuspended] = await Promise.all([expired, full, suspended].map((o) => dbOrg(o._id)));

    const cases = [
      ["unknown_code", "ABCDEFGHJKLM", org, null],
      ["unknown_code", "not a code at all", org, null],
      ["unknown_code", oldCode, regen, null], // regenerated: the old value is gone
      ["expired", code(freshExpired), expired, expired._id],
      ["full", code(freshFull), full, full._id],
      ["suspended", code(freshSuspended), suspended, suspended._id],
      ["domain_not_allowed", code(org), org, org._id, { email: "ada@evil.com" }],
    ];
    const seen = [];
    for (const [reason, joinCode, , orgId, over] of cases) {
      const res = await api("signup", { name: "Ada", email: "ada@acme.com", joinCode, ...over });
      expect(res.status).toBe(403);
      expect(res.body).toEqual(JOIN_DENIED);
      seen.push(res.text);
      // the audit row: reason + IP, org only when known, never the submitted code
      const row = (await audits({ action: "join_code_failed" })).pop();
      expect(row.details).toContain(`(${reason})`);
      expect(row.details).toMatch(/ip=\S+/);
      expect(row.details).not.toContain(String(joinCode));
      expect(row.actorName).toBe("anonymous");
      if (orgId) expect(String(row.orgId)).toBe(String(orgId));
      else expect(row.orgId == null).toBe(true);
    }
    expect(new Set(seen).size).toBe(1);
    expect(await sys(User).countDocuments()).toBe(0);
    expect(email.outbox).toHaveLength(0);
    expect(await audits({ action: "join_code_failed" })).toHaveLength(cases.length);
  });

  test("expiry takes effect at once; clearing it re-opens the code; limit raised re-opens a full code", async () => {
    const org = await acme();
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer.expiresAt": new Date(Date.now() - 1) });
    expect((await signup(org)).status).toBe(403);
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer.expiresAt": new Date(Date.now() + 60000) });
    expect((await signup(org)).status).toBe(201);
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer.seatLimit": 1 });
    expect((await signup(org, { email: "b@acme.com" })).status).toBe(403);
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer.seatLimit": 5 });
    expect((await signup(org, { email: "b@acme.com" })).status).toBe(201);
  });

  test("a suspended organization's code stops working even when otherwise valid", async () => {
    const org = await acme();
    await Organization.updateOne({ _id: org._id }, { status: "suspended" });
    const res = await signup(org);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(JOIN_DENIED);
  });
});

describe("domain rule: exact match only", () => {
  test.each([
    ["suffix attack", "ada@acme.com.evil.com"],
    ["subdomain", "ada@mail.acme.com"],
    ["prefix attack", "ada@notacme.com"],
    ["other domain", "ada@evil.com"],
    ["domain in the local part", "acme.com@evil.com"],
    ["lookalike", "ada@acme.co"],
  ])("%s (%s) is refused with the generic 403", async (_l, address) => {
    const org = await acme();
    const res = await signup(org, { email: address });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(JOIN_DENIED);
    expect(await sys(User).countDocuments()).toBe(0);
    expect(await used(org)).toBe(0);
  });

  test("upper-case domain and +tag are the same domain (accepted, stored lowercase); trailing dot is refused", async () => {
    const org = await acme();
    let res = await signup(org, { email: "  ADA@ACME.COM " });
    expect(res.status).toBe(201);
    expect((await dbUser({ email: "ada@acme.com" })).status).toBe("unverified");
    res = await signup(org, { email: "bob@acme.com." });
    expect(res.status).toBe(400);
    expect(await sys(User).countDocuments()).toBe(1);
  });

  test("listed subdomains work only when listed", async () => {
    const org = await makeOrg({ allowedDomains: ["acme.com", "mail.acme.com"] });
    expect((await signup(org, { email: "a@mail.acme.com" })).status).toBe(201);
    expect((await signup(org, { email: "b@deep.mail.acme.com" })).status).toBe(403);
  });

  test("domain rule off: any address may sign up (free-mail included), still unverified first", async () => {
    const org = await makeOrg({ domainRuleEnabled: false, allowedDomains: [] });
    const res = await signup(org, { email: "someone@gmail.com" });
    expect(res.status).toBe(201);
    expect((await dbUser({ email: "someone@gmail.com" })).status).toBe("unverified");
  });

  test("free-mail with the rule off needs manual approval even when autoApprove is (wrongly) true", async () => {
    const org = await makeOrg({ domainRuleEnabled: false, allowedDomains: [], autoApprove: true });
    const { token } = await signedUp(org, { email: "someone@gmail.com" });
    const r = await verify(token);
    expect(r.body.status).toBe("pending");
    expect((await dbUser({ email: "someone@gmail.com" })).status).toBe("pending");
    expect((await login("someone@gmail.com")).body.code).toBe("ACCOUNT_PENDING");
    expect(await audits({ action: "user_approve" })).toHaveLength(0);
  });

  test("autoApprove with the rule on: verification activates at once (audited); login works", async () => {
    const org = await acme({ autoApprove: true });
    const { token } = await signedUp(org);
    const r = await verify(token);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("active");
    expect(r.body.message).toMatch(/sign in/i);
    expect((await login("ada@acme.com")).status).toBe(200);
    const approve = (await audits({ action: "user_approve" }))[0];
    expect(approve.details).toBe("auto-approved");
    expect(String(approve.orgId)).toBe(String(org._id));
    expect(await audits({ action: "email_verified" })).toHaveLength(1);
  });

  test("autoApprove is re-checked at verification time: rule/domain/suspension changes since signup => pending", async () => {
    // domain removed from the list after signup
    let org = await acme({ autoApprove: true });
    let { token } = await signedUp(org);
    await Organization.updateOne({ _id: org._id }, { allowedDomains: ["other.com"] });
    expect((await verify(token)).body.status).toBe("pending");

    // rule switched off (admin edit forces autoApprove off, here only the rule flips)
    org = await acme({ autoApprove: true });
    ({ token } = await signedUp(org, { email: "b@acme.com" }));
    await Organization.updateOne({ _id: org._id }, { domainRuleEnabled: false });
    expect((await verify(token)).body.status).toBe("pending");

    // organization suspended in between
    org = await acme({ autoApprove: true });
    ({ token } = await signedUp(org, { email: "c@acme.com" }));
    await Organization.updateOne({ _id: org._id }, { status: "suspended" });
    expect((await verify(token)).body.status).toBe("pending");
    expect(await audits({ action: "user_approve" })).toHaveLength(0);
  });
});

describe("seats: reserved atomically, released on every failure", () => {
  test("a seat limit is enforced and a failed signup never consumes a seat", async () => {
    const org = await acme();
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer.seatLimit": 2 });
    expect((await signup(org, { email: "a@acme.com" })).status).toBe(201);
    expect((await signup(org, { email: "bad@evil.com" })).status).toBe(403); // domain failure
    expect((await signup(org, { email: "b@acme.com", name: "  " })).status).toBe(400); // validation failure
    expect(await used(org)).toBe(1);
    expect((await signup(org, { email: "b@acme.com" })).status).toBe(201);
    expect(await used(org)).toBe(2);
    const res = await signup(org, { email: "c@acme.com" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(JOIN_DENIED);
    expect(await used(org)).toBe(2);
    expect(await sys(User).countDocuments()).toBe(2);
  });

  test("each code kind counts its own seats", async () => {
    const org = await acme();
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer.seatLimit": 1 });
    expect((await signup(org, { email: "a@acme.com" })).status).toBe(201);
    expect((await signup(org, { email: "b@acme.com" })).status).toBe(403);
    expect((await signup(org, { email: "c@acme.com" }, "compliance_officer")).status).toBe(201);
  });

  test("concurrent signups for the last seat: exactly one wins", async () => {
    const org = await acme();
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer.seatLimit": 1 });
    const results = await Promise.all(["a", "b", "c", "d"].map((n) => signup(org, { email: `${n}@acme.com` })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
    expect(await used(org)).toBe(1);
    expect(await sys(User).countDocuments()).toBe(1);
  });

  test("duplicate-email race (Promise.all): one account, one seat, no server errors", async () => {
    const org = await acme();
    const results = await Promise.all(Array.from({ length: 4 }, () => signup(org)));
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(await sys(User).countDocuments()).toBe(1);
    expect(await used(org)).toBe(1);
  });

  test("User.create failing with a duplicate key (race) => 409 and the seat is released", async () => {
    const org = await acme();
    jest.spyOn(User, "create").mockRejectedValueOnce(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }));
    const res = await signup(org);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("An account with that email already exists");
    expect(await used(org)).toBe(0);
    expect(email.outbox).toHaveLength(0);
  });

  test("User.create failing for any other reason => 500 and the seat is released", async () => {
    const org = await acme();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(User, "create").mockRejectedValueOnce(new Error("boom"));
    const res = await signup(org);
    expect(res.status).toBe(500);
    expect(await used(org)).toBe(0);
    expect(await sys(User).countDocuments()).toBe(0);
    // and the next attempt is fine
    expect((await signup(org)).status).toBe(201);
    expect(await used(org)).toBe(1);
  });

  test("a regenerated code does not get decremented by the old account's later release", async () => {
    const org = await acme();
    await signup(org);
    const { newCodeEntry } = require("../utils/joinCodes");
    const fresh1 = await dbOrg(org._id);
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer": newCodeEntry(fresh1.codes.ml_engineer) });
    const regen = await dbOrg(org._id);
    expect((await signup(regen, { email: "b@acme.com" })).status).toBe(201);
    // ada (old generation) signs up again: replaced; her old seat belongs to a dead generation, so
    // the new generation's count (bob's seat, and now ada's new one) is what remains
    expect((await signup(regen, { email: "ada@acme.com" })).status).toBe(201);
    expect(await used(regen)).toBe(2);
  });
});

describe("an unverified signup is replaced; anything else blocks", () => {
  test("second signup for the same address replaces the unverified one (seat freed first, old link dead)", async () => {
    const org = await acme();
    const first = await signedUp(org);
    const second = await signedUp(org, { name: "Ada Two" });
    expect(second.token).not.toBe(first.token);
    expect(await sys(User).countDocuments()).toBe(1);
    expect(await used(org)).toBe(1);
    expect((await verify(first.token, "FirstPass1!")).status).toBe(400);
    expect((await verify(second.token, "SecondPass1!")).status).toBe(200);
    const user = await dbUser({ email: "ada@acme.com" });
    expect(user.name).toBe("Ada Two");
    expect(await bcrypt.compare("SecondPass1!", user.passwordHash)).toBe(true);
    expect(await bcrypt.compare("FirstPass1!", user.passwordHash)).toBe(false);
    expect((await audits({ action: "signup" })).pop().details).toMatch(/replaced an unverified signup/);
  });

  test("replacement works when the last seat is held by that very signup", async () => {
    const org = await acme();
    await Organization.updateOne({ _id: org._id }, { "codes.ml_engineer.seatLimit": 1 });
    await signedUp(org);
    expect((await signup(org)).status).toBe(201); // same person again: not "full"
    expect(await used(org)).toBe(1);
    expect((await signup(org, { email: "other@acme.com" })).status).toBe(403); // someone else: full
  });

  test("replacing an unverified signup of another organization frees that organization's seat", async () => {
    const a = await makeOrg({ name: "A Corp", domainRuleEnabled: false, allowedDomains: [] });
    const b = await makeOrg({ name: "B Corp", domainRuleEnabled: false, allowedDomains: [] });
    await signedUp(a, { email: "x@gmail.com" });
    expect(await used(a)).toBe(1);
    await signedUp(b, { email: "x@gmail.com" });
    expect(await used(a)).toBe(0);
    expect(await used(b)).toBe(1);
    expect(String((await dbUser({ email: "x@gmail.com" })).orgId)).toBe(String(b._id));
  });

  test.each(["pending", "active", "invited"])("an existing %s account => 409 and it is left untouched", async (status) => {
    const org = await acme();
    const { user } = await makeUser("ml_engineer", { orgId: org._id, email: "ada@acme.com", status });
    const res = await signup(org);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "An account with that email already exists" });
    const after = await dbUser({ _id: user._id });
    expect(after.status).toBe(status);
    expect(await bcrypt.compare("Password1!", after.passwordHash)).toBe(true);
    expect(await used(org)).toBe(0);
  });

  test("replacement is conditioned on still being unverified (a verification that lands first wins)", async () => {
    const org = await acme();
    await signedUp(org);
    const stale = await sys(User).find({ email: "ada@acme.com" });
    await sys(User).updateOne({ email: "ada@acme.com" }, { status: "pending", passwordHash: await bcrypt.hash("Password1!", 4) }); // verified in the meantime
    // the signup handler read `stale` (still unverified) before the update landed
    jest.spyOn(User, "find").mockReturnValueOnce({ setOptions: () => ({ limit: () => Promise.resolve(stale) }) });
    const res = await signup(org);
    expect(res.status).toBe(409);
    const user = await dbUser({ email: "ada@acme.com" });
    expect(user.status).toBe("pending");
    expect(await bcrypt.compare("Password1!", user.passwordHash)).toBe(true);
    expect(await used(org)).toBe(1);
  });

  test("+tag and case variants are one account: second signup against a verified one => 409", async () => {
    const org = await acme();
    const { token } = await signedUp(org, { email: "a+x@acme.com" });
    expect((await verify(token)).status).toBe(200);
    for (const variant of ["A@acme.com", "a+other@ACME.com", "a@acme.com"]) {
      const res = await signup(org, { email: variant });
      expect(res.status).toBe(409);
    }
    expect(await sys(User).countDocuments()).toBe(1);
    expect((await dbUser({})).emailKey).toBe("a@acme.com");
  });

  test("and against an unverified one the variant replaces it (still one account)", async () => {
    const org = await acme();
    await signedUp(org, { email: "a+x@acme.com" });
    const res = await signup(org, { email: "A@acme.com" });
    expect(res.status).toBe(201);
    expect(await sys(User).countDocuments()).toBe(1);
    expect(await used(org)).toBe(1);
  });

  test("a plain address blocks its +tag twin created by an admin", async () => {
    const org = await acme();
    await makeUser("ml_engineer", { orgId: org._id, email: "pat@acme.com" });
    expect((await signup(org, { email: "pat+hr@acme.com" })).status).toBe(409);
  });
});

describe("the password is chosen by the mailbox owner (verify-email), never at signup", () => {
  test("an attacker-chosen password at signup can never sign in: not before, not after verification, not after approval", async () => {
    const org = await acme();
    const attacker = "Attacker1!pw";
    expect((await signup(org, { password: attacker })).status).toBe(201);
    const token = tokenFromMail();
    const stored = await dbUser({ email: "ada@acme.com" });
    expect(await bcrypt.compare(attacker, stored.passwordHash)).toBe(false);
    expect((await login("ada@acme.com", attacker)).status).toBe(401);

    // the real owner opens the link and chooses a password
    expect((await verify(token, "Owner1!password")).status).toBe(200);
    expect((await login("ada@acme.com", attacker)).status).toBe(401);
    expect((await login("ada@acme.com", "Owner1!password")).body.code).toBe("ACCOUNT_PENDING");
    await sys(User).updateOne({ email: "ada@acme.com" }, { status: "active" });
    expect((await login("ada@acme.com", attacker)).status).toBe(401);
    expect((await login("ada@acme.com", "Owner1!password")).status).toBe(200);
  });

  test("unusable hashes are random per signup", async () => {
    const org = await acme();
    await signup(org, { email: "a@acme.com" });
    await signup(org, { email: "b@acme.com" });
    const [a, b] = await sys(User).find({}).sort({ email: 1 });
    expect(a.passwordHash).not.toBe(b.passwordHash);
  });

  test("a weak password is refused with fields and the link stays usable; then a good one works once", async () => {
    const org = await acme();
    const { token } = await signedUp(org);
    for (const pw of ["short", "x".repeat(129), "é".repeat(37), { $ne: "" }, 12345678, null]) {
      const r = await api("verify-email", { token, password: pw });
      expect(r.status).toBe(400);
      expect(r.body.fields.password).toEqual(expect.any(String));
    }
    expect((await api("verify-email", { token })).status).toBe(400); // missing password
    expect((await dbUser({ email: "ada@acme.com" })).status).toBe("unverified");
    expect((await checkLink(token)).status).toBe(200);
    const ok = await verify(token, "é".repeat(36)); // exactly 72 bytes
    expect(ok.status).toBe(200);
    expect((await verify(token, "Another1!pw")).status).toBe(400);
  });

  test("verification sets a working password; the response never carries a login token (auto-approve included)", async () => {
    for (const autoApprove of [false, true]) {
      const org = await acme({ autoApprove });
      const email_ = `u${autoApprove}@acme.com`;
      const { token } = await signedUp(org, { email: email_ });
      const r = await verify(token, "ChosenBy1!owner");
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["message", "status"]);
      expect(r.body.status).toBe(autoApprove ? "active" : "pending");
      expect(await bcrypt.compare("ChosenBy1!owner", (await dbUser({ email: email_ })).passwordHash)).toBe(true);
      const l = await login(email_, "ChosenBy1!owner");
      expect(l.status).toBe(autoApprove ? 200 : 403);
    }
  });

  test("simultaneous verifications with different passwords: one wins and only its password works", async () => {
    const org = await acme({ autoApprove: true });
    const { token } = await signedUp(org);
    const pws = ["FirstTry1!pass", "SecondTry1!pass", "ThirdTry1!pass"];
    const rs = await Promise.all(pws.map((p) => verify(token, p)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    const winner = pws[rs.findIndex((r) => r.status === 200)];
    expect((await login("ada@acme.com", winner)).status).toBe(200);
    for (const p of pws.filter((x) => x !== winner)) expect((await login("ada@acme.com", p)).status).toBe(401);
  });

  test("verify-email/check shows who is verifying without changing anything", async () => {
    const org = await acme();
    const { token } = await signedUp(org, { name: "Ada Lovelace" });
    const before = await dbUser({ email: "ada@acme.com" });
    for (let i = 0; i < 3; i += 1) {
      const r = await checkLink(token);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ valid: true, name: "Ada Lovelace", email: "ada@acme.com", orgName: org.name });
    }
    const after = await dbUser({ email: "ada@acme.com" });
    expect(after.status).toBe("unverified");
    expect(after.verifyTokenHash).toBe(before.verifyTokenHash);
    expect(await audits({ action: "email_verified" })).toHaveLength(0);
    expect(JSON.stringify((await checkLink(token)).body)).not.toMatch(/Hash|token/);
  });

  test("verify-email/check: unknown, used, expired, replaced, wrong-kind and malformed tokens => the same 400", async () => {
    const org = await acme();
    const first = await signedUp(org);
    const second = await signedUp(org); // replaces the first
    const expected = { error: "This verification link is invalid or has expired" };
    for (const t of ["0".repeat(64), first.token, "", { $ne: "" }, ["a"], 5]) {
      const r = await checkLink(t);
      expect(r.status).toBe(400);
      if (typeof t === "string" && t) expect(r.body).toEqual(expected);
    }
    await sys(User).updateOne({ email: "ada@acme.com" }, { verifyExpiresAt: new Date(Date.now() - 1000) });
    expect((await checkLink(second.token)).body).toEqual(expected);
    await sys(User).updateOne({ email: "ada@acme.com" }, { verifyExpiresAt: new Date(Date.now() + 60000) });
    expect((await verify(second.token)).status).toBe(200);
    expect((await checkLink(second.token)).body).toEqual(expected); // used
    // a setup token is not a verification token
    const s = newToken();
    await makeUser("ml_engineer", { orgId: org._id, status: "invited", extra: { setupTokenHash: s.hash, setupExpiresAt: new Date(Date.now() + 3600000) } });
    expect((await checkLink(s.token)).status).toBe(400);
  });

  test("the check endpoint shares the link limiter (cannot be used to guess tokens)", async () => {
    const results = [];
    for (let i = 0; i < 31; i += 1) results.push((await checkLink(`guess-${i}`)).status);
    expect(results[30]).toBe(429);
  });

  test("the verification mail asks to confirm the email and choose a password", async () => {
    const org = await acme();
    await signup(org);
    expect(lastMail().text).toMatch(/Confirm your email and choose your password/);
    expect(lastMail().html).toMatch(/Confirm your email and choose your password/);
  });
});

describe("verify-email", () => {
  test("a second click fails: the link works once", async () => {
    const org = await acme();
    const { token } = await signedUp(org);
    expect((await verify(token)).status).toBe(200);
    const again = await verify(token);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: "This verification link is invalid or has expired" });
    expect(await audits({ action: "email_verified" })).toHaveLength(1);
  });

  test("two simultaneous clicks: exactly one succeeds, one audit entry", async () => {
    const org = await acme({ autoApprove: true });
    const { token } = await signedUp(org);
    const rs = await Promise.all([verify(token), verify(token), verify(token)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect(await audits({ action: "email_verified" })).toHaveLength(1);
    expect(await audits({ action: "user_approve" })).toHaveLength(1);
  });

  test("an expired link fails and leaves the account unverified", async () => {
    const org = await acme();
    const { token } = await signedUp(org);
    await sys(User).updateOne({ email: "ada@acme.com" }, { verifyExpiresAt: new Date(Date.now() - 1000) });
    const r = await verify(token);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("This verification link is invalid or has expired");
    expect((await dbUser({ email: "ada@acme.com" })).status).toBe("unverified");
  });

  test.each([
    ["unknown token", { token: "0".repeat(64) }],
    ["the hash instead of the token", null],
    ["empty string", { token: "" }],
    ["missing", {}],
    ["object", { token: { $ne: "" } }],
    ["array", { token: ["a"] }],
    ["number", { token: 5 }],
    ["too long", { token: "a".repeat(201) }],
  ])("%s => 400", async (_l, payload) => {
    const org = await acme();
    await signedUp(org);
    const hash = (await dbUser({ email: "ada@acme.com" })).verifyTokenHash;
    const res = await api("verify-email", { password: "Password1!", ...(payload === null ? { token: hash } : payload) });
    expect(res.status).toBe(400);
    expect((await dbUser({ email: "ada@acme.com" })).status).toBe("unverified");
  });

  test("a setup token cannot verify, a verify token cannot set a password", async () => {
    const org = await acme();
    const { token } = await signedUp(org);
    expect((await api("setup-password", { token, password: "Password1!" })).status).toBe(400);
    const s = newToken();
    await makeUser("ml_engineer", { orgId: org._id, status: "invited", extra: { setupTokenHash: s.hash, setupExpiresAt: new Date(Date.now() + 3600000) } });
    expect((await verify(s.token)).status).toBe(400);
  });

  test("a pending or active account's leftovers cannot be re-verified into a different status", async () => {
    const org = await acme();
    const { token } = await signedUp(org);
    await sys(User).updateOne({ email: "ada@acme.com" }, { status: "pending" }); // still holding its hash
    expect((await verify(token)).status).toBe(400);
    expect((await dbUser({ email: "ada@acme.com" })).status).toBe("pending");
  });

  test("the verify-link limiter caps guessing", async () => {
    const results = [];
    for (let i = 0; i < 31; i += 1) results.push((await verify(`guess-${i}`)).status);
    expect(results.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(results[30]).toBe(429);
  });
});

describe("resend-verification", () => {
  const resend = (e) => api("resend-verification", { email: e });
  const GENERIC = { message: "If that address is waiting for verification, a new link has been sent" };

  test("unverified: new link by mail, old one dead, same expiry; answer identical to unknown/active addresses", async () => {
    const org = await acme();
    const { token: oldToken } = await signedUp(org);
    const before = (await dbUser({ email: "ada@acme.com" })).verifyExpiresAt;
    email.clearOutbox();

    const real = await resend("ada@acme.com");
    const unknown = await resend("ghost@acme.com");
    expect(real.status).toBe(200);
    expect(real.body).toEqual(GENERIC);
    expect(unknown.body).toEqual(GENERIC);
    expect(real.text).toBe(unknown.text);

    expect(email.outbox).toHaveLength(1);
    expect(email.outbox[0].to).toBe("ada@acme.com");
    const newToken_ = tokenFromMail();
    expect(newToken_).not.toBe(oldToken);
    expect((await dbUser({ email: "ada@acme.com" })).verifyExpiresAt.getTime()).toBe(before.getTime());
    expect((await verify(oldToken)).status).toBe(400);
    expect((await verify(newToken_)).status).toBe(200);
  });

  test("+tag / case variants reach the same waiting account", async () => {
    const org = await acme();
    await signedUp(org, { email: "ada@acme.com" });
    email.clearOutbox();
    expect((await resend("ADA+news@Acme.com")).status).toBe(200);
    expect(email.outbox).toHaveLength(1);
    expect(email.outbox[0].to).toBe("ada@acme.com");
  });

  test("pending, active, invited, unknown and expired accounts get the same answer and no mail", async () => {
    const org = await acme();
    for (const status of ["pending", "active", "invited"]) {
      await makeUser("ml_engineer", { orgId: org._id, email: `${status}@acme.com`, status });
    }
    await signedUp(org, { email: "old@acme.com" });
    await sys(User).updateOne({ email: "old@acme.com" }, { verifyExpiresAt: new Date(Date.now() - 1000) });
    email.clearOutbox();
    for (const e of ["pending@acme.com", "active@acme.com", "invited@acme.com", "nobody@acme.com", "old@acme.com"]) {
      const r = await resend(e);
      expect(r.status).toBe(200);
      expect(r.body).toEqual(GENERIC);
    }
    expect(email.outbox).toHaveLength(0);
  });

  test("rate limited per IP / per email (RESEND_VERIFY_MAX per hour), always generic until then", async () => {
    expect(env.resendVerifyMax).toBe(5);
    for (let i = 0; i < 5; i += 1) expect((await resend("ada@acme.com")).status).toBe(200);
    const blocked = await resend("ada@acme.com");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/^Too many verification email requests\. Try again in \d+ minutes?$/);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  test.each([
    ["object", { email: { $gt: "" } }],
    ["missing", {}],
    ["number", { email: 5 }],
  ])("%s => 400", async (_l, payload) => {
    expect((await api("resend-verification", payload)).status).toBe(400);
  });
});

describe("setup-password (accounts created by an admin)", () => {
  async function invited(org, over = {}) {
    const t = newToken();
    const made = await makeUser("compliance_officer", {
      orgId: org._id,
      email: over.email || "new.hire@acme.com",
      name: "New Hire",
      status: "invited",
      extra: {
        passwordHash: "!unusable-random-hash!",
        setupTokenHash: t.hash,
        setupExpiresAt: over.expiresAt || new Date(Date.now() + 72 * 3600000),
        ...(over.extra || {}),
      },
    });
    return { ...made, setupToken: t.token };
  }
  const check = (token) => api("setup-password/check", { token });
  const setup = (token, pw = "BrandNew1!pw") => api("setup-password", { token, password: pw });

  test("check -> set -> signed in; the link works once; fields cleared; audited", async () => {
    const org = await acme();
    const { user, setupToken } = await invited(org);

    let r = await check(setupToken);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ valid: true, name: "New Hire", email: "new.hire@acme.com", orgName: org.name });

    // an invited account cannot log in with anything
    r = await login("new.hire@acme.com", "BrandNew1!pw");
    expect(r.status).toBe(401);

    r = await setup(setupToken);
    expect(r.status).toBe(200);
    expect(r.body.token).toEqual(expect.any(String));
    expect(r.body.user).toMatchObject({ email: "new.hire@acme.com", role: "compliance_officer", status: "active", orgName: org.name });
    expect(JSON.stringify(r.body)).not.toMatch(/setupTokenHash|passwordHash/);
    expect((await auth(request(app).get("/api/auth/me"), r.body.token)).status).toBe(200);

    const after = await dbUser({ _id: user._id });
    expect(after.status).toBe("active");
    expect(after.setupTokenHash).toBeUndefined();
    expect(after.setupExpiresAt).toBeUndefined();
    expect(await bcrypt.compare("BrandNew1!pw", after.passwordHash)).toBe(true);
    const row = (await audits({ action: "password_setup" }))[0];
    expect(row).toMatchObject({ actorName: "New Hire", actorRole: "compliance_officer" });
    expect(String(row.orgId)).toBe(String(org._id));

    // reuse
    expect((await check(setupToken)).status).toBe(400);
    expect((await setup(setupToken, "Another1!pw")).status).toBe(400);
    expect((await login("new.hire@acme.com")).status).toBe(401);
    expect((await login("new.hire@acme.com", "BrandNew1!pw")).status).toBe(200);
  });

  test("expired link: check and set both 400; account stays invited", async () => {
    const org = await acme();
    const { user, setupToken } = await invited(org, { expiresAt: new Date(Date.now() - 1000) });
    for (const r of [await check(setupToken), await setup(setupToken)]) {
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "This setup link is invalid or has expired" });
    }
    expect((await dbUser({ _id: user._id })).status).toBe("invited");
  });

  test("password rules are the signup rules; a rejected password does not use up the link", async () => {
    const org = await acme();
    const { setupToken } = await invited(org);
    for (const pw of ["short", "x".repeat(129), "é".repeat(37), { $ne: "" }, 12345678, null]) {
      const r = await setup(setupToken, pw);
      expect(r.status).toBe(400);
    }
    expect((await setup(setupToken, "é".repeat(36))).status).toBe(200); // exactly 72 bytes
  });

  test("unknown / garbage / wrong-kind tokens => 400", async () => {
    const org = await acme();
    const { token } = await signedUp(org); // a verification token
    await invited(org);
    for (const t of ["0".repeat(64), token, "", { $ne: "" }, 5]) {
      expect((await check(t)).status).toBe(400);
      expect((await setup(t)).status).toBe(400);
    }
  });

  test("two simultaneous submissions: exactly one wins", async () => {
    const org = await acme();
    const { user, setupToken } = await invited(org);
    const rs = await Promise.all([setup(setupToken, "FirstWins1!pw"), setup(setupToken, "SecondWins1!pw"), setup(setupToken, "ThirdWins1!pw")]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect(await audits({ action: "password_setup" })).toHaveLength(1);
    expect((await dbUser({ _id: user._id })).status).toBe("active");
  });

  test("a deactivated account or a suspended organization cannot be activated through a link", async () => {
    const org = await acme();
    const off = await invited(org, { email: "off@acme.com", extra: { isActive: false } });
    let r = await setup(off.setupToken);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ACCOUNT_DEACTIVATED");
    expect((await check(off.setupToken)).status).toBe(403);
    expect((await dbUser({ _id: off.user._id })).status).toBe("invited");

    const sus = await acme({ status: "suspended" });
    const inSus = await invited(sus, { email: "x@acme.com" });
    r = await setup(inSus.setupToken);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Your organization is suspended.", code: "ORG_SUSPENDED" });
    expect((await dbUser({ _id: inSus.user._id })).status).toBe("invited");
  });

  test("an already active account's leftover token does nothing", async () => {
    const org = await acme();
    const { user, setupToken } = await invited(org, { extra: { status: "active", passwordHash: await bcrypt.hash("Password1!", 4) } });
    expect((await setup(setupToken, "Hijack1!pass")).status).toBe(400);
    expect(await bcrypt.compare("Password1!", (await dbUser({ _id: user._id })).passwordHash)).toBe(true);
  });

  test("the setup limiter caps guessing", async () => {
    const results = [];
    for (let i = 0; i < 31; i += 1) results.push((await check(`guess-${i}`)).status);
    expect(results[30]).toBe(429);
  });
});

describe("login per account status", () => {
  const cases = [
    ["isActive false", { extra: { isActive: false } }, 403, { error: "Account is deactivated", code: "ACCOUNT_DEACTIVATED" }],
    ["unverified", { status: "unverified" }, 403, { error: "Verify your email first. Check your inbox for the link.", code: "EMAIL_UNVERIFIED" }],
    ["pending", { status: "pending" }, 403, { error: "Your account is awaiting approval from your organization's admin.", code: "ACCOUNT_PENDING" }],
  ];
  test.each(cases)("%s: right password => 403 with its code; wrong password => the plain 401", async (_l, over, status, expected) => {
    await makeUser("ml_engineer", { email: "u@test.local", ...over });
    let r = await login("u@test.local");
    expect(r.status).toBe(status);
    expect(r.body).toEqual(expected);
    r = await login("u@test.local", "wrong-password");
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "Invalid email or password" });
  });

  test("suspended organization: ORG_SUSPENDED (after the password); wrong password stays 401", async () => {
    const org = await makeOrg({ status: "suspended" });
    await makeUser("admin", { orgId: org._id, email: "s@test.local" });
    let r = await login("s@test.local");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "Your organization is suspended.", code: "ORG_SUSPENDED" });
    expect((await login("s@test.local", "wrong-password")).status).toBe(401);
  });

  test("blocked logins are audited with the user's org; unknown emails with none", async () => {
    const org = await makeOrg({ name: "Audit Org" });
    const { user } = await makeUser("ml_engineer", { orgId: org._id, email: "p@test.local", status: "pending" });
    await login("p@test.local");
    await login("p@test.local", "wrong-password");
    await login("ghost@test.local");
    const rows = await audits({ action: "login_failed" });
    expect(rows).toHaveLength(3);
    expect(rows[0].details).toContain("ACCOUNT_PENDING");
    expect(String(rows[0].orgId)).toBe(String(org._id));
    expect(String(rows[0].targetId)).toBe(String(user._id));
    expect(String(rows[1].orgId)).toBe(String(org._id));
    expect(rows[2].orgId == null).toBe(true);
  });

  test("invited accounts fail like unknown ones", async () => {
    const org = await acme();
    await makeUser("ml_engineer", { orgId: org._id, email: "inv@acme.com", status: "invited", extra: { passwordHash: "!unusable!" } });
    const a = await login("inv@acme.com", "Password1!");
    const b = await login("nobody@acme.com", "Password1!");
    expect(a.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  test("+tag and case variants sign in to the one account; org admin gets orgName", async () => {
    const org = await acme();
    await makeUser("admin", { orgId: org._id, email: "boss@acme.com" });
    for (const v of ["boss@acme.com", "BOSS@acme.com", "boss+anything@ACME.com"]) {
      const r = await login(v);
      expect(r.status).toBe(200);
      expect(r.body.user).toMatchObject({ email: "boss@acme.com", role: "admin", orgName: org.name, status: "active" });
    }
  });

  test("super admin: signs in without an organization (orgName null, audited platform-level)", async () => {
    const sa = await makeUser("super_admin", { email: "root@test.local" });
    const r = await login("root@test.local");
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ role: "super_admin", orgId: null, orgName: null });
    const row = (await audits({ action: "login", actorId: sa.user._id }))[0];
    expect(row.orgId == null).toBe(true);
    const me = await auth(request(app).get("/api/auth/me"), r.body.token); // platform guard: no org needed
    expect(me.status).toBe(200);
    expect(me.body.user.orgName).toBeNull();
  });

  test("login response never contains token hashes or the password hash", async () => {
    await makeUser("ml_engineer", { email: "u@test.local" });
    const r = await login("u@test.local");
    expect(JSON.stringify(r.body.user)).not.toMatch(/Hash|seat/);
  });
});

describe("self-registration switched off", () => {
  afterEach(() => {
    env.signupEnabled = true;
  });

  test("503 SIGNUP_DISABLED before anything else: no validation, no audit, no counters, no mail", async () => {
    const org = await acme();
    env.signupEnabled = false;
    const expected = { error: "Self-registration is currently unavailable", code: "SIGNUP_DISABLED" };
    for (const payload of [body(org), {}, { joinCode: "WRONG" }]) {
      const res = await api("signup", payload);
      expect(res.status).toBe(503);
      expect(res.body).toEqual(expected);
    }
    expect(await sys(User).countDocuments()).toBe(0);
    expect(await sys(AuditLog).countDocuments({ action: { $in: ["signup", "join_code_failed"] } })).toBe(0);
    expect(await used(org)).toBe(0);
    expect(email.outbox).toHaveLength(0);

    // the budget was not consumed: back on, a full set of attempts still works
    env.signupEnabled = true;
    expect((await signup(org)).status).toBe(201);
  });

  test("the production + console combination computes signupEnabled=false; apps_script keeps it on", () => {
    const load = (vars) => {
      const keys = Object.keys(vars);
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      Object.assign(process.env, vars);
      let fresh;
      try {
        jest.isolateModules(() => {
          fresh = require("../config/env");
        });
      } finally {
        keys.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
      }
      return fresh;
    };
    expect(load({ NODE_ENV: "production", EMAIL_PROVIDER: "console" }).signupEnabled).toBe(false);
    expect(load({ NODE_ENV: "production", EMAIL_PROVIDER: "apps_script" }).signupEnabled).toBe(true);
    expect(load({ NODE_ENV: "development", EMAIL_PROVIDER: "console" }).signupEnabled).toBe(true);
  });

  test("GET /api/config exposes signupEnabled and no role-code hint", async () => {
    let res = await request(app).get("/api/config");
    expect(res.body.signupEnabled).toBe(true);
    expect(res.body.signupRolesRequiringCode).toBeUndefined();
    env.signupEnabled = false;
    res = await request(app).get("/api/config");
    expect(res.body.signupEnabled).toBe(false);
  });
});

describe("join-code guessing is rate limited per IP", () => {
  test("failed attempts count, successes do not; the 11th failure is a 429 even with a valid code", async () => {
    expect(env.joinCodeMaxFailures).toBe(10);
    const org = await acme();
    expect((await signup(org, { email: "a@acme.com" })).status).toBe(201);
    expect((await signup(org, { email: "b@acme.com" })).status).toBe(201);
    for (let i = 0; i < 10; i += 1) {
      const r = await signup(org, { joinCode: "ABCDEFGHJKLM" });
      expect(r.status).toBe(403);
      expect(r.body).toEqual(JOIN_DENIED);
    }
    const blocked = await signup(org, { email: "c@acme.com" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/^Too many attempts with an invalid code\. Try again in \d+ minutes?$/);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(await sys(User).countDocuments({ email: "c@acme.com" })).toBe(0);
    // the blocked requests still show up in no join_code_failed rows (they never reached the handler)
    expect(await audits({ action: "join_code_failed" })).toHaveLength(10);
  });
});
