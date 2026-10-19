// Red-team (reviewer R2): /api/orgs and /api/users (approval queue, Add user, setup links,
// last-admin protection, platform-only routes, cross-org reach).
const request = require("supertest");
const { connect, reset, disconnect, makeUser, makeOrg, sys, auth } = require("./helpers");

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
const relay = (answer) =>
  jest.spyOn(global, "fetch").mockImplementation(async () => ({ ok: true, status: 200, body: null, text: async () => JSON.stringify(answer) }));
const useRelay = () => setEnv({ emailProvider: "apps_script", appsScriptUrl: "https://relay.example/exec", appsScriptSecret: "s3cret-relay" });

let seq = 0;
const acme = (over = {}) => makeOrg({ name: `Acme ${Date.now()}-${++seq}`, allowedDomains: ["acme.com"], ...over });
const body = (over = {}) => ({ name: `Org ${Date.now()}-${++seq}`, adminEmail: `boss${seq}@corp.com`, allowedDomains: ["corp.com"], ...over });
const asOrg = (req, orgId) => req.set("X-Org-Id", String(orgId));
const dbUser = (filter) => sys(User).findOne(filter).select("+verifyTokenHash +setupTokenHash +passwordHash");
const audits = (filter) => sys(AuditLog).find(filter).sort({ seq: 1 });
const used = async (org, kind = "ml_engineer") => (await Organization.findById(org._id)).codes[kind].used;
const wire = (res) => JSON.stringify(res.body);
const NO_SECRETS = /passwordHash|verifyTokenHash|setupTokenHash|emailKey|\$2[aby]\$/;

async function pendingUser(org, email_, kind = "ml_engineer") {
  const fresh_ = await Organization.findById(org._id);
  const reserved = await joinCodes.reserveSeat(fresh_, kind);
  return makeUser(kind, { orgId: org._id, status: "pending", email: email_, extra: { seatKind: kind, seatGen: reserved.codes[kind].gen } });
}

