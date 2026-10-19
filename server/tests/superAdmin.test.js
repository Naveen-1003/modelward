const bcrypt = require("bcryptjs");
const env = require("../config/env");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { ensureSuperAdmin, ensureSuperAdminDetailed } = require("../utils/superAdmin");
const { connect, reset, disconnect, makeUser, sys } = require("./helpers");

const find = (email) => sys(User).findOne({ email }).lean();
const audits = () => sys(AuditLog).find({ targetType: "User" }).sort({ seq: 1 }).lean();

const saved = {};
beforeAll(async () => {
  await connect();
  Object.assign(saved, { e: env.superAdminEmail, p: env.superAdminPassword, n: env.superAdminName });
});
afterAll(async () => {
  Object.assign(env, { superAdminEmail: saved.e, superAdminPassword: saved.p, superAdminName: saved.n });
  await disconnect();
});
beforeEach(async () => {
  await reset();
  env.superAdminEmail = "";
  env.superAdminPassword = "";
  env.superAdminName = "Platform Admin";
});

describe("ensureSuperAdmin", () => {
  test("nothing configured: nothing happens (only a warning)", async () => {
    expect(await ensureSuperAdmin()).toBeNull();
    expect((await ensureSuperAdminDetailed()).action).toBe("none");
    expect(await sys(User).countDocuments()).toBe(0);
  });

  test("promotes an existing user: role, no org, active", async () => {
    const { user } = await makeUser("admin", { email: "boss@acme.test", status: "active" });
    env.superAdminEmail = "boss@acme.test";
    const msg = await ensureSuperAdmin();
    expect(msg).toMatch(/promoted boss@acme.test to super_admin \(was admin\)/);
    expect(await find("boss@acme.test")).toMatchObject({ role: "super_admin", orgId: null, status: "active", isActive: true });
    expect(String((await find("boss@acme.test"))._id)).toBe(String(user._id));
    // the password and name are untouched
    expect(await bcrypt.compare("Password1!", (await find("boss@acme.test")).passwordHash)).toBe(true);
    const log = await audits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "update_user", orgId: null, chainV: 2 });
  });

  test("a deactivated / pending account is made usable when promoted", async () => {
    await makeUser("ml_engineer", { email: "p@acme.test", status: "pending", extra: { isActive: false } });
    expect(await ensureSuperAdmin({ email: "p@acme.test" })).toMatch(/promoted/);
    expect(await find("p@acme.test")).toMatchObject({ role: "super_admin", orgId: null, status: "active", isActive: true });
  });

  test("matches by emailKey: a +tag variant is promoted", async () => {
    await makeUser("compliance_officer", { email: "me+work@acme.test" });
    expect(await ensureSuperAdmin({ email: "me@acme.test" })).toMatch(/promoted me\+work@acme.test/);
    expect(await find("me+work@acme.test")).toMatchObject({ role: "super_admin", orgId: null });
  });

  test("finds legacy rows that have no emailKey yet (raw), also by +tag", async () => {
    const col = User.collection;
    await col.insertMany([
      { name: "L1", email: "legacy@acme.test", passwordHash: "x", role: "admin", createdAt: new Date() },
      { name: "L2", email: "Other+tag@acme.test", passwordHash: "x", role: "ml_engineer", createdAt: new Date() },
    ]);
    expect(await ensureSuperAdmin({ email: "legacy@acme.test" })).toMatch(/promoted/);
    expect(await ensureSuperAdmin({ email: "other@acme.test" })).toMatch(/promoted Other\+tag@acme.test/);
    expect(await col.countDocuments({ role: "super_admin", orgId: null, status: "active", isActive: true })).toBe(2);
  });

  test("creates the account when a valid password is configured (from the environment)", async () => {
    env.superAdminEmail = "Owner@Platform.test";
    env.superAdminPassword = "correct horse battery";
    env.superAdminName = "The Owner";
    expect(await ensureSuperAdmin()).toBe("created super_admin owner@platform.test");
    const u = await find("owner@platform.test");
    expect(u).toMatchObject({ name: "The Owner", role: "super_admin", orgId: null, status: "active", isActive: true, emailKey: "owner@platform.test" });
    expect(await bcrypt.compare("correct horse battery", u.passwordHash)).toBe(true);
    expect(u.passwordHash).not.toContain("correct horse");
    expect((await audits())[0]).toMatchObject({ action: "create_user", orgId: null });
  });

  test("without a password (or with a weak / oversized one) nothing is created", async () => {
    for (const password of ["", undefined, "short7!", "x".repeat(73), "é".repeat(37)]) {
      const r = await ensureSuperAdminDetailed({ email: "new@platform.test", password });
      expect(r.action).toBe("skipped");
    }
    expect(await sys(User).countDocuments()).toBe(0);
    expect(await ensureSuperAdmin({ email: "new@platform.test", password: "x".repeat(72) })).toMatch(/created/); // 72 bytes is fine
  });

  test("a weak password does not block promoting an existing account", async () => {
    await makeUser("admin", { email: "boss@acme.test" });
    expect(await ensureSuperAdmin({ email: "boss@acme.test", password: "x" })).toMatch(/promoted/);
  });

  test("is idempotent", async () => {
    await makeUser("admin", { email: "boss@acme.test" });
    env.superAdminEmail = "boss@acme.test";
    expect(await ensureSuperAdmin()).toMatch(/promoted/);
    const before = JSON.stringify(await sys(User).find().lean());
    const logs = (await audits()).length;
    expect(await ensureSuperAdmin()).toBeNull();
    expect((await ensureSuperAdminDetailed()).action).toBe("unchanged");
    expect(JSON.stringify(await sys(User).find().lean())).toBe(before);
    expect((await audits()).length).toBe(logs);

    env.superAdminEmail = "fresh@platform.test";
    env.superAdminPassword = "a-good-password";
    expect(await ensureSuperAdmin()).toMatch(/created/);
    expect(await ensureSuperAdmin()).toBeNull();
    expect(await sys(User).countDocuments({ role: "super_admin" })).toBe(2);
  });

  test("never demotes: other super admins, and the configured one, stay what they are", async () => {
    const other = await makeUser("super_admin", { email: "other@platform.test" });
    await makeUser("admin", { email: "boss@acme.test" });
    await ensureSuperAdmin({ email: "boss@acme.test" });
    expect(await find("other@platform.test")).toMatchObject({ role: "super_admin", orgId: null });
    // configuration pointing somewhere else (or removed) does not touch the earlier promotion
    await ensureSuperAdmin({ email: "other@platform.test" });
    expect(await ensureSuperAdmin({ email: "" })).toBeNull();
    expect(await find("boss@acme.test")).toMatchObject({ role: "super_admin" });
    expect(String((await find("other@platform.test"))._id)).toBe(String(other.user._id));
  });

  test("a super admin that lost its flags is repaired, but never given an organization", async () => {
    await makeUser("super_admin", { email: "s@platform.test", status: "pending", extra: { isActive: false } });
    expect(await ensureSuperAdmin({ email: "s@platform.test" })).toMatch(/repaired flags/);
    expect(await find("s@platform.test")).toMatchObject({ role: "super_admin", orgId: null, status: "active", isActive: true });
  });
});
