// Red-team (reviewer R2): the multi-tenant migration against ugly legacy databases, concurrent
// runs, the super-admin promotion and the environment password policy.
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const env = require("../config/env");
const { runMigrations, ensureIndexes } = require("../migrations");
const { ensureSuperAdminDetailed } = require("../utils/superAdmin");
const { connect, disconnect, auth, sys } = require("./helpers");

const oid = () => new mongoose.Types.ObjectId();
const col = (name) => mongoose.connection.collection(name);
const day = (n) => new Date(Date.UTC(2025, 0, n));
const wipe = () => mongoose.connection.dropDatabase();
const ALL = ["users", "models", "versions", "comments", "metricsnapshots", "settings", "auditlogs", "organizations"];
const snapshotOf = async () => JSON.stringify(await Promise.all(ALL.map((n) => col(n).find().sort({ _id: 1 }).toArray())));

const saved = {};
beforeAll(async () => {
  await connect();
  Object.assign(saved, { e: env.superAdminEmail, p: env.superAdminPassword, n: env.defaultOrgName });
});
afterAll(async () => {
  Object.assign(env, { superAdminEmail: saved.e, superAdminPassword: saved.p, defaultOrgName: saved.n });
  await disconnect();
});
beforeEach(async () => {
  env.superAdminEmail = "";
  env.superAdminPassword = "";
  env.defaultOrgName = "Default Organization";
  await wipe();
  jest.restoreAllMocks();
});

const user = (email, role, extra = {}) => ({ _id: oid(), name: email.split("@")[0], email, passwordHash: bcrypt.hashSync("Legacy-Pass1", 4), role, isActive: true, createdAt: day(1), ...extra });
const model = (name, extra = {}) => ({ _id: oid(), name, description: "", useCase: "", createdBy: oid(), isDeleted: false, versionSeq: 1, createdAt: day(1), ...extra });
const version = (modelId, n, extra = {}) => ({
  _id: oid(), modelId, versionNumber: n, fileType: "csv", status: "draft", isDeleted: false, initialRiskTier: null,
  thresholdsUsed: {}, retryable: false, fileName: "a.csv", createdBy: oid(), createdAt: day(2), updatedAt: day(2), ...extra,
});
const ids = {};

async function nastyFixture() {
  const users = [
    user("jo@acme.com", "admin", { createdAt: day(1) }),
    user("jo+x@acme.com", "ml_engineer", { createdAt: day(2) }),
    user("jo+y@acme.com", "compliance_officer", { createdAt: day(3) }),
    user("bob+a@acme.com", "ml_engineer", { createdAt: day(4) }),
    user("bob+b@acme.com", "ml_engineer", { createdAt: day(5) }),
    user("+weird@acme.com", "ml_engineer"),
    user("x@y", "ml_engineer"),
    user("admin2@acme.com", "admin", { isActive: false }),
  ];
  ids.users = users.map((u) => u._id);
  await col("users").insertMany(users);
  const m = {
    a: model("Credit", { createdAt: day(1) }),
    b: model("credit", { createdAt: day(2) }),
    c1: model("Credit", { createdAt: day(3), isDeleted: true }),
    c2: model("Credit", { createdAt: day(4), isDeleted: true }),
    d1: model("Churn", { isDeleted: true }),
    d2: model("Churn"),
    lig: model("ﬁle"), // "ﬁle" (fi ligature)
    fi: model("file"),
    full: model("Ａbc"), // fullwidth A
    abc: model("abc"),
    pad: model("Pad "),
    pad2: model("pad"),
    long1: model("L".repeat(120)),
    long2: model("l".repeat(120)),
  };
  ids.models = m;
  await col("models").insertMany(Object.values(m));
  const versions = [
    version(m.a._id, 1), version(m.a._id, 1), version(m.a._id, 2), version(m.b._id, 1),
    version(oid(), 1), // parent model does not exist
    version(null, 1), // no parent id at all
    version(String(m.a._id), 3), // parent id stored as a string
    version(m.d1._id, 1),
  ];
  delete versions[5].modelId;
  await col("versions").insertMany(versions);
  ids.versions = versions;
  await col("comments").insertMany([
    { _id: oid(), versionId: versions[0]._id, authorId: oid(), text: "hi", createdAt: day(3) },
    { _id: oid(), versionId: oid(), authorId: oid(), text: "orphan", createdAt: day(3) },
    { _id: oid(), authorId: oid(), text: "no parent", createdAt: day(3) },
  ]);
  await col("metricsnapshots").insertMany([
    { _id: oid(), versionId: versions[0]._id, accuracy: 0.9, fairnessGap: 0.05, isBaseline: true, createdAt: day(3) },
    { _id: oid(), versionId: null, accuracy: 0.9, fairnessGap: 0.05, createdAt: day(3) },
  ]);
  await col("settings").insertMany([
    { _id: oid(), key: "global", thresholds: { accuracyHigh: 0.9 }, createdAt: day(1) },
    { _id: oid(), key: "stray", thresholds: {}, createdAt: day(2) },
  ]);
}