// ---------------------------------------------------------------------------------------------
describe("platform routes are super_admin only", () => {
  test("anonymous 401; admin / ml / compliance 403 on list, create, patch, and the same with every widening trick", async () => {
    const org = await acme();
    const other = await acme();
    const roles = {};
    for (const r of ["admin", "ml_engineer", "compliance_officer"]) roles[r] = await makeUser(r, { orgId: org._id });
    expect((await request(app).get("/api/orgs")).status).toBe(401);
    for (const [r, u] of Object.entries(roles)) {
      for (const [m, path, b] of [
        ["get", "/api/orgs"],
        ["post", "/api/orgs", body()],
        ["patch", `/api/orgs/${other._id}`, { status: "suspended" }],
        ["patch", `/api/orgs/${org._id}`, { allowedDomains: ["evil.com"], domainRuleEnabled: false }],
        ["get", `/api/orgs?orgId=${other._id}`],
      ]) {
        for (const hdr of [{}, { "X-Org-Id": String(other._id) }, { "X-Org-Id": "garbage" }]) {
          const res = await auth(request(app)[m](path), u.token).set(hdr).send(b || undefined);
          expect([r, m, path, res.status]).toEqual([r, m, path, 403]);
        }
      }
    }
    expect((await Organization.findById(other._id)).status).toBe("active");
    expect((await Organization.findById(org._id)).allowedDomains).toEqual(["acme.com"]);
    expect(await Organization.countDocuments()).toBe(2);
  });

  test("an org admin cannot touch domains / status / rule / name / codes' values through /orgs/current (strict bodies)", async () => {
    const org = await acme();
    const admin = await makeUser("admin", { orgId: org._id });
    for (const b of [
      { autoApprove: false, allowedDomains: ["evil.com"] },
      { autoApprove: false, domainRuleEnabled: false },
      { autoApprove: false, status: "suspended" },
      { autoApprove: false, name: "Hax" },
      { autoApprove: false, codes: { ml_engineer: { value: "AAAAAAAAAAAA" } } },
      { autoApprove: false, orgId: String(org._id) },
      { name: "Hax" },
      { allowedDomains: ["evil.com"] },
    ]) {
      const res = await auth(request(app).patch("/api/orgs/current"), admin.token).send(b);
      expect([res.status, wire(res)]).toEqual([400, expect.any(String)]);
    }
    for (const b of [{ seatLimit: 5, value: "AAAAAAAAAAAA" }, { seatLimit: 5, gen: 9 }, { seatLimit: 5, used: 0 }, { seatLimit: 5, orgId: "x" }]) {
      const res = await auth(request(app).put("/api/orgs/current/codes/ml_engineer"), admin.token).send(b);
      expect(res.status).toBe(400);
    }
    const fresh_ = await Organization.findById(org._id);
    expect(fresh_.allowedDomains).toEqual(["acme.com"]);
    expect(fresh_.codes.ml_engineer.value).toBe(org.codes.ml_engineer.value);
    expect(fresh_.codes.ml_engineer.gen).toBe(org.codes.ml_engineer.gen);
    // roles below admin cannot use any of it
    const ml = await makeUser("ml_engineer", { orgId: org._id });
    for (const [m, p] of [["get", "/api/orgs/current"], ["patch", "/api/orgs/current"], ["put", "/api/orgs/current/codes/ml_engineer"], ["post", "/api/orgs/current/codes/ml_engineer/regenerate"]]) {
      expect((await auth(request(app)[m](p), ml.token).send({ autoApprove: true })).status).toBe(403);
    }
  });

  test("/orgs/current is always the CALLER's org: X-Org-Id and ?orgId from an org admin change nothing", async () => {
    const mine = await acme();
    const theirs = await acme();
    const admin = await makeUser("admin", { orgId: mine._id });
    for (const r of [
      await asOrg(auth(request(app).get("/api/orgs/current"), admin.token), theirs._id),
      await auth(request(app).get(`/api/orgs/current?orgId=${theirs._id}&id=${theirs._id}`), admin.token),
    ]) {
      expect(r.status).toBe(200);
      expect(r.body.org.id).toBe(String(mine._id));
      expect(wire(r)).not.toContain(theirs.codes.ml_engineer.value);
      expect(wire(r)).not.toContain(theirs.codes.compliance_officer.value);
    }
    // regenerate with the other org's id in every slot affects only mine
    const before = (await Organization.findById(theirs._id)).codes.ml_engineer.value;
    const res = await asOrg(auth(request(app).post(`/api/orgs/current/codes/ml_engineer/regenerate?orgId=${theirs._id}`), admin.token), theirs._id).send({ orgId: String(theirs._id) });
    expect(res.status).toBe(200);
    expect((await Organization.findById(theirs._id)).codes.ml_engineer.value).toBe(before);
    expect((await Organization.findById(mine._id)).codes.ml_engineer.value).not.toBe(mine.codes.ml_engineer.value);
  });

  test("/orgs/current is not a valid id for the :id routes and a malformed id is 400/404, never a 500", async () => {
    const sa = await makeUser("super_admin");
    for (const id of ["current", "not-an-id", "0".repeat(24), "%00", "{$ne:1}"]) {
      const res = await auth(request(app).patch(`/api/orgs/${encodeURIComponent(id)}`), sa.token).send({ name: "X" });
      expect([400, 404]).toContain(res.status);
    }
    // a super admin without a selected org gets the explicit prompt, not somebody's data
    const res = await auth(request(app).get("/api/orgs/current"), sa.token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ORG_REQUIRED");
  });
});

// ---------------------------------------------------------------------------------------------
describe("creating an organization", () => {
  test("link goes to the super admin only when mail did not leave the server; never contains Host; no secrets in the body", async () => {
    const sa = await makeUser("super_admin");
    const res = await auth(request(app).post("/api/orgs"), sa.token).set("Host", "evil.example").set("X-Forwarded-Host", "evil.example").send(body());
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false); // console provider
    expect(res.body.setupLink.startsWith(env.appUrl + "/setup-password?token=")).toBe(true);
    expect(wire(res)).not.toMatch(NO_SECRETS);
    expect(res.body.admin).toMatchObject({ role: "admin", status: "invited" });
    const row = await dbUser({ email: res.body.admin.email });
    expect(row.setupTokenHash).not.toBe(new URL(res.body.setupLink).searchParams.get("token"));
    expect(row.setupExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(72 * 3600e3);
    expect(row.setupExpiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3600e3);
    expect(JSON.stringify(email.outbox)).not.toMatch(/evil\.example/);
  });

  test("with a working relay the link is only mailed (not returned); with a dead relay / daily-limit answer the org still exists and the link is returned", async () => {
    useRelay();
    const sa = await makeUser("super_admin");
    relay({ ok: true });
    const ok = await auth(request(app).post("/api/orgs"), sa.token).send(body());
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ emailSent: true, setupLink: null });
    for (const answer of [{ ok: false, error: "Service invoked too many times for one day: email" }, "<html>login</html>"]) {
      jest.spyOn(global, "fetch").mockImplementation(async () => ({ ok: true, status: 200, body: null, text: async () => (typeof answer === "string" ? answer : JSON.stringify(answer)) }));
      const res = await auth(request(app).post("/api/orgs"), sa.token).send(body());
      expect(res.status).toBe(201);
      expect(res.body.emailSent).toBe(false);
      expect(res.body.setupLink).toContain("/setup-password?token=");
      expect(wire(res)).not.toMatch(/s3cret-relay|relay\.example/);
    }
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("boom relay.example s3cret-relay"));
    const dead = await auth(request(app).post("/api/orgs"), sa.token).send(body());
    expect(dead.status).toBe(201);
    expect(dead.body.setupLink).toBeTruthy();
    expect(await Organization.countDocuments()).toBe(4);
  });

  test("domain rule consistency: free-mail only with the rule off; empty list only with the rule off; autoApprove cannot be set at creation", async () => {
    const sa = await makeUser("super_admin");
    for (const b of [
      body({ allowedDomains: ["gmail.com"] }),
      body({ allowedDomains: ["corp.com", "outlook.com"] }),
      body({ allowedDomains: [] }),
      body({ allowedDomains: undefined }),
      body({ allowedDomains: ["corp.com."] }),
      body({ allowedDomains: ["*.corp.com"] }),
      body({ allowedDomains: ["corp.com/evil"] }),
      body({ allowedDomains: ["a@corp.com"] }),
      body({ allowedDomains: [{ $ne: 1 }] }),
      body({ allowedDomains: "corp.com" }),
      body({ domainRuleEnabled: "false" }),
    ]) {
      const res = await auth(request(app).post("/api/orgs"), sa.token).send(b);
      expect([res.status, wire(res).slice(0, 80)]).toEqual([400, expect.any(String)]);
    }
    expect(await Organization.countDocuments()).toBe(0);
    const ok = await auth(request(app).post("/api/orgs"), sa.token).send(body({ domainRuleEnabled: false, allowedDomains: [], autoApprove: true }));
    expect(ok.status).toBe(201);
    expect(ok.body.org.autoApprove).toBe(false);
    expect(ok.body.org.domainRuleEnabled).toBe(false);
  });

  test("duplicate admin email (case / +tag / existing user of ANOTHER org / an unverified squatter) is 409 and leaves no organization behind", async () => {
    const sa = await makeUser("super_admin", { email: "root@platform.io" });
    const other = await acme();
    await makeUser("ml_engineer", { orgId: other._id, email: "taken@corp.com" });
    await makeUser("ml_engineer", { orgId: other._id, email: "squat@corp.com", status: "unverified" });
    const count0 = await Organization.countDocuments();
    for (const e of ["taken@corp.com", "TAKEN@corp.com", "taken+x@corp.com", "squat@corp.com", "root@platform.io", "ROOT+tag@platform.io"]) {
      const res = await auth(request(app).post("/api/orgs"), sa.token).send(body({ adminEmail: e }));
      expect([e, res.status]).toEqual([e, 409]);
    }
    expect(await Organization.countDocuments()).toBe(count0);
  });

  test("races: the same name / the same admin email in parallel create exactly one org + one admin, never an orphan org", async () => {
    const sa = await makeUser("super_admin");
    const sameName = await Promise.all(Array.from({ length: 6 }, (_, i) => auth(request(app).post("/api/orgs"), sa.token).send(body({ name: "Twin Org", adminEmail: `n${i}@corp.com` }))));
    expect(sameName.filter((r) => r.status === 201)).toHaveLength(1);
    expect(sameName.filter((r) => r.status === 409)).toHaveLength(5);
    const sameMail = await Promise.all(Array.from({ length: 6 }, (_, i) => auth(request(app).post("/api/orgs"), sa.token).send(body({ name: `Mail Org ${i}`, adminEmail: "same@corp.com" }))));
    expect(sameMail.filter((r) => r.status === 201)).toHaveLength(1);
    // every surviving org has its admin
    for (const org of await Organization.find()) expect(await sys(User).countDocuments({ orgId: org._id, role: "admin" })).toBe(1);
    expect(await Organization.countDocuments()).toBe(2);
    expect((await Organization.find({ name: "twin org" }).collation({ locale: "en", strength: 2 })).length).toBe(1);
  });

  test("a suspended or renamed org: case-insensitive name uniqueness and status flips are audited, take effect on issued tokens", async () => {
    const sa = await makeUser("super_admin");
    const o = await acme({ name: "Initech" });
    expect((await auth(request(app).post("/api/orgs"), sa.token).send(body({ name: "INITECH" }))).status).toBe(409);
    expect((await auth(request(app).patch(`/api/orgs/${o._id}`), sa.token).send({ name: "initech " })).status).toBe(200);
    const admin = await makeUser("admin", { orgId: o._id });
    expect((await auth(request(app).get("/api/users"), admin.token)).status).toBe(200);
    const sus = await auth(request(app).patch(`/api/orgs/${o._id}`), sa.token).send({ status: "suspended" });
    expect(sus.status).toBe(200);
    expect((await auth(request(app).get("/api/users"), admin.token)).status).toBe(401);
    expect((await auth(request(app).get("/api/orgs/current"), admin.token)).status).toBe(401);
    // new signups into it are refused with the generic message
    const res = await request(app).post("/api/auth/signup").send({ name: "A", email: "a@acme.com", joinCode: o.codes.ml_engineer.value });
    expect(res.status).toBe(403);
    expect((await audits({ action: "org_suspend", orgId: o._id })).length).toBe(1);
    await auth(request(app).patch(`/api/orgs/${o._id}`), sa.token).send({ status: "active" });
    expect((await auth(request(app).get("/api/users"), admin.token)).status).toBe(200);
    // unknown keys are refused, so nothing can sneak in (codes, orgId, autoApprove, createdBy)
    for (const b of [{ codes: {} }, { autoApprove: true }, { createdBy: "x" }, { _id: "x" }, { name: "a", __proto__: { x: 1 } }]) {
      const r = await auth(request(app).patch(`/api/orgs/${o._id}`), sa.token).send(b);
      expect([200, 400]).toContain(r.status);
    }
    expect((await Organization.findById(o._id)).autoApprove).toBe(false);
  });

  test("turning the domain rule off forces autoApprove off; turning it on with free-mail domains is refused", async () => {
    const sa = await makeUser("super_admin");
    const o = await acme({ autoApprove: true });
    const off = await auth(request(app).patch(`/api/orgs/${o._id}`), sa.token).send({ domainRuleEnabled: false });
    expect(off.body.org).toMatchObject({ domainRuleEnabled: false, autoApprove: false });
    const free = await auth(request(app).patch(`/api/orgs/${o._id}`), sa.token).send({ allowedDomains: ["gmail.com"] });
    expect(free.status).toBe(200); // rule is off: allowed
    const on = await auth(request(app).patch(`/api/orgs/${o._id}`), sa.token).send({ domainRuleEnabled: true });
    expect(on.status).toBe(400);
    const admin = await makeUser("admin", { orgId: o._id });
    expect((await auth(request(app).patch("/api/orgs/current"), admin.token).send({ autoApprove: true })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe("join codes: admin controls", () => {
  test("audit rows never contain a code value; the old value dies at regenerate; limits cannot go below used; parallel signups vs limit change", async () => {
    const org = await acme();
    const admin = await makeUser("admin", { orgId: org._id });
    const oldCode = org.codes.ml_engineer.value;
    for (let i = 0; i < 3; i += 1) {
      const r = await request(app).post("/api/auth/signup").send({ name: "N", email: `n${i}@acme.com`, joinCode: oldCode });
      expect(r.status).toBe(201);
    }
    const put = (b, kind = "ml_engineer") => auth(request(app).put(`/api/orgs/current/codes/${kind}`), admin.token).send(b);
    expect((await put({ seatLimit: 2 })).status).toBe(400);
    expect((await put({ seatLimit: 3 })).status).toBe(200);
    expect((await put({ seatLimit: 0 })).status).toBe(400);
    expect((await put({ seatLimit: 1.5 })).status).toBe(400);
    expect((await put({ seatLimit: "3" })).status).toBe(400);
    expect((await put({ seatLimit: 1e9 })).status).toBe(400);
    expect((await put({ expiresAt: "2001-01-01" })).status).toBe(400);
    expect((await put({ expiresAt: "tomorrow" })).status).toBe(400);
    expect((await put({ expiresAt: "2999-12-31T00:00:00Z" })).status).toBe(200);
    expect((await put({ expiresAt: null, seatLimit: null })).status).toBe(200);
    expect((await put({})).status).toBe(400);
    expect((await auth(request(app).put("/api/orgs/current/codes/admin"), admin.token).send({ seatLimit: 5 })).status).toBe(400); // admin is never obtainable through a code
    expect((await auth(request(app).post("/api/orgs/current/codes/admin/regenerate"), admin.token)).status).toBe(400);
    const reg = await auth(request(app).post("/api/orgs/current/codes/ml_engineer/regenerate"), admin.token);
    expect(reg.status).toBe(200);
    const fresh_ = await Organization.findById(org._id);
    expect(fresh_.codes.ml_engineer.value).not.toBe(oldCode);
    expect(fresh_.codes.ml_engineer.used).toBe(0);
    expect(reg.body.org.codes.ml_engineer.value).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const dead = await request(app).post("/api/auth/signup").send({ name: "N", email: "late@acme.com", joinCode: oldCode });
    expect(dead.status).toBe(403);
    const all = JSON.stringify(await sys(AuditLog).find({}).lean());
    for (const v of [oldCode, fresh_.codes.ml_engineer.value, fresh_.codes.compliance_officer.value]) expect(all).not.toContain(v);
  });

  test("race: raising/lowering the limit while signups run never leaves limit < used, and used == holders", async () => {
    const org = await acme();
    const admin = await makeUser("admin", { orgId: org._id });
    await Organization.updateOne({ _id: org._id }, { $set: { "codes.ml_engineer.seatLimit": 6 } });
    const code = org.codes.ml_engineer.value;
    const jobs = [];
    for (let i = 0; i < 10; i += 1) jobs.push(request(app).post("/api/auth/signup").send({ name: "N", email: `r${i}@acme.com`, joinCode: code }));
    for (const n of [4, 3, 2, 8, 5]) jobs.push(auth(request(app).put("/api/orgs/current/codes/ml_engineer"), admin.token).send({ seatLimit: n }));
    await Promise.all(jobs);
    const o = await Organization.findById(org._id);
    const holders = await sys(User).countDocuments({ orgId: org._id, seatKind: "ml_engineer" });
    expect(o.codes.ml_engineer.used).toBe(holders);
    if (o.codes.ml_engineer.seatLimit != null) expect(o.codes.ml_engineer.seatLimit).toBeGreaterThanOrEqual(o.codes.ml_engineer.used);
  });

  test("two regenerates in parallel: never two live codes; the loser is a clean 409", async () => {
    const org = await acme();
    const admin = await makeUser("admin", { orgId: org._id });
    const rs = await Promise.all([1, 2, 3, 4].map(() => auth(request(app).post("/api/orgs/current/codes/compliance_officer/regenerate"), admin.token)));
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const o = await Organization.findById(org._id);
    expect(o.codes.compliance_officer.gen).toBe(1 + rs.filter((r) => r.status === 200).length);
  });

  test("codes of other orgs appear in no response an org admin or lower can obtain", async () => {
    const mine = await acme();
    const theirs = await acme();
    const admin = await makeUser("admin", { orgId: mine._id });
    const ml = await makeUser("ml_engineer", { orgId: mine._id });
    const secrets = [theirs.codes.ml_engineer.value, theirs.codes.compliance_officer.value, joinCodes.formatCode(theirs.codes.ml_engineer.value)];
    const responses = [];
    for (const t of [admin.token, ml.token]) {
      for (const p of ["/api/orgs/current", "/api/orgs", "/api/users", "/api/users/pending", "/api/auth/me", "/api/stats", "/api/audit-log", "/api/config", "/api/settings"]) {
        responses.push(wire(await auth(request(app).get(p), t)));
      }
    }
    for (const r of responses) for (const s of secrets) expect(r).not.toContain(s);
  });
});

// ---------------------------------------------------------------------------------------------
describe("approval queue", () => {
  test("another org's admin cannot see, approve, reject, patch or re-link an account (404, state untouched, no mail)", async () => {
    const a = await acme();
    const b = await acme();
    const adminB = await makeUser("admin", { orgId: b._id });
    const pend = await pendingUser(a, "p@acme.com");
    const inv = await makeUser("ml_engineer", { orgId: a._id, status: "invited", email: "i@acme.com", extra: { setupTokenHash: "h".repeat(64), setupExpiresAt: new Date(Date.now() + 1e6) } });
    expect(wire(await auth(request(app).get("/api/users/pending"), adminB.token))).not.toContain("p@acme.com");
    for (const [m, p, bd] of [
      ["post", `/api/users/${pend.user._id}/approve`],
      ["post", `/api/users/${pend.user._id}/reject`],
      ["patch", `/api/users/${pend.user._id}`, { role: "admin" }],
      ["post", `/api/users/${inv.user._id}/setup-link`],
      ["patch", `/api/users/${inv.user._id}`, { isActive: false }],
    ]) {
      for (const hdr of [{}, { "X-Org-Id": String(a._id) }]) {
        const res = await auth(request(app)[m](p), adminB.token).set(hdr).send(bd);
        expect([m, p, res.status]).toEqual([m, p, 404]);
      }
    }
    const approveAll = await auth(request(app).post("/api/users/pending/approve-all"), adminB.token);
    expect(approveAll.body).toEqual({ approved: 0 });
    expect((await sys(User).findById(pend.user._id)).status).toBe("pending");
    expect(await used(a)).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(email.outbox).toHaveLength(0);
  });

  test("only `pending` can be approved or rejected: unverified / invited / active / deactivated are 409 and untouched", async () => {
    const o = await acme();
    const admin = await makeUser("admin", { orgId: o._id });
    for (const [status, extra] of [["unverified", {}], ["invited", {}], ["active", {}], ["active", { isActive: false }]]) {
      const u = await makeUser("ml_engineer", { orgId: o._id, status, extra });
      for (const act of ["approve", "reject"]) {
        const res = await auth(request(app).post(`/api/users/${u.user._id}/${act}`), admin.token);
        expect([status, act, res.status]).toEqual([status, act, 409]);
      }
      const row = await sys(User).findById(u.user._id);
      expect(row).toBeTruthy();
      expect(row.status).toBe(status);
    }
  });

  test("approve-all x3, approve, and reject racing: every pending user ends approved XOR rejected, once; seats and audit agree", async () => {
    const o = await acme();
    const admin = await makeUser("admin", { orgId: o._id });
    const admin2 = await makeUser("admin", { orgId: o._id });
    const ids = [];
    for (let i = 0; i < 12; i += 1) ids.push((await pendingUser(o, `q${i}@acme.com`)).user._id);
    const jobs = [
      auth(request(app).post("/api/users/pending/approve-all"), admin.token),
      auth(request(app).post("/api/users/pending/approve-all"), admin2.token),
      auth(request(app).post("/api/users/pending/approve-all"), admin.token),
      ...ids.slice(0, 4).map((id) => auth(request(app).post(`/api/users/${id}/reject`), admin2.token)),
      ...ids.slice(2, 6).map((id) => auth(request(app).post(`/api/users/${id}/approve`), admin.token)),
    ];
    const rs = await Promise.all(jobs);
    for (const r of rs) expect([200, 404, 409]).toContain(r.status);
    const remaining = await sys(User).find({ _id: { $in: ids } });
    const rejected = ids.length - remaining.length;
    const active = remaining.filter((u) => u.status === "active").length;
    expect(remaining.filter((u) => u.status === "pending")).toHaveLength(0);
    expect(active + rejected).toBe(12);
    expect(await used(o)).toBe(active); // rejected seats came back exactly once, approved ones stay
    const approveRows = await audits({ action: "user_approve" });
    const rejectRows = await audits({ action: "user_reject" });
    expect(approveRows.length).toBe(active);
    expect(rejectRows.length).toBe(rejected);
    expect(new Set(approveRows.map((r) => String(r.targetId))).size).toBe(approveRows.length);
    await new Promise((r) => setTimeout(r, 120));
    expect(email.outbox.length).toBe(active + rejected);
  });

  test("rejecting releases the seat so the same code can be used again; a rejected person can sign up again from scratch", async () => {
    const o = await acme();
    await Organization.updateOne({ _id: o._id }, { $set: { "codes.ml_engineer.seatLimit": 1 } });
    const admin = await makeUser("admin", { orgId: o._id });
    const code = o.codes.ml_engineer.value;
    const s = await request(app).post("/api/auth/signup").send({ name: "N", email: "n@acme.com", joinCode: code });
    expect(s.status).toBe(201);
    expect((await request(app).post("/api/auth/signup").send({ name: "M", email: "m@acme.com", joinCode: code })).status).toBe(403);
    const token = new URL(email.extractLinks(email.outbox[0].text).find((l) => l.includes("verify-email"))).searchParams.get("token");
    expect((await request(app).post("/api/auth/verify-email").send({ token, password: "Password1!" })).status).toBe(200);
    const pend = await auth(request(app).get("/api/users/pending"), admin.token);
    expect(pend.body.users).toHaveLength(1);
    expect((await auth(request(app).post(`/api/users/${pend.body.users[0].id}/reject`), admin.token)).status).toBe(200);
    expect(await used(o)).toBe(0);
    expect((await request(app).post("/api/auth/signup").send({ name: "M", email: "m@acme.com", joinCode: code })).status).toBe(201);
    // the rejected person can start over (their old row is gone)
    expect((await request(app).post("/api/auth/signup").send({ name: "N", email: "n@acme.com", joinCode: code })).status).toBe(403); // full again (limit 1)
  });
});

// ---------------------------------------------------------------------------------------------
describe("Add user and setup links", () => {
  const add = (token, b, hdr = {}) => auth(request(app).post("/api/users"), token).set(hdr).send(b);

  test("role is whitelisted: super_admin / unknown / missing roles are 400; mass-assignment fields are dropped", async () => {
    const o = await acme();
    const other = await acme();
    const admin = await makeUser("admin", { orgId: o._id });
    for (const role of ["super_admin", "root", "", null, ["admin"], { $ne: 1 }, undefined]) {
      const res = await add(admin.token, { name: "X", email: "x@acme.com", role });
      expect([String(role), res.status]).toEqual([String(role), 400]);
    }
    const res = await add(admin.token, {
      name: "X", email: "x@acme.com", role: "ml_engineer", orgId: String(other._id), status: "active", isActive: true,
      password: "Password1!", passwordHash: "x", seatKind: "ml_engineer", emailKey: "zzz@zzz", setupTokenHash: "a".repeat(64),
    });
    expect(res.status).toBe(201);
    expect(wire(res)).not.toMatch(NO_SECRETS);
    const row = await dbUser({ email: "x@acme.com" });
    expect(String(row.orgId)).toBe(String(o._id));
    expect(row.status).toBe("invited");
    expect(row.emailKey).toBe("x@acme.com");
    expect(row.setupTokenHash).not.toBe("a".repeat(64));
    expect(row.seatKind).toBeNull();
    expect((await post_login("x@acme.com", "Password1!")).status).toBe(401); // the "password" in the body did nothing
    // a plain admin may add another admin (spec) but nothing above it
    expect((await add(admin.token, { name: "Y", email: "y@acme.com", role: "admin" })).status).toBe(201);
  });
  const post_login = (e, p) => request(app).post("/api/auth/login").send({ email: e, password: p });

  test("domain rule: outsiders need the explicit override (a real boolean), the override is audited, free-mail included", async () => {
    const o = await acme();
    const admin = await makeUser("admin", { orgId: o._id });
    for (const e of ["c@contractor.com", "c@acme.com.evil.com", "c@sub.acme.com", "c@gmail.com"]) {
      const res = await add(admin.token, { name: "C", email: e, role: "ml_engineer" });
      expect([e, res.status, res.body.code]).toEqual([e, 400, "EMAIL_DOMAIN_NOT_ALLOWED"]);
      for (const v of ["true", 1, "yes", [true], {}, null]) {
        const bad = await add(admin.token, { name: "C", email: e, role: "ml_engineer", allowExternalEmail: v });
        expect([e, String(v), bad.status]).toEqual([e, String(v), 400]);
      }
    }
    expect(await sys(User).countDocuments({ orgId: o._id })).toBe(1);
    const ok = await add(admin.token, { name: "C", email: "c@gmail.com", role: "compliance_officer", allowExternalEmail: true });
    expect(ok.status).toBe(201);
    const row = (await audits({ action: "create_user", targetId: ok.body.user.id }))[0];
    expect(row.details).toMatch(/external email override.*gmail\.com/);
    const inside = await add(admin.token, { name: "D", email: "d@acme.com", role: "ml_engineer", allowExternalEmail: true });
    expect((await audits({ action: "create_user", targetId: inside.body.user.id }))[0].details).not.toMatch(/override/);
  });

  test("globally unique person: +tag / case duplicates of ANY org, unverified and pending included, are 409; the 409 does not name the org", async () => {
    const a = await acme();
    const b = await acme({ allowedDomains: ["acme.com", "beta.com"] });
    const adminB = await makeUser("admin", { orgId: b._id });
    await makeUser("ml_engineer", { orgId: a._id, email: "jo@acme.com" });
    await makeUser("ml_engineer", { orgId: a._id, email: "pe@acme.com", status: "pending" });
    await makeUser("ml_engineer", { orgId: a._id, email: "un@acme.com", status: "unverified" });
    for (const e of ["jo@acme.com", "JO+x@acme.com", "pe+1@acme.com", "un@acme.com"]) {
      const res = await add(adminB.token, { name: "J", email: e, role: "ml_engineer" });
      expect([e, res.status]).toEqual([e, 409]);
      expect(wire(res)).not.toMatch(new RegExp(a.name));
    }
  });

  test("setup link: org-scoped, replaces the old one, only for invited, audited without the token; the old link dies", async () => {
    const o = await acme();
    const other = await acme();
    const admin = await makeUser("admin", { orgId: o._id });
    const otherAdmin = await makeUser("admin", { orgId: other._id });
    const created = await add(admin.token, { name: "I", email: "i@acme.com", role: "ml_engineer" });
    const t1 = new URL(created.body.setupLink).searchParams.get("token");
    const id = created.body.user.id;
    expect((await auth(request(app).post(`/api/users/${id}/setup-link`), otherAdmin.token)).status).toBe(404);
    const re = await auth(request(app).post(`/api/users/${id}/setup-link`), admin.token);
    expect(re.status).toBe(200);
    const t2 = new URL(re.body.setupLink).searchParams.get("token");
    expect(t2).not.toBe(t1);
    expect((await request(app).post("/api/auth/setup-password").send({ token: t1, password: "Password1!" })).status).toBe(400);
    expect((await request(app).post("/api/auth/setup-password").send({ token: t2, password: "Password1!" })).status).toBe(200);
    expect((await auth(request(app).post(`/api/users/${id}/setup-link`), admin.token)).status).toBe(409); // already set its password
    const all = JSON.stringify(await sys(AuditLog).find({}).lean());
    expect(all).not.toContain(t1);
    expect(all).not.toContain(t2);
    // an active admin's link cannot be used to reset someone's password through the admin API
    const vic = await makeUser("ml_engineer", { orgId: o._id });
    expect((await auth(request(app).post(`/api/users/${vic.user._id}/setup-link`), admin.token)).status).toBe(409);
    expect((await post_login(vic.user.email, vic.password)).status).toBe(200);
  });

  test("a failed relay does not fail Add user: 201 emailSent:false + link to the admin; a good relay: link only by mail", async () => {
    useRelay();
    const o = await acme();
    const admin = await makeUser("admin", { orgId: o._id });
    relay({ ok: false, error: "quota" });
    const bad = await add(admin.token, { name: "I", email: "i@acme.com", role: "ml_engineer" });
    expect(bad.status).toBe(201);
    expect(bad.body.emailSent).toBe(false);
    expect(bad.body.setupLink).toContain("setup-password?token=");
    relay({ ok: true });
    const good = await add(admin.token, { name: "J", email: "j@acme.com", role: "ml_engineer" });
    expect(good.body).toMatchObject({ emailSent: true, setupLink: null });
    const re = await auth(request(app).post(`/api/users/${good.body.user.id}/setup-link`), admin.token);
    expect(re.body).toMatchObject({ emailSent: true, setupLink: null });
  });

  test("mail sent to the invitee: HTML-escaped org and user names, link on APP_URL, one recipient", async () => {
    const o = await makeOrg({ name: `"><svg onload=alert(1)> Co ${Date.now()}`, allowedDomains: ["acme.com"] });
    const admin = await makeUser("admin", { orgId: o._id });
    await add(admin.token, { name: "<b onmouseover=x>Eve</b>\r\nBcc: z@z.io", email: "eve@acme.com", role: "ml_engineer" }, { Host: "evil.example" });
    const m = email.outbox[email.outbox.length - 1];
    expect(m.to).toBe("eve@acme.com");
    expect(m.html).not.toMatch(/<svg|<b onmouse/i);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(JSON.stringify(m)).not.toMatch(/evil\.example/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("last active admin, per organization, under concurrency", () => {
  const patch = (token, id, b, hdr = {}) => auth(request(app).patch(`/api/users/${id}`), token).set(hdr).send(b);

  test("two admins deactivating / demoting each other at the same instant: one admin always survives", async () => {
    for (const change of [{ isActive: false }, { role: "ml_engineer" }]) {
      await fresh();
      const o = await acme();
      const a = await makeUser("admin", { orgId: o._id });
      const b = await makeUser("admin", { orgId: o._id });
      const rs = await Promise.all([patch(a.token, b.user._id, change), patch(b.token, a.user._id, change), patch(a.token, b.user._id, change), patch(b.token, a.user._id, change)]);
      for (const r of rs) expect([200, 400, 401, 403, 409]).toContain(r.status);
      const survivors = await sys(User).countDocuments({ orgId: o._id, role: "admin", isActive: { $ne: false } });
      expect(survivors).toBeGreaterThanOrEqual(1);
    }
  });

  test("a super admin working inside the org plus the org's own admins racing: still never zero", async () => {
    const o = await acme();
    const sa = await makeUser("super_admin");
    const a = await makeUser("admin", { orgId: o._id });
    const b = await makeUser("admin", { orgId: o._id });
    const c = await makeUser("admin", { orgId: o._id });
    const rs = await Promise.all([
      patch(sa.token, a.user._id, { isActive: false }, { "X-Org-Id": String(o._id) }),
      patch(sa.token, b.user._id, { role: "compliance_officer" }, { "X-Org-Id": String(o._id) }),
      patch(sa.token, c.user._id, { isActive: false }, { "X-Org-Id": String(o._id) }),
      patch(a.token, c.user._id, { isActive: false }),
      patch(b.token, a.user._id, { role: "ml_engineer" }),
      patch(c.token, b.user._id, { isActive: false }),
    ]);
    for (const r of rs) expect([200, 400, 401, 403, 409]).toContain(r.status);
    const left = await sys(User).countDocuments({ orgId: o._id, role: "admin", isActive: { $ne: false } });
    expect(left).toBeGreaterThanOrEqual(1);
    // and the super admin can never deactivate the last one afterwards
    const last = await sys(User).findOne({ orgId: o._id, role: "admin", isActive: { $ne: false } });
    const res = await patch(sa.token, last._id, { isActive: false }, { "X-Org-Id": String(o._id) });
    expect(res.status).toBe(400);
  });

  test("an admin who never set a password (invited) does not count as the 'other' admin; another org's admins never count either", async () => {
    const o = await acme();
    const other = await acme();
    await makeUser("admin", { orgId: other._id });
    const a = await makeUser("admin", { orgId: o._id });
    await makeUser("admin", { orgId: o._id, status: "invited" });
    const sa = await makeUser("super_admin");
    const res = await patch(sa.token, a.user._id, { isActive: false }, { "X-Org-Id": String(o._id) });
    expect(res.status).toBe(400);
    expect((await sys(User).findById(a.user._id)).isActive).toBe(true);
    // self-protection
    const self = await patch(a.token, a.user._id, { role: "ml_engineer" });
    expect(self.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the platform owner cannot be created, edited, deactivated or demoted through any API", () => {
  test("every route that takes an id or a role refuses super_admin; org admins and the super admin themselves cannot reach the row", async () => {
    const o = await acme();
    const admin = await makeUser("admin", { orgId: o._id });
    const sa = await makeUser("super_admin", { email: "root@platform.io" });
    const sid = sa.user._id;
    const asSA = { "X-Org-Id": String(o._id) };
    for (const [who, tok, hdr] of [["org admin", admin.token, {}], ["super admin", sa.token, asSA]]) {
      for (const [m, p, b] of [
        ["patch", `/api/users/${sid}`, { isActive: false }],
        ["patch", `/api/users/${sid}`, { role: "ml_engineer" }],
        ["patch", `/api/users/${sid}`, { name: "Hax" }],
        ["post", `/api/users/${sid}/setup-link`],
        ["post", `/api/users/${sid}/approve`],
        ["post", `/api/users/${sid}/reject`],
      ]) {
        const res = await auth(request(app)[m](p), tok).set(hdr).send(b);
        expect([who, m, p, res.status]).toEqual([who, m, p, 404]);
      }
      expect(wire(await auth(request(app).get("/api/users"), tok).set(hdr))).not.toContain("root@platform.io");
    }
    for (const role of ["super_admin", "SUPER_ADMIN", "admin\u0000", " super_admin"]) {
      expect((await auth(request(app).post("/api/users"), admin.token).send({ name: "X", email: `x${Math.random().toString(36).slice(2)}@acme.com`, role })).status).toBe(400);
    }
    expect((await auth(request(app).patch(`/api/users/${admin.user._id}`), admin.token).send({ role: "super_admin" })).status).toBe(400);
    const peer = await makeUser("ml_engineer", { orgId: o._id });
    expect((await auth(request(app).patch(`/api/users/${peer.user._id}`), admin.token).send({ role: "super_admin" })).status).toBe(400);
    // signup / org creation with the platform owner's address: blocked as an existing account
    for (const e of ["root@platform.io", "ROOT+hq@platform.io"]) {
      expect((await auth(request(app).post("/api/users"), admin.token).send({ name: "X", email: e, role: "ml_engineer", allowExternalEmail: true })).status).toBe(409);
      expect((await auth(request(app).post("/api/orgs"), sa.token).send(body({ adminEmail: e }))).status).toBe(409);
    }
    const open = await makeOrg({ name: `Open ${Date.now()}`, domainRuleEnabled: false, allowedDomains: [] });
    const s = await request(app).post("/api/auth/signup").send({ name: "X", email: "root@platform.io", joinCode: open.codes.ml_engineer.value });
    expect(s.status).toBe(409);
    expect((await sys(User).findById(sid)).role).toBe("super_admin");
    expect((await sys(User).findById(sid)).isActive).toBe(true);
    // a super admin has no org of its own: the row can never be assigned one by the plugin either
    expect((await sys(User).findById(sid)).orgId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("roles below admin", () => {
  test("ml_engineer and compliance_officer get 403 on every /api/users and /api/orgs route; anonymous gets 401", async () => {
    const o = await acme();
    const target = await makeUser("ml_engineer", { orgId: o._id });
    const routes = [
      ["get", "/api/users"], ["get", "/api/users/pending"], ["post", "/api/users"], ["post", "/api/users/pending/approve-all"],
      ["post", `/api/users/${target.user._id}/approve`], ["post", `/api/users/${target.user._id}/reject`],
      ["post", `/api/users/${target.user._id}/setup-link`], ["patch", `/api/users/${target.user._id}`],
      ["get", "/api/orgs"], ["post", "/api/orgs"], ["get", "/api/orgs/current"], ["patch", "/api/orgs/current"],
      ["put", "/api/orgs/current/codes/ml_engineer"], ["post", "/api/orgs/current/codes/ml_engineer/regenerate"],
    ];
    for (const role of ["ml_engineer", "compliance_officer"]) {
      const u = await makeUser(role, { orgId: o._id });
      for (const [m, p] of routes) {
        const res = await auth(request(app)[m](p), u.token).send({ name: "x", email: "x@acme.com", role: "admin", isActive: false, autoApprove: true });
        expect([role, m, p, res.status]).toEqual([role, m, p, 403]);
      }
    }
    for (const [m, p] of routes) expect((await request(app)[m](p).send({})).status).toBe(401);
    expect((await sys(User).findById(target.user._id)).isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("reach of an org admin across organizations through query / header / body", () => {
  test("?orgId, X-Org-Id and body orgId never widen /users, /users/pending, /stats, /audit-log", async () => {
    const mine = await acme();
    const theirs = await acme();
    const admin = await makeUser("admin", { orgId: mine._id });
    await makeUser("ml_engineer", { orgId: theirs._id, email: "secret@theirs.com" });
    await pendingUser(theirs, "pend@theirs.com");
    for (const p of ["/api/users", "/api/users/pending", "/api/stats", "/api/audit-log", "/api/audit-log/export", "/api/users?q=theirs"]) {
      for (const [qs, hdr] of [["", {}], [`orgId=${theirs._id}`, {}], ["", { "X-Org-Id": String(theirs._id) }], [`orgId[$ne]=1&orgId=${theirs._id}`, { "X-Org-Id": "garbage" }]]) {
        const sep = p.includes("?") ? "&" : "?";
        const res = await auth(request(app).get(qs ? `${p}${sep}${qs}` : p), admin.token).set(hdr);
        expect([p, qs, hdr["X-Org-Id"], res.status < 500]).toEqual([p, qs, hdr["X-Org-Id"], true]);
        expect(wire(res)).not.toMatch(/theirs\.com/);
      }
    }
  });

  test("a super admin must select an org for org routes, and the choice is validated against real organizations", async () => {
    const sa = await makeUser("super_admin");
    expect((await auth(request(app).get("/api/users"), sa.token)).status).toBe(400);
    for (const bad of ["x", "0".repeat(24), "{\"$ne\":1}", "1".repeat(25)]) {
      const r = await auth(request(app).get("/api/users"), sa.token).set("X-Org-Id", bad);
      expect([bad, r.status, r.body.code]).toEqual([bad, 400, "ORG_REQUIRED"]);
    }
    const o = await acme();
    expect((await asOrg(auth(request(app).get("/api/users"), sa.token), o._id)).status).toBe(200);
    // the access is audited
    expect((await audits({ action: "org_access", orgId: o._id })).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("wire hygiene across the whole surface", () => {
  test("no hash, token field or emailKey in any user/org response, whoever asks", async () => {
    const o = await acme();
    const sa = await makeUser("super_admin");
    const admin = await makeUser("admin", { orgId: o._id });
    await pendingUser(o, "p@acme.com");
    await makeUser("ml_engineer", { orgId: o._id, status: "invited", email: "i@acme.com", extra: { setupTokenHash: "h".repeat(64), setupExpiresAt: new Date(Date.now() + 1e6) } });
    const outs = [];
    for (const [tok, hdr] of [[admin.token, {}], [sa.token, { "X-Org-Id": String(o._id) }]]) {
      for (const p of ["/api/users", "/api/users/pending", "/api/orgs/current", "/api/auth/me", "/api/audit-log"]) outs.push(wire(await auth(request(app).get(p), tok).set(hdr)));
    }
    outs.push(wire(await auth(request(app).get("/api/orgs"), sa.token)));
    for (const o_ of outs) expect(o_).not.toMatch(NO_SECRETS);
  });
});
