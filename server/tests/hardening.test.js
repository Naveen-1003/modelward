// Regression tests for the independent security review (server core hardening).
const request = require("supertest");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { connect, reset, disconnect, makeUser, auth } = require("./helpers");

let app, env, User, AuditLog, writeAuditLog, rateLimit, chain;
const raw = () => mongoose.connection.collection("auditlogs");
const oid = () => new mongoose.Types.ObjectId();

async function fresh() {
  await reset();
  await Promise.all([AuditLog.createIndexes(), User.createIndexes()]);
  rateLimit.resetAll();
}

beforeAll(async () => {
  await connect();
  env = require("../config/env");
  app = require("../app");
  User = require("../models/User");
  AuditLog = require("../models/AuditLog");
  writeAuditLog = require("../middleware/audit");
  rateLimit = require("../middleware/rateLimit");
  chain = require("../utils/auditChain");
});
afterAll(disconnect);
beforeEach(fresh);
afterEach(() => jest.restoreAllMocks());

const verify = (token, qs = "") => auth(request(app).get(`/api/audit-log/verify${qs}`), token);

// ---------------------------------------------------------------------------
describe("#1 last-admin race", () => {
  test("two admins demoting / deactivating each other concurrently: exactly one wins, one admin remains", async () => {
    const a = await makeUser("admin");
    const b = await makeUser("admin");
    for (let round = 0; round < 5; round += 1) {
      await User.updateMany({ _id: { $in: [a.user._id, b.user._id] } }, { role: "admin", isActive: true });
      const body1 = round % 2 ? { role: "ml_engineer" } : { isActive: false };
      const [r1, r2] = await Promise.all([
        auth(request(app).patch(`/api/users/${b.user._id}`), a.token).send(body1),
        auth(request(app).patch(`/api/users/${a.user._id}`), b.token).send(body1),
      ]);
      expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
      expect(await User.countDocuments({ role: "admin", isActive: { $ne: false } })).toBe(1);
    }
  });

  test("post-update recount reverts and answers 409 when a concurrent change (other instance) removed the last other admin", async () => {
    const a = await makeUser("admin");
    const b = await makeUser("admin");
    const spy = jest.spyOn(User, "countDocuments");
    // 1st call = the pre-check ("others"), 2nd = the post-write recount
    spy.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const res = await auth(request(app).patch(`/api/users/${b.user._id}`), a.token).send({ role: "ml_engineer" });
    expect(res.status).toBe(409);
    spy.mockRestore();
    expect((await User.findById(b.user._id)).role).toBe("admin"); // reverted
    expect(await AuditLog.countDocuments({ action: "update_user" })).toBe(0);
  });

  test("an admin demoted while waiting on the lock cannot act with the stale token", async () => {
    const a = await makeUser("admin");
    const b = await makeUser("admin");
    const c = await makeUser("ml_engineer");
    await User.updateOne({ _id: a.user._id }, { role: "ml_engineer" }); // token still says admin, authGuard re-reads => 403
    const res = await auth(request(app).patch(`/api/users/${c.user._id}`), a.token).send({ role: "admin" });
    expect(res.status).toBe(403);
    expect((await User.findById(c.user._id)).role).toBe("ml_engineer");
    expect(b).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe("#2 audit chain and lone surrogates / #9 multi-writer", () => {
  test("login with a lone surrogate in the email leaves the chain valid", async () => {
    const admin = await makeUser("admin");
    jest.spyOn(console, "error").mockImplementation(() => {});
    const r = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email":"x\\ud800y@z.com","password":"badpassword"}');
    expect(r.status).toBe(401);
    const row = await AuditLog.findOne({ action: "login_failed" }).lean();
    expect(row.details).toBe("Failed login for x�y@z.com");
    const v = await verify(admin.token);
    expect(v.body.ok).toBe(true);
    expect(v.body.checked).toBeGreaterThan(0);
  });

  test("wellFormed replaces lone surrogates, keeps valid pairs", () => {
    expect(chain.wellFormed("a\ud800b")).toBe("a�b");
    expect(chain.wellFormed("a\udc00b")).toBe("a�b");
    expect(chain.wellFormed("ok 😀")).toBe("ok 😀");
    expect(chain.wellFormed("\ud83d")).toBe("�");
  });

  test("verify keeps going past the first break and reports brokenSeqs (capped at 50, first in brokenAtSeq)", async () => {
    for (let i = 0; i < 60; i += 1) await writeAuditLog({ actor: null, action: "login_failed", targetType: "User", details: `r${i}` });
    const admin = await makeUser("admin");
    await writeAuditLog({ actor: admin.user, action: "login", targetType: "User", details: "x" });
    await raw().updateMany({ seq: { $gte: 5, $lte: 59 } }, { $set: { details: "tampered" } }); // 55 rows
    const v = await verify(admin.token);
    expect(v.body.ok).toBe(false);
    expect(v.body.brokenAtSeq).toBe(5);
    expect(v.body.brokenSeqs).toHaveLength(50);
    expect(v.body.brokenSeqs.slice(0, 3)).toEqual([5, 6, 7]);
    expect(v.body.brokenCount).toBe(55);
    expect(v.body.checked).toBe(61);
  });

  test("30 parallel appendEntry writers (other-instance race): no lost rows, chain verifies", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        writeAuditLog.appendEntry({ actorName: "w", actorRole: "none", action: "login_failed", targetType: "User", details: `w${i}` })
      )
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await AuditLog.countDocuments()).toBe(30);
    const v = await chain.verifyChain(AuditLog);
    expect(v).toMatchObject({ ok: true, checked: 30 });
  });

  test("writeAuditLog never throws, and logs a loud LOST AUDIT ENTRY when every retry fails", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const create = jest.spyOn(AuditLog, "create").mockRejectedValue(Object.assign(new Error("E11000 dup"), { code: 11000 }));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(writeAuditLog({ actor: null, action: "login_failed", targetType: "User", details: "d" })).resolves.toBeUndefined();
    expect(create.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(errSpy.mock.calls[0][0]).toMatch(/LOST AUDIT ENTRY action=login_failed targetType=User/);
  });
});

// ---------------------------------------------------------------------------
describe("#3 audit scoping", () => {
  test("a user NAMED 'anonymous' does not see anonymous login_failed rows", async () => {
    await request(app).post("/api/auth/login").send({ email: "victim@x.com", password: "whatever1" });
    for (const name of ["anonymous", "Anonymous "]) {
      const spy = await makeUser("ml_engineer", { name });
      const res = await auth(request(app).get("/api/audit-log"), spy.token);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    }
    const comp = await makeUser("compliance_officer");
    expect((await auth(request(app).get("/api/audit-log"), comp.token)).body.total).toBe(1);
  });

  test("the legacy actorName branch only matches rows with no seq and no actorId (never chained rows of a namesake)", async () => {
    const a = await makeUser("ml_engineer", { name: "Sam Twin" });
    const b = await makeUser("ml_engineer", { name: "Sam Twin" });
    await writeAuditLog({ actor: b.user, action: "login", targetType: "User", targetId: oid(), details: "chained row by namesake" });
    await raw().insertOne({ actorName: "Sam Twin", actorRole: "ml_engineer", action: "login", targetType: "User", details: "true legacy", createdAt: new Date(1) });
    await raw().insertOne({ actorName: "Sam Twin", actorRole: "none", action: "login_failed", targetType: "User", details: "legacy anonymous-role", createdAt: new Date(2) });
    const res = await auth(request(app).get("/api/audit-log"), a.token);
    expect(res.body.logs.map((l) => l.details)).toEqual(["true legacy"]);
  });
});

// ---------------------------------------------------------------------------
describe("#4 keyed chain, head, truncation", () => {
  const KEY = "k".repeat(24);
  afterEach(() => {
    env.auditHmacKey = "";
  });

  test("legacy sha256 rows + hmac rows verify; wrong/removed key fails; downgrade is flagged", async () => {
    const admin = await makeUser("admin");
    await writeAuditLog({ actor: admin.user, action: "login", targetType: "User", details: "sha row 1" });
    await writeAuditLog({ actor: admin.user, action: "login", targetType: "User", details: "sha row 2" });
    env.auditHmacKey = KEY;
    await writeAuditLog({ actor: admin.user, action: "login", targetType: "User", details: "hmac row 3" });
    await writeAuditLog({ actor: admin.user, action: "login", targetType: "User", details: "hmac row 4" });
    expect((await AuditLog.findOne({ seq: 3 }).lean()).hashAlg).toBe("hmac-sha256");
    expect((await AuditLog.findOne({ seq: 1 }).lean()).hashAlg).toBe("sha256");

    let v = await verify(admin.token);
    expect(v.body).toMatchObject({ ok: true, checked: 4, keyed: true, hashAlgs: { sha256: 2, "hmac-sha256": 2 } });

    env.auditHmacKey = "z".repeat(24); // key changed
    v = await verify(admin.token);
    expect(v.body.ok).toBe(false);
    expect(v.body.brokenSeqs).toEqual([3, 4]);

    env.auditHmacKey = ""; // key lost
    v = await verify(admin.token);
    expect(v.body.brokenSeqs).toEqual([3, 4]);

    // downgrade: a forged sha256 row appended after hmac rows
    env.auditHmacKey = KEY;
    const last = await AuditLog.findOne().sort({ seq: -1 }).lean();
    const forged = { seq: 5, prevHash: last.hash, actorName: "x", actorRole: "admin", action: "login", targetType: "User", details: "forged", createdAt: new Date(), hashAlg: "sha256" };
    forged.hash = chain.computeHash(forged, "sha256");
    await raw().insertOne(forged);
    v = await verify(admin.token);
    expect(v.body.ok).toBe(false);
    expect(v.body.brokenSeqs).toEqual([5]);
  });

  test("a keyed hash differs from the unkeyed one for identical content", () => {
    const e = { seq: 1, prevHash: "GENESIS", actorName: "a", actorRole: "admin", action: "login", targetType: "User", details: "d", createdAt: new Date(0) };
    env.auditHmacKey = KEY;
    expect(chain.computeHash(e, "hmac-sha256")).not.toBe(chain.computeHash(e, "sha256"));
  });

  test("verify returns head; expectedHead* detects tail truncation; params validated", async () => {
    const admin = await makeUser("admin");
    for (let i = 0; i < 4; i += 1) await writeAuditLog({ actor: admin.user, action: "login", targetType: "User", details: `r${i}` });
    let v = await verify(admin.token);
    const head = v.body.head;
    expect(head.seq).toBe(4);
    expect(v.body.headMatches).toBeUndefined();

    v = await verify(admin.token, `?expectedHeadSeq=${head.seq}&expectedHeadHash=${head.hash}`);
    expect(v.body.headMatches).toBe(true);

    await writeAuditLog({ actor: admin.user, action: "login", targetType: "User", details: "later" }); // chain grew: still matches
    v = await verify(admin.token, `?expectedHeadSeq=${head.seq}&expectedHeadHash=${head.hash}`);
    expect(v.body).toMatchObject({ ok: true, headMatches: true });

    await raw().deleteMany({ seq: { $gte: 3 } }); // tail truncation: chain is still "ok"
    v = await verify(admin.token, `?expectedHeadSeq=${head.seq}&expectedHeadHash=${head.hash}`);
    expect(v.body.ok).toBe(true);
    expect(v.body.headMatches).toBe(false);

    expect((await verify(admin.token, "?expectedHeadSeq=4")).status).toBe(400);
    expect((await verify(admin.token, "?expectedHeadSeq=abc&expectedHeadHash=zz")).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("#5 rate limiting", () => {
  test("ipKey: IPv4 as is, IPv4-mapped IPv6 collapses, IPv6 masked to /64, junk safe", () => {
    const { ipKey } = rateLimit;
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::ffff:cb00:7109")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(ipKey("2001:DB8:ABCD:12::beef")).toBe("2001:db8:abcd:12::/64");
    expect(ipKey("2001:db8:abcd:12:ffff:ffff:ffff:ffff")).toBe(ipKey("2001:db8:abcd:12::1"));
    expect(ipKey("2001:db8:abcd:13::1")).not.toBe(ipKey("2001:db8:abcd:12::1"));
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("::1")).toBe(ipKey("0:0:0:0:0:0:0:1"));
    expect(ipKey(undefined)).toBe("unknown");
  });

  test("emailKey normalizes (trim, lowercase, cap) and rejects non-strings", () => {
    const { emailKey } = rateLimit;
    expect(emailKey("  Bob@X.com ")).toBe("bob@x.com");
    expect(emailKey({ $gt: "" })).toBeNull();
    expect(emailKey("   ")).toBeNull();
    expect(emailKey("a".repeat(1000))).toHaveLength(254);
  });

  function miniApp(limiter) {
    const mini = express();
    mini.set("trust proxy", true);
    mini.use(express.json());
    mini.post("/l", limiter, (req, res) => res.status(req.body.ok ? 200 : 401).json({}));
    return mini;
  }
  const attempt = (mini, ip, email, ok = false) => request(mini).post("/l").set("X-Forwarded-For", ip).send({ email, password: "x", ok });

  test("per-account limiter: rotating IPs / email casing does not buy more guesses; other accounts unaffected; successes not counted", async () => {
    const mini = miniApp(rateLimit.createLoginLimiter({ maxFailures: 100, maxAccountFailures: 3 }));
    expect((await attempt(mini, "10.0.0.1", "Target@x.com")).status).toBe(401);
    expect((await attempt(mini, "10.0.0.2", " target@X.com ")).status).toBe(401);
    expect((await attempt(mini, "10.0.0.3", "TARGET@x.com")).status).toBe(401);
    const blocked = await attempt(mini, "10.0.0.4", "target@x.com");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((await attempt(mini, "10.0.0.4", "someone-else@x.com")).status).toBe(401);
    // successes don't count against an account
    for (let i = 0; i < 6; i += 1) expect((await attempt(mini, "10.0.0.9", "fine@x.com", true)).status).toBe(200);
  });

  test("unknown emails are counted exactly like known ones (not an existence oracle)", async () => {
    const real = await makeUser("ml_engineer");
    // the account limiter alone, behind a mini app that trusts X-Forwarded-For
    const acct = rateLimit.createAccountLoginLimiter({ maxAccountFailures: 4 });
    const mini = miniApp(acct);
    const run = async (email) => {
      const s = [];
      for (let i = 0; i < 6; i += 1) s.push((await attempt(mini, `10.2.0.${i}`, email)).status);
      return s;
    };
    expect(await run(real.user.email)).toEqual([401, 401, 401, 401, 429, 429]);
    expect(await run("nobody-here@x.com")).toEqual([401, 401, 401, 401, 429, 429]);
  });

  test("malformed login bodies (non-string email) fall back to the IP bucket", async () => {
    const mini = miniApp(rateLimit.createAccountLoginLimiter({ maxAccountFailures: 2 }));
    expect((await attempt(mini, "10.3.0.1", { $gt: "" })).status).toBe(401);
    expect((await attempt(mini, "10.3.0.1", { $gt: "" })).status).toBe(401);
    expect((await attempt(mini, "10.3.0.1", { $gt: "" })).status).toBe(429);
    expect((await attempt(mini, "10.3.0.2", { $gt: "" })).status).toBe(401); // different IP, different bucket
  });

  test("IPv6 clients in one /64 share an IP bucket", async () => {
    const mini = miniApp(rateLimit.createIpLoginLimiter({ maxFailures: 2 }));
    expect((await attempt(mini, "2001:db8:1:2::1", "a@x.com")).status).toBe(401);
    expect((await attempt(mini, "2001:db8:1:2:aaaa::2", "b@x.com")).status).toBe(401);
    expect((await attempt(mini, "2001:db8:1:2:ffff:ffff:ffff:ffff", "c@x.com")).status).toBe(429);
    expect((await attempt(mini, "2001:db8:1:3::1", "c@x.com")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("#6 bcrypt 72-byte limit", () => {
  const base = { name: "n", role: "ml_engineer" };
  test("signup rejects > 72 bytes (even if <= 128 chars) with a clear message; accepts exactly 72 bytes", async () => {
    const tooLong = "é".repeat(37); // 37 chars, 74 bytes
    let res = await request(app).post("/api/auth/signup").send({ ...base, email: "long1@x.com", password: tooLong });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password must be at most 72 bytes/);
    res = await request(app).post("/api/auth/signup").send({ ...base, email: "long2@x.com", password: "A".repeat(73) });
    expect(res.status).toBe(400);
    res = await request(app).post("/api/auth/signup").send({ ...base, email: "ok72@x.com", password: "é".repeat(36) });
    expect(res.status).toBe(201);
    res = await request(app).post("/api/auth/signup").send({ ...base, email: "short@x.com", password: "short" });
    expect(res.body.error).toMatch(/at least 8/);
  });

  test("POST /api/users rejects > 72 bytes", async () => {
    const admin = await makeUser("admin");
    const res = await auth(request(app).post("/api/users"), admin.token).send({ ...base, email: "u@x.com", password: "A".repeat(73) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/72 bytes/);
    const ok = await auth(request(app).post("/api/users"), admin.token).send({ ...base, email: "u@x.com", password: "A".repeat(72) });
    expect(ok.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
describe("#7 / #10 / #15 env validation", () => {
  const MANAGED = [
    "NODE_ENV", "JWT_SECRET", "JWT_EXPIRES_IN", "MONGO_URI", "METRICS_SHARED_SECRET", "METRICS_SERVICE_URL", "ADMIN_INVITE_CODE",
    "COMPLIANCE_INVITE_CODE", "TRUST_PROXY", "CLIENT_ORIGIN", "ALLOW_MODEL_FILES", "LOGIN_MAX_FAILURES", "LOGIN_ACCOUNT_MAX_FAILURES",
    "LOGIN_WINDOW_MINUTES", "SIGNUP_MAX_PER_HOUR", "API_MAX_PER_MINUTE", "PORT", "AUDIT_HMAC_KEY", "ENABLE_DRIFT_SIMULATION",
    "METRICS_TIMEOUT_MS", "METRICS_WAKE_TIMEOUT_MS", "MAX_UPLOAD_MB", "RETENTION_DAYS",
  ];
  const GOOD_PROD = {
    NODE_ENV: "production",
    JWT_SECRET: "Zq8vK2mXp9LrT4wYb7NcD1fHj6GsA3eU5oIiPxRt",
    MONGO_URI: "mongodb+srv://u:p@cluster0.abcde.mongodb.net/modelward",
    METRICS_SHARED_SECRET: "m3tr1c5-shared-9f8e7d6c5b4a",
    METRICS_SERVICE_URL: "https://modelward-metrics.onrender.com",
    ADMIN_INVITE_CODE: "",
    COMPLIANCE_INVITE_CODE: "",
    TRUST_PROXY: "",
    CLIENT_ORIGIN: "https://app.modelward.dev",
    ALLOW_MODEL_FILES: "",
    LOGIN_MAX_FAILURES: "", LOGIN_ACCOUNT_MAX_FAILURES: "", LOGIN_WINDOW_MINUTES: "", SIGNUP_MAX_PER_HOUR: "", API_MAX_PER_MINUTE: "",
    PORT: "", AUDIT_HMAC_KEY: "", ENABLE_DRIFT_SIMULATION: "", JWT_EXPIRES_IN: "",
    METRICS_TIMEOUT_MS: "", METRICS_WAKE_TIMEOUT_MS: "", MAX_UPLOAD_MB: "", RETENTION_DAYS: "",
  };

  // Loads a fresh config/env.js with `vars` applied ("" = unset; dotenv never overrides a set value).
  function load(vars) {
    const saved = {};
    MANAGED.forEach((k) => { saved[k] = process.env[k]; });
    Object.assign(process.env, vars);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let fresh, result;
    try {
      jest.isolateModules(() => {
        fresh = require("../config/env");
      });
      try {
        fresh.validateEnv();
        result = { ok: true, message: "" };
      } catch (err) {
        result = { ok: false, message: err.message };
      }
    } finally {
      MANAGED.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
      warn.mockRestore();
    }
    return { env: fresh, ...result };
  }
  const prod = (over = {}) => load({ ...GOOD_PROD, ...over });

  test("a good production config passes; NODE_ENV is lowercased", () => {
    expect(prod().ok).toBe(true);
    const r = prod({ NODE_ENV: "Production" });
    expect(r.env.isProd).toBe(true);
    expect(r.env.nodeEnv).toBe("production");
    expect(r.ok).toBe(true);
  });

  test("unknown NODE_ENV is a problem", () => {
    const r = prod({ NODE_ENV: "prod" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/NODE_ENV "prod"/);
  });

  test("production JWT secret: placeholders and low-entropy values rejected", () => {
    for (const secret of ["replace-with-a-long-random-string-at-least-32-chars", "my-super-secret-value-aaaaaaaaaaaaaaaa", "please-change_me-now-0123456789abcdef", "a".repeat(40), "ab".repeat(20), "short"]) {
      const r = prod({ JWT_SECRET: secret });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/JWT_SECRET/);
    }
    // the same placeholder is fine (with a warning) outside production
    expect(load({ ...GOOD_PROD, NODE_ENV: "development", JWT_SECRET: "replace-with-a-long-random-string-at-least-32-chars", MONGO_URI: "mongodb://127.0.0.1/x" }).ok).toBe(true);
  });

  test("invite codes: production needs >= 16 chars and no placeholder; dev only warns", () => {
    expect(prod({ ADMIN_INVITE_CODE: "short-code" }).message).toMatch(/ADMIN_INVITE_CODE must be at least 16/);
    expect(prod({ COMPLIANCE_INVITE_CODE: "change-me-compliance-invite" }).message).toMatch(/COMPLIANCE_INVITE_CODE looks like a placeholder/);
    expect(prod({ ADMIN_INVITE_CODE: "Xk29-QwErTy-77aZ-pLm4" }).ok).toBe(true);
    // development: a short code is only a warning
    expect(load({ ...GOOD_PROD, NODE_ENV: "development", MONGO_URI: "mongodb://127.0.0.1/x", ADMIN_INVITE_CODE: "abc" }).ok).toBe(true);
  });

  test("localhost detection covers [::1], ::1, 0.0.0.0, 127.0.0.1, localhost (not other IPv6)", () => {
    for (const uri of ["mongodb://[::1]:27017/x", "mongodb://0.0.0.0/x", "mongodb://127.0.0.1/x", "mongodb://localhost/x", "mongodb://::1/x"]) {
      expect(prod({ MONGO_URI: uri }).message).toMatch(/MONGO_URI points at localhost/);
    }
    expect(prod({ MONGO_URI: "mongodb://[2001:db8::1]:27017/x" }).ok).toBe(true);
  });

  test("production requires a non-localhost METRICS_SERVICE_URL", () => {
    expect(prod({ METRICS_SERVICE_URL: "" }).message).toMatch(/METRICS_SERVICE_URL is required/);
    expect(prod({ METRICS_SERVICE_URL: "http://localhost:8000" }).message).toMatch(/METRICS_SERVICE_URL points at localhost/);
    expect(prod({ METRICS_SERVICE_URL: "http://[::1]:8000" }).message).toMatch(/METRICS_SERVICE_URL points at localhost/);
  });

  test("JWT_EXPIRES_IN: seconds or number + s/m/h/d; bare digits become a number (seconds)", () => {
    expect(prod({ JWT_EXPIRES_IN: "12h" }).env.jwtExpiresIn).toBe("12h");
    expect(prod({ JWT_EXPIRES_IN: "3600" }).env.jwtExpiresIn).toBe(3600);
    expect(prod({ JWT_EXPIRES_IN: "7d" }).ok).toBe(true);
    for (const bad of ["abc", "12 hours", "-5", "0", "1.5h", "h"]) {
      const r = prod({ JWT_EXPIRES_IN: bad });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/JWT_EXPIRES_IN/);
    }
    // and the converted value is really usable by jsonwebtoken
    const { exp, iat } = jwt.decode(jwt.sign({}, "k", { expiresIn: prod({ JWT_EXPIRES_IN: "3600" }).env.jwtExpiresIn }));
    expect(exp - iat).toBe(3600);
  });

  test("numeric limits must be integers >= 1; ALLOW_MODEL_FILES must be a boolean word", () => {
    for (const name of ["LOGIN_MAX_FAILURES", "LOGIN_ACCOUNT_MAX_FAILURES", "LOGIN_WINDOW_MINUTES", "SIGNUP_MAX_PER_HOUR", "API_MAX_PER_MINUTE", "MAX_UPLOAD_MB"]) {
      for (const bad of ["0", "abc", "-1", "1.5", "10s"]) {
        const r = prod({ [name]: bad });
        expect(r.ok).toBe(false);
        expect(r.message).toContain(name);
      }
      expect(prod({ [name]: "7" }).ok).toBe(true);
    }
    expect(prod({ METRICS_WAKE_TIMEOUT_MS: "0" }).ok).toBe(true);
    expect(prod({ ALLOW_MODEL_FILES: "maybe" }).message).toMatch(/ALLOW_MODEL_FILES must be/);
    expect(prod({ ALLOW_MODEL_FILES: "false" }).env.allowModelFiles).toBe(false);
    expect(prod({ ALLOW_MODEL_FILES: "TRUE" }).env.allowModelFiles).toBe(true);
    // a bad value must not crash require(): the fallback is used
    expect(prod({ LOGIN_MAX_FAILURES: "abc" }).env.loginMaxFailures).toBe(10);
  });

  test("TRUST_PROXY parsing: true/false/number/'loopback'/CIDR list; invalid reported, never thrown at require time", () => {
    expect(prod({ TRUST_PROXY: "true" }).env.trustProxy).toBe(true);
    expect(prod({ TRUST_PROXY: "FALSE" }).env.trustProxy).toBe(false);
    expect(prod({ TRUST_PROXY: "1" }).env.trustProxy).toBe(1);
    expect(prod({ TRUST_PROXY: "loopback" }).env.trustProxy).toBe("loopback");
    expect(prod({ TRUST_PROXY: "10.0.0.0/8, loopback" }).ok).toBe(true);
    for (const bad of ["definitely-not-a-proxy", "10.0.0.0/99", "999.1.1.1"]) {
      const r = prod({ TRUST_PROXY: bad });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/TRUST_PROXY/);
      expect(r.env.trustProxy).toBe(false);
    }
    // the express app accepts whatever env produced
    expect(() => express().set("trust proxy", prod({ TRUST_PROXY: "loopback" }).env.trustProxy)).not.toThrow();
  });

  test("CLIENT_ORIGIN entries are normalized; invalid entries are problems", () => {
    const r = prod({ CLIENT_ORIGIN: " HTTPS://App.Example.COM/ , http://localhost:5173/,https://x.dev:443" });
    expect(r.env.clientOrigins).toEqual(["https://app.example.com", "http://localhost:5173", "https://x.dev"]);
    expect(prod({ CLIENT_ORIGIN: "https://ok.dev, *" }).message).toMatch(/CLIENT_ORIGIN entry "\*"/);
    expect(prod({ CLIENT_ORIGIN: "https://ok.dev/path" }).ok).toBe(false);
    expect(env.normalizeOrigin("null")).toBeNull();
    expect(env.normalizeOrigin("ftp://x.com")).toBeNull();
  });

  test("production warning about CLIENT_ORIGIN states that a Vercel rewrite still sends the Vercel Origin", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const saved = {};
    MANAGED.forEach((k) => { saved[k] = process.env[k]; });
    Object.assign(process.env, { ...GOOD_PROD, CLIENT_ORIGIN: "" });
    try {
      let fresh;
      jest.isolateModules(() => { fresh = require("../config/env"); });
      fresh.validateEnv();
    } finally {
      MANAGED.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    }
    const text = warn.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toMatch(/Vercel domain on POST\/PUT\/DELETE/);
    expect(text).not.toMatch(/fine only if you proxy/);
  });
});

describe("#15 CORS origin comparison", () => {
  test("request Origin and CLIENT_ORIGIN are compared in canonical form", async () => {
    const saved = env.clientOrigins;
    env.clientOrigins = [env.normalizeOrigin("HTTPS://App.Example.com/")];
    try {
      let res = await request(app).get("/api/config").set("Origin", "https://app.example.com");
      expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
      res = await request(app).get("/api/config").set("Origin", "https://APP.example.com/");
      expect(res.status).toBe(200);
      jest.spyOn(console, "error").mockImplementation(() => {});
      res = await request(app).get("/api/config").set("Origin", "https://evil.example.com");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      env.clientOrigins = saved;
    }
  });
});

// ---------------------------------------------------------------------------
describe("#8 authGuard error mapping", () => {
  test("database errors give 503 (and are logged), bad tokens give 401", async () => {
    const eng = await makeUser("ml_engineer");
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const orig = User.findById;
    User.findById = () => { throw new Error("MongoNetworkError simulated"); };
    let r;
    try {
      r = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${eng.token}`);
    } finally {
      User.findById = orig;
    }
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "Service temporarily unavailable" });
    expect(errSpy).toHaveBeenCalled();

    const get = (tok) => request(app).get("/api/auth/me").set("Authorization", `Bearer ${tok}`);
    expect((await get(jwt.sign({ sub: "abc" }, env.jwtSecret))).status).toBe(401); // CastError
    expect((await get(jwt.sign({ sub: { $ne: 1 } }, env.jwtSecret))).status).toBe(401);
    expect((await get(jwt.sign({ sub: String(eng.user._id) }, env.jwtSecret, { expiresIn: -10 }))).status).toBe(401);
    expect((await get(jwt.sign({ sub: String(eng.user._id) }, "wrong-secret-wrong-secret-wrong-secret"))).status).toBe(401);
    expect((await get(jwt.sign({ sub: String(eng.user._id) }, env.jwtSecret, { algorithm: "HS512" }))).status).toBe(401);
    expect((await get(eng.token)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("#18 settings thresholds / #19 Cache-Control", () => {
  const base = { lowAccuracy: 0.9, lowFairnessGap: 0.1, mediumAccuracy: 0.7, mediumFairnessGap: 0.2, driftThreshold: 0.1 };
  test("each threshold must be within [0.001, 1]", async () => {
    const admin = await makeUser("admin");
    const put = (b) => auth(request(app).put("/api/settings"), admin.token).send(b);
    for (const key of Object.keys(base)) {
      for (const bad of [0, 0.0005, 1e-320, 1.0001, -0.5]) {
        const res = await put({ ...base, [key]: bad });
        expect(res.status).toBe(400);
        expect(res.body.fields[key]).toBeDefined();
      }
    }
    expect((await put({ ...base, driftThreshold: 0.001 })).status).toBe(200);
    expect((await put({ ...base, lowAccuracy: 1 })).status).toBe(200);
  });

  test("all /api responses (success, 401, 404, csv export) carry Cache-Control: no-store", async () => {
    expect((await request(app).get("/api/config")).headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/users")).headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/nope")).headers["cache-control"]).toBe("no-store");
    const admin = await makeUser("admin");
    expect((await auth(request(app).get("/api/audit-log/export"), admin.token)).headers["cache-control"]).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
describe("#11 softDelete plugin", () => {
  const softDelete = require("../utils/softDelete");
  let Thing;
  beforeAll(() => {
    const schema = new mongoose.Schema({ name: String });
    schema.plugin(softDelete);
    Thing = mongoose.models.HardeningThing || mongoose.model("HardeningThing", schema);
  });
  let live, dead;
  beforeEach(async () => {
    await Thing.deleteMany({});
    live = await Thing.create({ name: "live" });
    dead = await Thing.create({ name: "dead" });
    await dead.softDelete({ reason: "test" });
  });

  test("mentionsIsDeleted scans $and/$or/$nor recursively, nothing else", () => {
    const m = softDelete.mentionsIsDeleted;
    expect(m({ isDeleted: true })).toBe(true);
    expect(m({ $or: [{ name: "a" }, { isDeleted: true }] })).toBe(true);
    expect(m({ $and: [{ $or: [{ $nor: [{ isDeleted: false }] }] }] })).toBe(true);
    expect(m({ name: "a", $or: [{ x: 1 }] })).toBe(false);
    expect(m({ $or: "not-an-array" })).toBe(false);
    expect(m({ tags: { isDeleted: true } })).toBe(false); // nested non-logical key is not the field
    expect(m(null)).toBe(false);
  });

  test("default queries hide deleted docs; explicit isDeleted anywhere in $and/$or/$nor opts out", async () => {
    expect((await Thing.find()).map((t) => t.name)).toEqual(["live"]);
    expect(await Thing.countDocuments()).toBe(1);
    expect((await Thing.find({ $or: [{ isDeleted: true }] })).map((t) => t.name)).toEqual(["dead"]);
    expect((await Thing.find({ $and: [{ isDeleted: true }] })).map((t) => t.name)).toEqual(["dead"]);
    expect((await Thing.find({ $nor: [{ isDeleted: true }] })).map((t) => t.name)).toEqual(["live"]);
    expect(await Thing.find({ $and: [{ $or: [{ isDeleted: { $in: [true, false] } }] }] })).toHaveLength(2);
    expect(await Thing.find().setOptions({ includeDeleted: true })).toHaveLength(2);
  });

  test("replaceOne is hooked: it cannot replace a soft-deleted document unless opted in", async () => {
    let r = await Thing.replaceOne({ _id: dead._id }, { name: "replaced", isDeleted: true });
    expect(r.matchedCount).toBe(0);
    r = await Thing.replaceOne({ _id: dead._id }, { name: "replaced", isDeleted: true }).setOptions({ includeDeleted: true });
    expect(r.matchedCount).toBe(1);
    r = await Thing.replaceOne({ _id: live._id }, { name: "live2" });
    expect(r.matchedCount).toBe(1);
  });

  test("estimatedDocumentCount is not hooked (documented: ignores filters, counts deleted docs)", async () => {
    expect(await Thing.estimatedDocumentCount()).toBe(2);
    expect(await Thing.countDocuments()).toBe(1);
  });
});