const noOrgLeft = async () => {
  const left = {};
  for (const n of ["users", "models", "versions", "comments", "metricsnapshots", "settings"]) {
    left[n] = await col(n).countDocuments({ orgId: null, ...(n === "users" ? { role: { $ne: "super_admin" } } : {}) });
  }
  return left;
};

describe("ugly legacy database", () => {
  test("migrates without throwing: every row lands in ONE org, keys are unique, orphans fall back to the default org", async () => {
    await nastyFixture();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    await runMigrations();
    expect(await col("organizations").countDocuments()).toBe(1);
    expect(await noOrgLeft()).toEqual({ users: 0, models: 0, versions: 0, comments: 0, metricsnapshots: 0, settings: 1 }); // the 2nd (stray) settings doc cannot be attached
    const org = await col("organizations").findOne();
    expect(org.domainRuleEnabled).toBe(false);
    expect(org.autoApprove).toBe(false);

    const keys = (await col("users").find().toArray()).map((u) => u.emailKey);
    expect(keys.every((k) => typeof k === "string" && k)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    const key = async (email) => (await col("users").findOne({ email })).emailKey;
    expect(await key("jo@acme.com")).toBe("jo@acme.com");
    expect(await key("jo+x@acme.com")).toBe("jo+x@acme.com");
    expect(await key("jo+y@acme.com")).toBe("jo+y@acme.com");
    expect(await key("bob+a@acme.com")).toBe("bob@acme.com"); // first of its family claims the plain key
    expect(await key("bob+b@acme.com")).toBe("bob+b@acme.com");
    expect(warn.mock.calls.filter((c) => /WARNING: .*differs from another account/.test(c[0]))).toHaveLength(0);

    // a version whose model exists follows it; the orphans fall back
    const v = await col("versions").find().toArray();
    expect(v.every((x) => String(x.orgId) === String(org._id))).toBe(true);
    // all indexes that matter exist and no unique index silently failed
    const idx = (await col("users").indexes()).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(["email_1", "emailKey_1"]));
    const midx = await col("models").indexes();
    expect(midx.some((i) => i.unique && i.key.orgId === 1 && i.key.name === 1 && i.partialFilterExpression)).toBe(true);
    expect(midx.some((i) => i.key.name === 1 && !i.key.orgId)).toBe(false);
    const errs = warn.mock.calls.concat(console.error.mock ? console.error.mock.calls : []).filter((c) => /could not build a unique index|index conflict/.test(String(c[0])));
    expect(errs).toEqual([]);
  });

  test("model names that collide under the unique index's collation (ligature, fullwidth, case, padding) are renamed, so the index can be built", async () => {
    await nastyFixture();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    await runMigrations();
    const active = await col("models").find({ isDeleted: false }).toArray();
    const seen = new Map();
    for (const m of active) {
      const k = JSON.stringify(m.name.normalize("NFKC").trim().toLowerCase());
      expect([k, seen.has(k)]).toEqual([k, false]);
      seen.set(k, 1);
    }
    // the unique per-org index exists (it could not be built if two collation-equal names survived)
    const midx = await col("models").indexes();
    expect(midx.some((i) => i.unique && i.key.orgId === 1 && i.key.name === 1)).toBe(true);
    // archived duplicates are untouched and the model of the same name can exist in ANOTHER org afterwards
    expect(await col("models").countDocuments({ name: "Credit", isDeleted: true })).toBe(2);
  });

  test("idempotent: a second and third run change nothing at all", async () => {
    await nastyFixture();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    await runMigrations();
    const first = await snapshotOf();
    const second = await runMigrations();
    expect(second).toEqual([]);
    expect(await snapshotOf()).toBe(first);
    await runMigrations();
    expect(await snapshotOf()).toBe(first);
  });

  test("two migrations at the same moment (two instances booting): no crash, one org, consistent keys", async () => {
    await nastyFixture();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    const rs = await Promise.allSettled([runMigrations(), runMigrations(), runMigrations()]);
    expect(rs.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(await col("organizations").countDocuments()).toBe(1);
    const left = await noOrgLeft();
    expect(left.users + left.models + left.versions + left.comments + left.metricsnapshots).toBe(0);
    const keys = (await col("users").find().toArray()).map((u) => u.emailKey);
    expect(new Set(keys).size).toBe(keys.length);
    await runMigrations(); // and a later boot still settles on the same thing
    expect(await col("organizations").countDocuments()).toBe(1);
  });

  test("an empty database stays empty (no organization is invented) and a database with only a super admin too", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    await runMigrations();
    expect(await col("organizations").countDocuments()).toBe(0);
    await col("users").insertOne(user("root@platform.io", "super_admin", { status: "active", emailKey: "root@platform.io", orgId: null }));
    await runMigrations();
    expect(await col("organizations").countDocuments()).toBe(0);
    expect((await col("users").findOne({ email: "root@platform.io" })).orgId).toBeNull();
  });

  test("huge counts: 4k models, 24k versions, 12k comments, 6k users migrate in bounded time and keep their parents' org", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const t0 = Date.now();
    const models = Array.from({ length: 4000 }, (_, i) => model(`M${i}`));
    await col("models").insertMany(models);
    const versions = [];
    for (const m of models) for (let n = 1; n <= 6; n += 1) versions.push(version(m._id, n));
    for (let i = 0; i < versions.length; i += 4000) await col("versions").insertMany(versions.slice(i, i + 4000));
    const comments = versions.slice(0, 12000).map((v) => ({ _id: oid(), versionId: v._id, authorId: oid(), text: "c", createdAt: day(3) }));
    for (let i = 0; i < comments.length; i += 4000) await col("comments").insertMany(comments.slice(i, i + 4000));
    const users = Array.from({ length: 6000 }, (_, i) => user(`u${i}+t@corp${i % 7}.com`, "ml_engineer", { createdAt: new Date(day(1).getTime() + i) }));
    await col("users").insertMany(users);
    await runMigrations();
    const org = await col("organizations").findOne();
    expect(await col("versions").countDocuments({ orgId: org._id })).toBe(24000);
    expect(await col("comments").countDocuments({ orgId: org._id })).toBe(12000);
    expect(await col("users").countDocuments({ orgId: org._id })).toBe(6000);
    expect(await col("users").distinct("emailKey").then((a) => a.length)).toBe(6000);
    expect(Date.now() - t0).toBeLessThan(120000);
  }, 180000);

  test("children follow their parent even when parents live in DIFFERENT orgs (a partially tenant-aware database)", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const orgA = { _id: oid(), name: "A", allowedDomains: [], domainRuleEnabled: false, status: "active", codes: { ml_engineer: { value: "AAAAAAAAAAAA", used: 0, gen: 1 }, compliance_officer: { value: "BBBBBBBBBBBB", used: 0, gen: 1 } }, createdAt: day(1) };
    const orgB = { _id: oid(), name: "B", allowedDomains: [], domainRuleEnabled: false, status: "active", codes: { ml_engineer: { value: "CCCCCCCCCCCC", used: 0, gen: 1 }, compliance_officer: { value: "DDDDDDDDDDDD", used: 0, gen: 1 } }, createdAt: day(1) };
    await col("organizations").insertMany([orgA, orgB]);
    const ma = model("MA", { orgId: orgA._id });
    const mb = model("MB", { orgId: orgB._id });
    await col("models").insertMany([ma, mb]);
    const va = version(ma._id, 1);
    const vb = version(mb._id, 1);
    await col("versions").insertMany([va, vb]);
    await col("comments").insertMany([{ _id: oid(), versionId: vb._id, authorId: oid(), text: "x", createdAt: day(3) }]);
    await runMigrations();
    expect(String((await col("versions").findOne({ _id: va._id })).orgId)).toBe(String(orgA._id));
    expect(String((await col("versions").findOne({ _id: vb._id })).orgId)).toBe(String(orgB._id));
    expect(String((await col("comments").findOne()).orgId)).toBe(String(orgB._id));
    // children never leave their parents' orgs; nothing is poured into the (needless, empty) default org
    const dflt = await col("organizations").findOne({ name: "Default Organization" });
    for (const n of ["models", "versions", "comments"]) expect(await col(n).countDocuments({ orgId: dflt._id })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("SUPER_ADMIN_EMAIL promotion", () => {
  async function legacyWithSoleAdmin() {
    await col("users").insertMany([
      user("owner@acme.com", "admin", { createdAt: day(1) }),
      user("emp1@acme.com", "ml_engineer", { createdAt: day(2) }),
      user("emp2@acme.com", "compliance_officer", { createdAt: day(3) }),
    ]);
    await col("models").insertOne(model("Credit"));
  }

  test("DECISION: the sole admin of the legacy data is promoted (spec), the Default Organization is left without an admin, the migration says so loudly, employees keep working and the super admin can repair it", async () => {
    await legacyWithSoleAdmin();
    env.superAdminEmail = "owner@acme.com";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    await runMigrations();
    const owner = await col("users").findOne({ email: "owner@acme.com" });
    expect(owner).toMatchObject({ role: "super_admin", orgId: null, status: "active", isActive: true });
    const org = await col("organizations").findOne();
    expect(org).toBeTruthy();
    expect(await col("users").countDocuments({ orgId: org._id, role: "admin" })).toBe(0);
    expect(warn.mock.calls.some((c) => /no active admin/i.test(String(c[0])) && String(c[0]).includes(org.name))).toBe(true);

    // employees are not locked out
    const app = require("../app");
    const login = await request(app).post("/api/auth/login").send({ email: "emp1@acme.com", password: "Legacy-Pass1" });
    expect(login.status).toBe(200);
    // the promoted owner signs in with the old password and repairs the org by adding an admin inside it
    const so = await request(app).post("/api/auth/login").send({ email: "owner@acme.com", password: "Legacy-Pass1" });
    expect(so.status).toBe(200);
    const add = await auth(request(app).post("/api/users"), so.body.token).set("X-Org-Id", String(org._id)).send({ name: "New Admin", email: "newadmin@acme.com", role: "admin" });
    expect(add.status).toBe(201);
    // an invited admin is an admin on the way: the warning stops
    warn.mockClear();
    await runMigrations();
    expect(warn.mock.calls.some((c) => /no active admin/i.test(String(c[0])))).toBe(false);
  });

  test("promotion never demotes, is idempotent, works through +tag/case variants and does not hand the owner an organization", async () => {
    await legacyWithSoleAdmin();
    env.superAdminEmail = "OWNER+hq@acme.com".toLowerCase();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await runMigrations();
    expect((await col("users").findOne({ email: "owner@acme.com" })).role).toBe("super_admin");
    const snap = await snapshotOf();
    await runMigrations();
    expect(await snapshotOf()).toBe(snap);
    // pointing the variable elsewhere later does not demote the earlier owner
    env.superAdminEmail = "emp1@acme.com";
    await runMigrations();
    expect((await col("users").findOne({ email: "owner@acme.com" })).role).toBe("super_admin");
    expect((await col("users").findOne({ email: "emp1@acme.com" })).role).toBe("super_admin");
  });

  test("promoting an account that never set a password (unverified / invited) must not leave a dead super admin or a live one-time link", async () => {
    const org = oid();
    await col("organizations").insertOne({ _id: org, name: "O", allowedDomains: [], domainRuleEnabled: false, status: "active", codes: { ml_engineer: { value: "AAAAAAAAAAAA", used: 1, gen: 1 }, compliance_officer: { value: "BBBBBBBBBBBB", used: 0, gen: 1 } }, createdAt: day(1) });
    const tokens = { verifyTokenHash: "v".repeat(64), verifyExpiresAt: new Date(Date.now() + 1e7), setupTokenHash: "s".repeat(64), setupExpiresAt: new Date(Date.now() + 1e7) };
    const squatter = user("ceo@platform.io", "ml_engineer", { orgId: org, status: "unverified", emailKey: "ceo@platform.io", passwordHash: await bcrypt.hash("random-unknowable-" + Math.random(), 4), seatKind: "ml_engineer", seatGen: 1, ...tokens });
    await col("users").insertOne(squatter);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    // no usable password configured: nothing may be promoted into an account nobody can sign in to
    const none = await ensureSuperAdminDetailed({ email: "ceo@platform.io", password: "" });
    expect(none.action).not.toBe("promoted");
    expect((await col("users").findOne({ _id: squatter._id })).role).toBe("ml_engineer");

    // with the operator's password: promoted AND the operator's password is the one that works
    const ok = await ensureSuperAdminDetailed({ email: "ceo@platform.io", password: "Operator-Pass-1" });
    expect(ok.action).toBe("promoted");
    const row = await col("users").findOne({ _id: squatter._id });
    expect(row).toMatchObject({ role: "super_admin", orgId: null, status: "active" });
    expect(row.verifyTokenHash).toBeUndefined();
    expect(row.setupTokenHash).toBeUndefined();
    expect(await bcrypt.compare("Operator-Pass-1", row.passwordHash)).toBe(true);
  });
});

describe("environment password policy for the seeded super admin", () => {
  test.each([
    ["", "no password"],
    ["short", "shorter"],
    ["1234567", "shorter"],
    ["x".repeat(73), "longer than 72"],
    ["é".repeat(37), "longer than 72"], // 74 bytes
  ])("password %j is refused, nothing is created, boot continues", async (password, why) => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    const r = await ensureSuperAdminDetailed({ email: "root@platform.io", password });
    expect(r.action).toBe("skipped");
    expect(r.message).toMatch(new RegExp(why));
    if (password.length > 8) expect(r.message).not.toContain(password);
    expect(await col("users").countDocuments()).toBe(0);
    env.superAdminEmail = "root@platform.io";
    env.superAdminPassword = password;
    await expect(runMigrations()).resolves.toBeDefined();
    expect(await col("users").countDocuments()).toBe(0);
  });

  test("a valid password creates the owner once, even with two instances racing; the hash is bcrypt, no org, status active", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    await ensureIndexes();
    const rs = await Promise.all(Array.from({ length: 4 }, () => ensureSuperAdminDetailed({ email: "root@platform.io", password: "Operator-Pass-1" })));
    expect(rs.filter((r) => r.action === "created")).toHaveLength(1);
    for (const r of rs) expect(["created", "unchanged"]).toContain(r.action);
    const rows = await col("users").find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "super_admin", orgId: null, status: "active", emailKey: "root@platform.io" });
    expect(rows[0].passwordHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(await col("auditlogs").find().toArray())).not.toContain("Operator-Pass-1");
  });

  test("an invalid SUPER_ADMIN_EMAIL never reaches a query as an operator and a hostile one cannot match several accounts", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await col("users").insertMany([user("a@acme.com", "ml_engineer"), user("b@acme.com", "ml_engineer")]);
    const r = await ensureSuperAdminDetailed({ email: "{\"$ne\":null}", password: "Operator-Pass-1" });
    expect(await col("users").countDocuments({ role: "super_admin" })).toBeLessThanOrEqual(1);
    expect(await col("users").countDocuments({ role: "ml_engineer" })).toBe(2);
    expect(r.action).not.toBe("promoted");
  });
});

