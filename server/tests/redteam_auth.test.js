// Red-team (reviewer R2): signup / verify / setup / login / limiters. Every test tries to break
// the flow described in MULTI_TENANT_DECISIONS.md; none trusts the other suites.
const express = require("express");
const request = require("supertest");
const { connect, reset, disconnect, makeUser, makeOrg, sys, auth } = require("./helpers");
const { hashToken } = require("../utils/identity");

let app, env, User, AuditLog, Organization, rateLimit, email, joinCodes;

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
  joinCodes = require("../utils/joinCodes");
});
afterAll(disconnect);
beforeEach(fresh);
const savedEnv = {};
afterEach(() => {
  jest.restoreAllMocks();
  for (const k of Object.keys(savedEnv)) env[k] = savedEnv[k];
});
const setEnv = (patch) => {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in savedEnv)) savedEnv[k] = env[k];
    env[k] = v;
  }
};

const GENERIC = { error: "Invalid code or email not eligible" };
const post = (path, body, headers = {}) => {
  let r = request(app).post(`/api/auth/${path}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
};
let seq = 0;
const acme = (over = {}) => makeOrg({ name: `Acme ${Date.now()}-${++seq}`, allowedDomains: ["acme.com"], ...over });
const signup = (org, over = {}, kind = "ml_engineer", headers) =>
  post("signup", { name: "Ada", email: "ada@acme.com", joinCode: org.codes[kind].value, ...over }, headers);
const lastMail = () => email.outbox[email.outbox.length - 1];
const tokenFromMail = (mail = lastMail(), page = "/verify-email") =>
  new URL(email.extractLinks(mail.text).find((l) => l.includes(page))).searchParams.get("token");
const verify = (token, password = "Password1!") => post("verify-email", { token, password });
const dbUser = (filter) => sys(User).findOne(filter).select("+verifyTokenHash +setupTokenHash");
const usedSeats = async (org, kind = "ml_engineer") => (await Organization.findById(org._id)).codes[kind].used;
const countUsers = (filter = {}) => sys(User).countDocuments(filter);

async function signedUp(org, over, kind) {
  const res = await signup(org, over, kind);
  if (res.status !== 201) throw new Error(`signup ${res.status} ${JSON.stringify(res.body)}`);
  return { res, token: tokenFromMail() };
}

// ---------------------------------------------------------------------------------------------
describe("join code: one generic answer, no side effects, no enumeration", () => {
  test("every failure mode answers the byte-identical 403, creates nothing, sends nothing", async () => {
    const live = await acme();
    const expired = await acme({ codes: { ...joinCodes.newCodes(), ml_engineer: { ...joinCodes.newCodeEntry(), expiresAt: new Date(Date.now() - 1000) } } });
    const full = await acme({ codes: { ...joinCodes.newCodes(), ml_engineer: { ...joinCodes.newCodeEntry(), seatLimit: 1, used: 1 } } });
    const suspended = await acme({ status: "suspended" });
    const old = live.codes.ml_engineer.value;
    // regenerate (as the org admin would) -> the old value must die at once
    await Organization.updateOne({ _id: live._id }, { $set: { "codes.ml_engineer": joinCodes.newCodeEntry(live.codes.ml_engineer) } });

    const attempts = [
      { joinCode: "ABCD-EFGH-JKLM" }, // unknown
      { joinCode: "short" }, // malformed
      { joinCode: "ABCDEFGHJKLM".repeat(5) }, // 60 chars, malformed
      { joinCode: old }, // regenerated away
      { joinCode: expired.codes.ml_engineer.value },
      { joinCode: full.codes.ml_engineer.value },
      { joinCode: suspended.codes.ml_engineer.value },
      { joinCode: live.codes.compliance_officer.value, email: "ada@evil.com" }, // wrong domain
      { joinCode: live.codes.compliance_officer.value, email: "ada@acme.com.evil.com" },
      { joinCode: live.codes.compliance_officer.value, email: "ada@mail.acme.com" },
    ];
    const answers = [];
    for (const a of attempts) {
      const res = await post("signup", { name: "Ada", email: "ada@acme.com", ...a });
      answers.push([res.status, JSON.stringify(res.body)]);
    }
    for (const [status, body] of answers) {
      expect(status).toBe(403);
      expect(body).toBe(JSON.stringify(GENERIC));
    }
    expect(await countUsers()).toBe(0);
    expect(email.outbox).toHaveLength(0);
    // the failures are audited, never with the code the caller typed
    const rows = await sys(AuditLog).find({ action: "join_code_failed" });
    expect(rows.length).toBe(attempts.length);
    for (const r of rows) expect(r.details).not.toMatch(/[A-Z2-9]{12}|ABCD-EFGH/);
  });

  test("a valid code never changes status or body shape depending on the org (no org leak in the success body)", async () => {
    const o1 = await acme();
    const res = await signup(o1);
    expect(Object.keys(res.body).sort()).toEqual(["devVerifyUrl", "emailSent", "message", "status"]);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(o1.name));
  });

  test("non-string / operator join codes and fields: 400 (or generic 403), never a crash or a match", async () => {
    const org = await acme();
    const bad = [{ $gt: "" }, [org.codes.ml_engineer.value], 12345, null, true, { value: org.codes.ml_engineer.value }];
    for (const joinCode of bad) {
      const res = await post("signup", { name: "Ada", email: "ada@acme.com", joinCode });
      expect([400, 403]).toContain(res.status);
      expect(res.status).not.toBe(500);
    }
    const res = await post("signup", { name: { $ne: "" }, email: "ada@acme.com", joinCode: org.codes.ml_engineer.value });
    expect(res.status).toBe(400);
    const r2 = await post("signup", { name: "Ada", email: { $gt: "" }, joinCode: org.codes.ml_engineer.value });
    expect(r2.status).toBe(400);
    expect(await countUsers()).toBe(0);
  });

  test("role comes from the code only: role/orgId/status/isActive/seat/password/token fields in the body are ignored", async () => {
    const org = await acme();
    const other = await acme();
    const res = await post("signup", {
      name: "Ada",
      email: "ada@acme.com",
      joinCode: org.codes.compliance_officer.value,
      role: "admin",
      orgId: String(other._id),
      status: "active",
      isActive: true,
      seatKind: "ml_engineer",
      seatGen: 99,
      password: "Hunter2hunter2",
      verifyTokenHash: hashToken("known"),
      verifyExpiresAt: new Date(Date.now() + 1e12),
      passwordHash: "x",
    });
    expect(res.status).toBe(201);
    const u = await dbUser({ email: "ada@acme.com" });
    expect(u.role).toBe("compliance_officer");
    expect(String(u.orgId)).toBe(String(org._id));
    expect(u.status).toBe("unverified");
    expect(u.seatKind).toBe("compliance_officer");
    expect(u.verifyTokenHash).not.toBe(hashToken("known"));
    expect(u.verifyExpiresAt.getTime()).toBeLessThan(Date.now() + 8 * 864e5);
    // the "known" password cannot sign in (unverified accounts have an unusable password)
    expect((await post("login", { email: "ada@acme.com", password: "Hunter2hunter2" })).status).toBe(401);
    expect(await usedSeats(org, "compliance_officer")).toBe(1);
    expect(await usedSeats(other, "compliance_officer")).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("guessing: per-IP limiter, spoofed forwarding headers, IPv6 /64", () => {
  test("the 11th failed attempt is 429 and rotating X-Forwarded-For (trust proxy off) buys nothing", async () => {
    const org = await acme();
    let blockedAt = 0;
    for (let i = 1; i <= 14; i += 1) {
      const res = await post(
        "signup",
        { name: "Ada", email: "ada@acme.com", joinCode: "AAAA-AAAA-AAA" + (i % 10) },
        { "X-Forwarded-For": `10.0.0.${i}`, "X-Real-IP": `10.1.0.${i}`, Forwarded: `for=10.2.0.${i}` }
      );
      if (res.status === 429) {
        blockedAt = i;
        break;
      }
      expect(res.status).toBe(403);
    }
    expect(blockedAt).toBe(11);
    // even the correct code is refused for the blocked client: the budget is the point
    const res = await signup(org, {}, "ml_engineer", { "X-Forwarded-For": "99.9.9.9" });
    expect(res.status).toBe(429);
  });

  test("successful signups do not eat the failure budget", async () => {
    const org = await acme();
    for (let i = 0; i < 12; i += 1) expect((await signup(org, { email: `u${i}@acme.com` })).status).toBe(201);
    // 12 > 10 successes, yet a failure is still a plain 403 (the general signup limiter is 20/h)
    expect((await signup({ codes: { ml_engineer: { value: "AAAAAAAAAAAA" } } }, { email: "z@acme.com" })).status).toBe(403);
  });

  test("ipKey: one bucket per /64, IPv4-mapped IPv6 shares the IPv4 bucket, garbage never throws", () => {
    const { ipKey } = rateLimit;
    expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8:1:2::1")).not.toBe(ipKey("2001:db8:1:3::1"));
    expect(ipKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("::FFFF:102:304")).toBe("1.2.3.4");
    expect(ipKey("fe80::1%eth0")).toBe(ipKey("fe80::2%wlan0"));
    for (const weird of [undefined, null, "", " ", "::", "1::", "::1", "1:2:3:4:5:6:7::", "not an ip", "999.1.1.1", "1:2:3:4:5:6:7:8:9", "a".repeat(500), 42, {}]) {
      expect(() => ipKey(weird)).not.toThrow();
      expect(typeof ipKey(weird)).toBe("string");
      expect(ipKey(weird).length).toBeLessThanOrEqual(100);
    }
  });

  test("account-level login limiter keys on the NORMALIZED email: +tag rotation must not reset the counter", async () => {
    const lim = rateLimit.createAccountLoginLimiter({ maxAccountFailures: 3, windowMinutes: 15 });
    const a = express();
    a.use(express.json());
    a.post("/login", lim, (req, res) => res.status(401).json({ error: "bad" }));
    const statuses = [];
    for (const e of ["victim@acme.com", "victim+1@acme.com", "VICTIM+2@acme.com", "victim+3@acme.com", "victim+4@acme.com", "victim+5@acme.com"]) {
      statuses.push((await request(a).post("/login").send({ email: e, password: "x" })).status);
    }
    // every variant logs into the SAME account (login looks up by emailKey), so the 4th failure must be blocked
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("email normalisation vs domain check vs one-account-per-person", () => {
  const accepted = async (raw) => {
    const org = await acme();
    const res = await post("signup", { name: "Ada", email: raw, joinCode: org.codes.ml_engineer.value });
    return { org, res, user: await dbUser({ orgId: org._id }) };
  };

  test.each([
    "ada@acme.com.",
    "ada@acme.com.evil.com",
    "ada@evil.com@acme.com",
    '"ada@acme.com"@evil.com',
    "ada@sub.acme.com",
    "ada@acme.co",
    "ada@acme.com,evil@x.com",
    "ada@acme.com;evil@x.com",
    "ada@acme.com\r\nBcc: evil@x.com",
    "ada@acme.com\u0000.evil.com",
    "ada@аcme.com", // cyrillic a
    "ada@acme。com", // ideographic full stop
    "ada@xn--acme.com",
    "ada@ACME.COM.EVIL.COM",
    "ada@[127.0.0.1]",
    "ada@acme.com>",
    "<ada@acme.com>",
    "ada <ada@acme.com>",
    "ada@acme.com ada@evil.com",
    "@acme.com",
    "ada@",
    "ada",
  ])("hostile address %j never produces an account outside acme.com", async (raw) => {
    const { res, user } = await accepted(raw);
    expect(res.status).not.toBe(500);
    if (res.status === 201) {
      expect(user.email.split("@").length).toBe(2);
      expect(user.email.endsWith("@acme.com")).toBe(true);
    } else {
      expect(user).toBeNull();
    }
  });

  test("case, +tag and surrounding whitespace collapse to ONE account; a second org cannot create a twin", async () => {
    const orgA = await acme();
    const orgB = await makeOrg({ name: `OpenOrg ${Date.now()}`, domainRuleEnabled: false, allowedDomains: [] });
    const { token } = await signedUp(orgA, { email: "  Jo+HR@ACME.com " });
    expect((await verify(token)).status).toBe(200); // now pending (a real, non-replaceable account)
    for (const e of ["jo@acme.com", "JO@acme.com", "jo+other@acme.com", "jo+@acme.com", "jo++x@acme.com"]) {
      const res = await signup(orgA, { email: e });
      expect(res.status).toBe(409);
      const cross = await signup(orgB, { email: e });
      expect(cross.status).toBe(409);
    }
    expect(await countUsers()).toBe(1);
    expect(await usedSeats(orgA)).toBe(1);
    expect(await usedSeats(orgB)).toBe(0);
  });

  test("a +tag at position 0 or empty local part is not collapsed into someone else's key", async () => {
    const { normalizeEmail } = require("../utils/identity");
    expect(normalizeEmail("+x@acme.com")).toBe("+x@acme.com");
    expect(normalizeEmail("a+b+c@acme.com")).toBe("a@acme.com");
    expect(normalizeEmail("A@Acme.Com")).toBe("a@acme.com");
    expect(normalizeEmail("no-at-sign")).toBe("no-at-sign");
  });
});

// ---------------------------------------------------------------------------------------------
describe("seat accounting under concurrency", () => {
  const setLimit = (org, n, kind = "ml_engineer") => Organization.updateOne({ _id: org._id }, { $set: { [`codes.${kind}.seatLimit`]: n } });

  test("limit 3, 12 parallel signups: exactly 3 succeed, used == users == 3", async () => {
    const org = await acme();
    await setLimit(org, 3);
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => signup(org, { email: `p${i}@acme.com` })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 403 || r.status === 429)).toHaveLength(9);
    expect(await usedSeats(org)).toBe(3);
    expect(await countUsers({ orgId: org._id })).toBe(3);
  });

  test("double submit: the same email 8x in parallel leaves ONE account and ONE seat", async () => {
    const org = await acme();
    const rs = await Promise.all(Array.from({ length: 8 }, () => signup(org)));
    expect(rs.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    for (const r of rs) expect([201, 403, 409]).toContain(r.status);
    expect(await countUsers({ email: "ada@acme.com" })).toBe(1);
    expect(await usedSeats(org)).toBe(1);
  });

  test("double submit under a 1-seat limit: the person is never locked out of the single seat they hold", async () => {
    const org = await acme();
    await setLimit(org, 1);
    const rs = await Promise.all(Array.from({ length: 5 }, () => signup(org)));
    expect(rs.some((r) => r.status === 201)).toBe(true);
    expect(await countUsers({ email: "ada@acme.com" })).toBe(1);
    expect(await usedSeats(org)).toBe(1);
    // a re-signup of the same unverified person replaces the old row even though the code is full
    expect((await signup(org)).status).toBe(201);
    expect(await usedSeats(org)).toBe(1);
    // a different person cannot take the seat
    expect((await signup(org, { email: "bob@acme.com" })).status).toBe(403);
  });

  test("reject, expire and replace each give back exactly one seat; none go negative or double-release", async () => {
    const { expireUnverified } = require("../jobs/expireUnverified");
    const org = await acme();
    await setLimit(org, 5);
    for (const e of ["a", "b", "c"]) await signedUp(org, { email: `${e}@acme.com` });
    expect(await usedSeats(org)).toBe(3);
    // expire b
    await sys(User).updateOne({ email: "b@acme.com" }, { $set: { verifyExpiresAt: new Date(Date.now() - 1000) } });
    expect((await expireUnverified()).removed).toBe(1);
    expect((await expireUnverified()).removed).toBe(0);
    expect(await usedSeats(org)).toBe(2);
    // replace a (same person signs up again)
    expect((await signup(org, { email: "a+again@acme.com" })).status).toBe(201);
    expect(await usedSeats(org)).toBe(2);
    expect(await countUsers({ orgId: org._id })).toBe(2);
    // after a regenerate (gen bump) a late release for the old generation is a no-op
    const before = await Organization.findById(org._id);
    await Organization.updateOne({ _id: org._id }, { $set: { "codes.ml_engineer": joinCodes.newCodeEntry(before.codes.ml_engineer) } });
    await sys(User).updateOne({ email: "c@acme.com" }, { $set: { verifyExpiresAt: new Date(Date.now() - 1000) } });
    await expireUnverified();
    expect(await usedSeats(org)).toBe(0);
    await joinCodes.releaseSeat(org._id, "ml_engineer", 1);
    expect(await usedSeats(org)).toBe(0);
  });

  test("regenerate racing a burst of signups: the new generation's counter equals the accounts that hold a NEW-generation seat", async () => {
    const org = await acme();
    const old = org.codes.ml_engineer.value;
    const jobs = Array.from({ length: 10 }, (_, i) => signup(org, { email: `g${i}@acme.com` }));
    jobs.push(
      (async () => {
        await new Promise((r) => setTimeout(r, 15));
        await Organization.updateOne({ _id: org._id }, { $set: { "codes.ml_engineer": joinCodes.newCodeEntry(org.codes.ml_engineer) } });
      })()
    );
    const rs = await Promise.all(jobs);
    for (const r of rs.filter((x) => x && x.status)) expect([201, 403]).toContain(r.status);
    const o = await Organization.findById(org._id);
    expect(o.codes.ml_engineer.value).not.toBe(old);
    const holders = await countUsers({ orgId: org._id, seatKind: "ml_engineer", seatGen: o.codes.ml_engineer.gen });
    expect(o.codes.ml_engineer.used).toBe(holders);
    expect(o.codes.ml_engineer.used).toBeGreaterThanOrEqual(0);
  });

  test("expiry boundary: a code that expires between the check and the seat grab is refused with the generic 403, no account, no seat", async () => {
    const org = await acme();
    await Organization.updateOne({ _id: org._id }, { $set: { "codes.ml_engineer.expiresAt": new Date(Date.now() + 1200) } });
    expect((await signup(org, { email: "early@acme.com" })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 1300));
    const late = await signup(org, { email: "late@acme.com" });
    expect([late.status, late.body]).toEqual([403, GENERIC]);
    expect(await usedSeats(org)).toBe(1);
    expect(await countUsers({ email: "late@acme.com" })).toBe(0);
  });

  test("CHARACTERISATION: an unverified signup is replaced by ANY org's later signup with the same address (seat of the first org is released, not leaked)", async () => {
    const a = await makeOrg({ name: `Open A ${Date.now()}`, domainRuleEnabled: false, allowedDomains: [] });
    const b = await makeOrg({ name: `Open B ${Date.now()}`, domainRuleEnabled: false, allowedDomains: [] });
    await signedUp(a, { email: "sam@corp.com" });
    expect(await usedSeats(a)).toBe(1);
    expect((await signup(b, { email: "sam@corp.com" })).status).toBe(201);
    expect(await usedSeats(a)).toBe(0);
    expect(await usedSeats(b)).toBe(1);
    expect(await countUsers({ email: "sam@corp.com" })).toBe(1);
  });

  test("verify racing the expiry job and a replacement signup: exactly one transition wins, seat count stays consistent", async () => {
    const { expireUnverified } = require("../jobs/expireUnverified");
    for (let round = 0; round < 4; round += 1) {
      await fresh();
      const org = await acme();
      const { token } = await signedUp(org);
      await sys(User).updateOne({ email: "ada@acme.com" }, { $set: { verifyExpiresAt: new Date(Date.now() + 40) } });
      await new Promise((r) => setTimeout(r, 35));
      await Promise.all([verify(token), expireUnverified(new Date(Date.now() + 1000)), signup(org)]);
      const users = await sys(User).find({ orgId: org._id });
      expect(users.length).toBeLessThanOrEqual(1);
      expect(await usedSeats(org)).toBe(users.length);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("verification and setup tokens", () => {
  test("single use, exact expiry boundary, and the link survives a weak password", async () => {
    const org = await acme();
    const { token } = await signedUp(org);
    expect((await verify(token, "short")).status).toBe(400);
    expect((await verify(token, "x".repeat(73))).status).toBe(400);
    expect((await post("verify-email/check", { token })).status).toBe(200); // still valid
    // exactly at the boundary: verifyExpiresAt == now is already expired
    await sys(User).updateOne({ email: "ada@acme.com" }, { $set: { verifyExpiresAt: new Date(Date.now() - 1) } });
    expect((await verify(token)).status).toBe(400);
    expect((await post("verify-email/check", { token })).status).toBe(400);
    await sys(User).updateOne({ email: "ada@acme.com" }, { $set: { verifyExpiresAt: new Date(Date.now() + 5000) } });
    expect((await verify(token)).status).toBe(200);
    expect((await verify(token)).status).toBe(400); // reuse
    expect((await verify(token, "OtherPass99!")).status).toBe(400);
    // the password set by the first (only) success is the one in force
    expect((await post("login", { email: "ada@acme.com", password: "Password1!" })).status).toBe(403);
    expect((await post("login", { email: "ada@acme.com", password: "OtherPass99!" })).status).toBe(401);
  });

  test("parallel double submit of the same link: one 200, the rest 400", async () => {
    const org = await acme({ autoApprove: true });
    const { token } = await signedUp(org);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => verify(token, `Password${i}!x`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(5);
    const audits = await sys(AuditLog).find({ action: "email_verified" });
    expect(audits).toHaveLength(1);
  });

  test("tokens of the wrong kind or user never work on the other endpoint", async () => {
    const org = await acme();
    const admin = await makeUser("admin", { orgId: org._id });
    // an invited user with a setup token
    const add = await auth(request(app).post("/api/users"), admin.token).send({ name: "Inv", email: "inv@acme.com", role: "ml_engineer" });
    expect(add.status).toBe(201);
    const setupToken = new URL(add.body.setupLink).searchParams.get("token");
    const { token: verifyToken } = await signedUp(org, { email: "ver@acme.com" });
    // verify token on setup endpoints and vice versa
    expect((await post("setup-password", { token: verifyToken, password: "Password1!" })).status).toBe(400);
    expect((await post("setup-password/check", { token: verifyToken })).status).toBe(400);
    expect((await verify(setupToken)).status).toBe(400);
    expect((await post("verify-email/check", { token: setupToken })).status).toBe(400);
    // nothing changed
    expect((await dbUser({ email: "inv@acme.com" })).status).toBe("invited");
    expect((await dbUser({ email: "ver@acme.com" })).status).toBe("unverified");
    // the stored value is the hash, not the token, and a HASH submitted as a token does not work
    const row = await dbUser({ email: "ver@acme.com" });
    expect((await verify(row.verifyTokenHash)).status).toBe(400);
    const row2 = await dbUser({ email: "inv@acme.com" });
    expect((await post("setup-password", { token: row2.setupTokenHash, password: "Password1!" })).status).toBe(400);
  });

  test("non-string / operator tokens are 400, never a match and never a 500", async () => {
    const org = await acme();
    await signedUp(org);
    const bad = [{ $ne: "" }, { $gt: "" }, [""], ["a", "b"], null, 0, true, {}, { verifyTokenHash: { $exists: true } }, "", " ", "x".repeat(201), "a".repeat(64) + "\u0000"];
    for (const token of bad) {
      rateLimit.resetAll(); // the 30/15min token limiter is not what is under test here
      for (const [path, extra] of [["verify-email", { password: "Password1!" }], ["verify-email/check", {}], ["setup-password", { password: "Password1!" }], ["setup-password/check", {}]]) {
        const res = await post(path, { token, ...extra });
        expect(res.status).toBe(400);
      }
    }
    // raw query-ish payloads straight through JSON (mongo-sanitize strips $-keys; zod must still reject)
    rateLimit.resetAll();
    const res = await request(app).post("/api/auth/verify-email").set("Content-Type", "application/json").send('{"token":{"$gt":""},"password":"Password1!"}');
    expect(res.status).toBe(400);
    expect((await dbUser({ email: "ada@acme.com" })).status).toBe("unverified");
  });

  test("resend: new link kills the old one, never extends expiry, answers identically for everyone", async () => {
    const org = await acme();
    const { token: first } = await signedUp(org);
    const before = (await dbUser({ email: "ada@acme.com" })).verifyExpiresAt.getTime();
    email.clearOutbox();
    const known = await post("resend-verification", { email: "ADA+x@acme.com" });
    const unknown = await post("resend-verification", { email: "nobody@acme.com" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    await new Promise((r) => setTimeout(r, 30));
    expect(email.outbox).toHaveLength(1);
    const second = tokenFromMail();
    expect(second).not.toBe(first);
    expect((await dbUser({ email: "ada@acme.com" })).verifyExpiresAt.getTime()).toBe(before);
    expect((await verify(first)).status).toBe(400);
    expect((await verify(second)).status).toBe(200);
    // no mail for pending, active, invited, expired-unverified, or nonexistent accounts
    email.clearOutbox();
    for (const [i, status] of ["pending", "active", "invited", "unverified"].entries()) {
      await makeUser("ml_engineer", { orgId: org._id, status, email: `s${i}@acme.com`, extra: status === "unverified" ? { verifyExpiresAt: new Date(Date.now() - 1000), verifyTokenHash: hashToken("zz") } : {} });
      await post("resend-verification", { email: `s${i}@acme.com` });
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(email.outbox).toHaveLength(0);
  });

  test("resend abuse: 5/hour per address (case and +tag variants share the counter) and 5/hour per IP", async () => {
    const org = await acme();
    await signedUp(org);
    const variants = ["ada@acme.com", "ADA@acme.com", "ada+1@acme.com", "ada+2@acme.com", "Ada+3@Acme.com"];
    for (const e of variants) expect((await post("resend-verification", { email: e })).status).toBe(200);
    expect((await post("resend-verification", { email: "ada+99@acme.com" })).status).toBe(429);
    // the per-IP counter is shared, so another victim from the same IP is blocked too
    expect((await post("resend-verification", { email: "someone-else@acme.com" })).status).toBe(429);
  });

  test("non-string resend / login emails are rejected, not queried", async () => {
    for (const e of [{ $ne: "" }, ["a@b.co"], 5, null]) {
      expect((await post("resend-verification", { email: e })).status).toBe(400);
      expect((await post("login", { email: e, password: "Password1!" })).status).toBe(400);
    }
    expect((await post("login", { email: "a@b.co", password: { $ne: "" } })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe("links are built from APP_URL only, and secrets stay out of every side channel", () => {
  test("hostile Host / X-Forwarded-Host / Origin / Referer never reach a link (signup, resend, mail text and html)", async () => {
    const org = await acme();
    const evil = { Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https", Referer: "https://evil.example/x" };
    const res = await signup(org, {}, "ml_engineer", evil);
    expect(res.status).toBe(201);
    expect(res.body.devVerifyUrl.startsWith(env.appUrl + "/")).toBe(true);
    await post("resend-verification", { email: "ada@acme.com" }, evil);
    await new Promise((r) => setTimeout(r, 30));
    expect(email.outbox.length).toBe(2);
    for (const m of email.outbox) {
      expect(JSON.stringify(m)).not.toMatch(/evil\.example/);
      for (const l of email.extractLinks(m.text)) expect(l.startsWith(env.appUrl + "/")).toBe(true);
    }
  });

  test("a hostile Origin header is stopped by CORS before any handler runs", async () => {
    const org = await acme();
    const res = await signup(org, {}, "ml_engineer", { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await countUsers()).toBe(0);
    expect(email.outbox).toHaveLength(0);
  });

  test("no token, token hash or password hash in any response, audit row, or console output of the whole lifecycle", async () => {
    const logs = ["log", "warn", "error", "info"].map((k) => jest.spyOn(console, k).mockImplementation(() => {}));
    const org = await acme();
    const admin = await makeUser("admin", { orgId: org._id });
    const responses = [];
    const keep = (r) => (responses.push(JSON.stringify(r.body) + JSON.stringify(r.headers)), r);
    const s = keep(await signup(org));
    const token = tokenFromMail();
    keep(await post("verify-email/check", { token }));
    keep(await post("resend-verification", { email: "ada@acme.com" }));
    const token2 = tokenFromMail();
    keep(await verify(token2));
    keep(await post("login", { email: "ada@acme.com", password: "Password1!" })); // 403 pending
    keep(await post("login", { email: "ada@acme.com", password: "wrong" }));
    const pend = keep(await auth(request(app).get("/api/users/pending"), admin.token));
    const uid = pend.body.users[0].id;
    keep(await auth(request(app).post(`/api/users/${uid}/approve`), admin.token));
    keep(await auth(request(app).get("/api/users"), admin.token));
    const login = keep(await post("login", { email: "ada@acme.com", password: "Password1!" }));
    keep(await request(app).get("/api/auth/me").set("Authorization", `Bearer ${login.body.token}`));
    const add = keep(await auth(request(app).post("/api/users"), admin.token).send({ name: "Inv", email: "inv@acme.com", role: "ml_engineer" }));
    const setupTok = new URL(add.body.setupLink).searchParams.get("token");
    keep(await post("setup-password/check", { token: setupTok }));
    keep(await post("setup-password", { token: setupTok, password: "Password1!" }));
    await new Promise((r) => setTimeout(r, 30));

    const secrets = [token, token2, setupTok];
    const rows = await sys(User).find({}).select("+verifyTokenHash +setupTokenHash +passwordHash");
    for (const u of rows) {
      for (const f of ["passwordHash", "verifyTokenHash", "setupTokenHash"]) if (u[f]) secrets.push(u[f]);
    }
    const audit = JSON.stringify(await sys(AuditLog).find({}).lean());
    const consoleOut = JSON.stringify(logs.map((l) => l.mock.calls));
    for (const sec of secrets) {
      for (const [where, hay] of [["audit", audit], ["console", consoleOut]]) expect([where, hay.includes(sec)]).toEqual([where, false]);
    }
    // responses: only the two links the plan allows (devVerifyUrl on signup, setupLink to the admin) may carry a token
    for (const body of responses) {
      for (const sec of [...secrets.filter((x) => x !== token && x !== setupTok)]) expect(body.includes(sec)).toBe(false);
      expect(body).not.toMatch(/passwordHash|verifyTokenHash|setupTokenHash|\$2[aby]\$/);
    }
    expect(s.body.devVerifyUrl).toContain(token);
  });

  test("with a real provider the signup response carries NO link and no dev field; a relay failure still returns 201 emailSent:false", async () => {
    setEnv({ emailProvider: "apps_script", appsScriptUrl: "https://relay.example/exec", appsScriptSecret: "s3cret-relay" });
    const org = await acme();
    for (const answer of [{ ok: false, error: "Service invoked too many times for one day: email" }, { ok: true }]) {
      jest.spyOn(global, "fetch").mockImplementation(async () => ({ ok: true, status: 200, body: null, text: async () => JSON.stringify(answer) }));
      const res = await signup(org, { email: `u${Math.random().toString(36).slice(2)}@acme.com` });
      expect(res.status).toBe(201);
      expect(res.body.emailSent).toBe(answer.ok);
      expect(res.body.devVerifyUrl).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/token=|s3cret-relay|relay\.example/);
    }
    // relay timing out / dying: same
    jest.spyOn(global, "fetch").mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED relay.example s3cret-relay"), { name: "TypeError" }));
    const res = await signup(org, { email: "late@acme.com" });
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(await countUsers({ email: "late@acme.com" })).toBe(1);
  });

  test("names and org names are HTML-escaped in mails; CR/LF cannot reach the subject", async () => {
    const org = await makeOrg({ name: `<script>alert('o')</script> Org ${Date.now()}`, allowedDomains: ["acme.com"] });
    await signup(org, { name: `<img src=x onerror=alert(1)>"'&\r\nBcc: evil@x.com` });
    const m = lastMail();
    expect(m.html).not.toMatch(/<script|<img/i);
    expect(m.html).toContain("&lt;img");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.to).toBe("ada@acme.com");
  });
});