// ---------------------------------------------------------------------------------------------
describe("npm run seed:superadmin (real child process, throwaway database)", () => {
  const { spawnSync } = require("child_process");
  const path = require("path");
  const SEED_DB = `${process.env.TEST_DB_NAME || "modelward_jest"}_seed`;
  const run = (extra) =>
    spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "seedSuperAdmin.js")], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        MONGO_URI: `mongodb://127.0.0.1:27017/${SEED_DB}`,
        JWT_SECRET: "test_secret_test_secret_test_secret_123456",
        SUPER_ADMIN_EMAIL: "",
        SUPER_ADMIN_PASSWORD: "",
        SUPER_ADMIN_NAME: "",
        ...extra,
      },
    });
  const seedCol = async (name) => {
    const c = await mongoose.createConnection(`mongodb://127.0.0.1:27017/${SEED_DB}`).asPromise();
    try {
      return await c.collection(name).find().toArray();
    } finally {
      await c.close();
    }
  };
  const dropSeedDb = async () => {
    const c = await mongoose.createConnection(`mongodb://127.0.0.1:27017/${SEED_DB}`).asPromise();
    await c.dropDatabase();
    await c.close();
  };
  beforeEach(dropSeedDb);
  afterAll(dropSeedDb);

  test("no SUPER_ADMIN_EMAIL, or a password that breaks the policy: exit 1, nothing written, the password is never printed", async () => {
    for (const extra of [{}, { SUPER_ADMIN_EMAIL: "root@platform.io" }, { SUPER_ADMIN_EMAIL: "root@platform.io", SUPER_ADMIN_PASSWORD: "tiny" }, { SUPER_ADMIN_EMAIL: "root@platform.io", SUPER_ADMIN_PASSWORD: "x".repeat(80) }]) {
      const r = run(extra);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).not.toContain("x".repeat(80));
      expect(await seedCol("users")).toHaveLength(0);
    }
  }, 120000);

  test("valid input creates the owner (exit 0), a rerun is a no-op, and a stored hash - not the password - is all that remains", async () => {
    const extra = { SUPER_ADMIN_EMAIL: "Root@Platform.io", SUPER_ADMIN_PASSWORD: "Operator-Pass-1", SUPER_ADMIN_NAME: "Boss" };
    const first = run(extra);
    expect(first.status).toBe(0);
    expect(first.stdout + first.stderr).not.toContain("Operator-Pass-1");
    const rows = await seedCol("users");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "root@platform.io", role: "super_admin", status: "active", name: "Boss", orgId: null });
    expect(rows[0].passwordHash).toMatch(/^\$2[aby]\$/);
    const second = run(extra);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/unchanged/);
    expect(await seedCol("users")).toHaveLength(1);
    // a different password in a later run never silently changes the existing owner's password
    const third = run({ ...extra, SUPER_ADMIN_PASSWORD: "Another-Pass-9" });
    expect(third.status).toBe(0);
    expect((await seedCol("users"))[0].passwordHash).toBe(rows[0].passwordHash);
  }, 120000);
});