// ---------------------------------------------------------------------------------------------
describe("account states, including an already-issued JWT", () => {
  test("every non-active state is refused on login (with the right code only AFTER the password) and kills an issued token", async () => {
    const org = await acme();
    const u = await makeUser("admin", { orgId: org._id, email: "boss@acme.com" });
    const api = (t) => request(app).get("/api/users").set("Authorization", `Bearer ${t}`);
    expect((await api(u.token)).status).toBe(200);

    const states = [
      [{ status: "pending" }, "ACCOUNT_PENDING"],
      [{ status: "unverified" }, "EMAIL_UNVERIFIED"],
      [{ status: "invited" }, null], // login: unusable password in real life; here the hash is real, so it reports not-active
      [{ isActive: false }, "ACCOUNT_DEACTIVATED"],
    ];
    for (const [patch, code] of states) {
      await sys(User).updateOne({ _id: u.user._id }, { $set: { status: "active", isActive: true, ...patch } });
      expect((await api(u.token)).status).toBe(401);
      const wrong = await post("login", { email: "boss@acme.com", password: "WrongPass1!" });
      expect(wrong.status).toBe(401); // no probing of the state without the password
      expect(wrong.body).toEqual({ error: "Invalid email or password" });
      const right = await post("login", { email: "boss@acme.com", password: u.password });
      expect(right.status).toBe(403);
      if (code) expect(right.body.code).toBe(code);
      expect(right.body.token).toBeUndefined();
      rateLimit.resetAll();
    }
    await sys(User).updateOne({ _id: u.user._id }, { $set: { status: "active", isActive: true } });
    await Organization.updateOne({ _id: org._id }, { $set: { status: "suspended" } });
    expect((await api(u.token)).status).toBe(401);
    const sus = await post("login", { email: "boss@acme.com", password: u.password });
    expect(sus.status).toBe(403);
    expect(sus.body.code).toBe("ORG_SUSPENDED");
    await Organization.updateOne({ _id: org._id }, { $set: { status: "active" } });
    expect((await api(u.token)).status).toBe(200);
    // deleted user (rejected / expired): token dead
    await sys(User).deleteOne({ _id: u.user._id });
    expect((await api(u.token)).status).toBe(401);
  });

  test("a token minted for role admin does not keep admin powers after a demotion (role is read from the row)", async () => {
    const org = await acme();
    const a1 = await makeUser("admin", { orgId: org._id });
    await makeUser("admin", { orgId: org._id });
    await sys(User).updateOne({ _id: a1.user._id }, { $set: { role: "ml_engineer" } });
    expect((await auth(request(app).get("/api/users"), a1.token)).status).toBe(403);
  });

  test("unverified, pending and invited accounts appear nowhere in the member list and cannot be edited as members", async () => {
    const org = await acme();
    const admin = await makeUser("admin", { orgId: org._id });
    const ids = {};
    for (const st of ["unverified", "pending", "invited"]) ids[st] = (await makeUser("ml_engineer", { orgId: org._id, status: st })).user._id;
    const list = await auth(request(app).get("/api/users"), admin.token);
    const seen = list.body.users.map((x) => x.status);
    expect(seen).toContain("invited");
    expect(seen).not.toContain("pending");
    expect(seen).not.toContain("unverified");
    for (const st of ["unverified", "pending"]) {
      const r = await auth(request(app).patch(`/api/users/${ids[st]}`), admin.token).send({ isActive: true, role: "admin" });
      expect(r.status).toBe(404);
      expect((await sys(User).findById(ids[st])).role).toBe("ml_engineer");
    }
  });

  test("auto-approve is decided at verification time from the CURRENT rules", async () => {
    const org = await acme({ autoApprove: true });
    const { token } = await signedUp(org, { email: "a1@acme.com" });
    // super admin switches the domain rule off meanwhile -> autoApprove is forced off by the route; emulate the raw state too
    await Organization.updateOne({ _id: org._id }, { $set: { domainRuleEnabled: false } });
    const r1 = await verify(token);
    expect(r1.body.status).toBe("pending");

    const org2 = await acme({ autoApprove: true });
    const { token: t2 } = await signedUp(org2, { email: "a2@acme.com" });
    await Organization.updateOne({ _id: org2._id }, { $set: { allowedDomains: ["other.com"] } });
    expect((await verify(t2)).body.status).toBe("pending");

    const org3 = await acme({ autoApprove: true });
    const { token: t3 } = await signedUp(org3, { email: "a3@acme.com" });
    await Organization.updateOne({ _id: org3._id }, { $set: { status: "suspended" } });
    expect((await verify(t3)).body.status).toBe("pending");

    const org4 = await acme({ autoApprove: true });
    const { token: t4 } = await signedUp(org4, { email: "a4@acme.com" });
    const ok = await verify(t4);
    expect(ok.body.status).toBe("active");
    expect(ok.body.token).toBeUndefined(); // never a session straight from a mailbox click
    // an org with the rule off and autoApprove stuck at true (bad data) still never auto-approves
    const org5 = await makeOrg({ name: `NoRule ${Date.now()}`, domainRuleEnabled: false, allowedDomains: [], autoApprove: true });
    const { token: t5 } = await signedUp(org5, { email: "a5@gmail.com" });
    expect((await verify(t5)).body.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------------------------
describe("setup-password", () => {
  async function invited(over = {}) {
    const org = await acme(over.org);
    const admin = await makeUser("admin", { orgId: org._id });
    const add = await auth(request(app).post("/api/users"), admin.token).send({ name: "Inv", email: "inv@acme.com", role: "ml_engineer" });
    return { org, admin, link: add.body.setupLink, token: new URL(add.body.setupLink).searchParams.get("token") };
  }

  test("works once, signs the person in, clears the token; weak password keeps the link; expiry boundary", async () => {
    const { token } = await invited();
    expect((await post("setup-password", { token, password: "weak" })).status).toBe(400);
    await sys(User).updateOne({ email: "inv@acme.com" }, { $set: { setupExpiresAt: new Date(Date.now() - 1) } });
    expect((await post("setup-password", { token, password: "Password1!" })).status).toBe(400);
    await sys(User).updateOne({ email: "inv@acme.com" }, { $set: { setupExpiresAt: new Date(Date.now() + 5000) } });
    const ok = await post("setup-password", { token, password: "Password1!" });
    expect(ok.status).toBe(200);
    expect(ok.body.user.status).toBe("active");
    expect(JSON.stringify(ok.body)).not.toMatch(/passwordHash|TokenHash/);
    expect((await post("setup-password", { token, password: "Another1!!" })).status).toBe(400);
    const row = await dbUser({ email: "inv@acme.com" });
    expect(row.setupTokenHash).toBeUndefined();
    expect((await post("login", { email: "inv@acme.com", password: "Password1!" })).status).toBe(200);
  });

  test("parallel double submit: only one password wins", async () => {
    const { token } = await invited();
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => post("setup-password", { token, password: `Password${i}!!` })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test("deactivated invitee and suspended org: the link does not work (and is not burned for the check endpoint)", async () => {
    const { token, org } = await invited();
    await sys(User).updateOne({ email: "inv@acme.com" }, { $set: { isActive: false } });
    expect((await post("setup-password", { token, password: "Password1!" })).status).toBe(403);
    expect((await post("setup-password/check", { token })).status).toBe(403);
    await sys(User).updateOne({ email: "inv@acme.com" }, { $set: { isActive: true } });
    await Organization.updateOne({ _id: org._id }, { $set: { status: "suspended" } });
    expect((await post("setup-password", { token, password: "Password1!" })).status).toBe(403);
    expect((await dbUser({ email: "inv@acme.com" })).status).toBe("invited");
  });

  test("a pending / active / unverified account can never be 'set up' with a replayed or forged setup token", async () => {
    const org = await acme();
    for (const status of ["pending", "active", "unverified"]) {
      const { token, hash } = require("../utils/identity").newToken();
      await makeUser("ml_engineer", { orgId: org._id, status, email: `${status}@acme.com`, extra: { setupTokenHash: hash, setupExpiresAt: new Date(Date.now() + 1e6) } });
      expect((await post("setup-password", { token, password: "Hijack123!" })).status).toBe(400);
      expect((await sys(User).findOne({ email: `${status}@acme.com` })).status).toBe(status);
    }
  });
});

// A row as the migration leaves it when "+tag" collides with a plain address: key = its full address.
async function legacyPlusRow(org, addr, password) {
  const bcrypt = require("bcryptjs");
  const r = await User.collection.insertOne({
    name: "Legacy", email: addr, emailKey: addr, passwordHash: await bcrypt.hash(password, 4), role: "ml_engineer",
    orgId: org._id, status: "active", isActive: true, createdAt: new Date(),
  });
  return r.insertedId;
}

// ---------------------------------------------------------------------------------------------
describe("login", () => {
  test("unknown user and wrong password are indistinguishable (status, body, audit shape); +tag/case variants log into the one account", async () => {
    const org = await acme();
    const u = await makeUser("ml_engineer", { orgId: org._id, email: "real@acme.com" });
    const a = await post("login", { email: "real@acme.com", password: "WrongWrong1!" });
    const b = await post("login", { email: "ghost@acme.com", password: "WrongWrong1!" });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body).toEqual(b.body);
    expect((await post("login", { email: "REAL+tag@Acme.com", password: u.password })).status).toBe(200);
  });

  test("two legacy rows sharing an emailKey: the exact address wins and cannot log into the other", async () => {
    const org = await acme();
    await makeUser("ml_engineer", { orgId: org._id, email: "jo@acme.com", password: "JoPassword1!" });
    // the migration's collision outcome: jo+x keeps its own full address as key
    await legacyPlusRow(org, "jo+x@acme.com", "XPassword1!!");
    expect((await post("login", { email: "jo+x@acme.com", password: "XPassword1!!" })).status).toBe(200);
    expect((await post("login", { email: "jo+x@acme.com", password: "JoPassword1!" })).status).toBe(401);
    expect((await post("login", { email: "jo@acme.com", password: "JoPassword1!" })).status).toBe(200);
    expect((await post("login", { email: "jo+x@acme.com", password: "XPassword1!!" })).body.user.email).toBe("jo+x@acme.com");
  });

  test("a legacy +tag row that kept its full address as emailKey can still be edited (hook must not recompute a colliding key)", async () => {
    const org = await acme();
    const admin = await makeUser("admin", { orgId: org._id });
    await makeUser("ml_engineer", { orgId: org._id, email: "jo@acme.com" });
    const xId = await legacyPlusRow(org, "jo+x@acme.com", "XPassword1!!");
    const r = await auth(request(app).patch(`/api/users/${xId}`), admin.token).send({ name: "Renamed" });
    expect(r.status).toBe(200);
    expect(r.body.user.name).toBe("Renamed");
    expect((await sys(User).findById(xId)).emailKey).toBe("jo+x@acme.com");
    // and deactivating / re-activating (save() again) keeps working
    expect((await auth(request(app).patch(`/api/users/${xId}`), admin.token).send({ isActive: false })).status).toBe(200);
    expect((await auth(request(app).patch(`/api/users/${xId}`), admin.token).send({ isActive: true })).status).toBe(200);
  });
});
