const { connect, reset, disconnect } = require("./helpers");

let Organization, jc;
let n = 0;

async function makeOrg(over = {}) {
  n += 1;
  return Organization.create({ name: `Org ${n} ${Date.now()}`, codes: jc.newCodes(), ...over });
}
const reload = (org) => Organization.findById(org._id);

beforeAll(async () => {
  await connect();
  Organization = require("../models/Organization");
  jc = require("../utils/joinCodes");
});
beforeEach(reset);
afterAll(disconnect);

describe("code format helpers", () => {
  test("generateCode: 12 chars from the unambiguous alphabet, random", () => {
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) {
      const c = jc.generateCode();
      expect(c).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(300);
  });

  test("generate -> format -> normalize round trip", () => {
    for (let i = 0; i < 50; i += 1) {
      const c = jc.generateCode();
      const shown = jc.formatCode(c);
      expect(shown).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(jc.normalizeCode(shown)).toBe(c);
      expect(jc.normalizeCode(shown.toLowerCase())).toBe(c);
      expect(jc.normalizeCode(`  ${shown.replace(/-/g, " ")} `)).toBe(c);
      expect(jc.normalizeCode(c)).toBe(c);
    }
    expect(jc.formatCode("")).toBe("");
    expect(jc.formatCode(null)).toBe("");
    expect(jc.formatCode("ABCD")).toBe("ABCD");
  });

  test("normalizeCode rejects ambiguous characters, wrong lengths and non-strings", () => {
    for (const bad of ["ABCDEFGHJKL0", "ABCDEFGHJKLO", "ABCDEFGHJKL1", "ABCDEFGHJKLI", "oooooooooooo", "ABCDEFGHJKL", "ABCDEFGHJKLMN", "", "   ", "ABCD-EFGH-JKL!", "ABCD_EFGH_JKLM", "ÅBCDEFGHJKLM"]) {
      expect(jc.normalizeCode(bad)).toBeNull();
    }
    for (const bad of [null, undefined, 123456789012, {}, [], ["ABCDEFGHJKLM"], { $gt: "" }, true]) {
      expect(jc.normalizeCode(bad)).toBeNull();
    }
    expect(jc.normalizeCode("A".repeat(1000))).toBeNull();
    expect(jc.normalizeCode("ABCD-EFGH-JKLM")).toBe("ABCDEFGHJKLM");
  });

  test("newCodes: two distinct codes, no expiry/limit, gen 1; regenerating bumps gen and resets", () => {
    const c = jc.newCodes();
    expect(jc.KINDS).toEqual(["ml_engineer", "compliance_officer"]);
    expect(c.ml_engineer.value).not.toBe(c.compliance_officer.value);
    expect(c.ml_engineer).toMatchObject({ expiresAt: null, seatLimit: null, used: 0, gen: 1 });
    const next = jc.newCodeEntry({ ...c.ml_engineer, used: 4, seatLimit: 5, gen: 3 });
    expect(next).toMatchObject({ expiresAt: null, seatLimit: null, used: 0, gen: 4 });
    expect(next.value).not.toBe(c.ml_engineer.value);
  });
});

describe("findOrgByCode", () => {
  test("finds the org and the kind for both codes, however the code is typed", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    for (const kind of jc.KINDS) {
      for (const typed of [a.codes[kind].value, jc.formatCode(a.codes[kind].value), jc.formatCode(a.codes[kind].value).toLowerCase()]) {
        const found = await jc.findOrgByCode(typed);
        expect(found.kind).toBe(kind);
        expect(String(found.org._id)).toBe(String(a._id));
      }
      expect(String((await jc.findOrgByCode(b.codes[kind].value)).org._id)).toBe(String(b._id));
    }
  });

  test("unknown, malformed, short and injected codes give null", async () => {
    const a = await makeOrg();
    expect(await jc.findOrgByCode("ABCDEFGHJKLM")).toBeNull();
    expect(await jc.findOrgByCode(a.codes.ml_engineer.value.slice(0, 11))).toBeNull();
    expect(await jc.findOrgByCode(a.codes.ml_engineer.value.slice(0, 4))).toBeNull();
    expect(await jc.findOrgByCode(a.codes.ml_engineer.value + "A")).toBeNull();
    expect(await jc.findOrgByCode("")).toBeNull();
    expect(await jc.findOrgByCode(undefined)).toBeNull();
    expect(await jc.findOrgByCode({ $ne: null })).toBeNull();
    expect(await jc.findOrgByCode(["ABCDEFGHJKLM"])).toBeNull();
  });

  test("a regenerated code stops matching immediately; the new one works", async () => {
    const a = await makeOrg();
    const old = a.codes.compliance_officer.value;
    a.codes.compliance_officer = jc.newCodeEntry(a.codes.compliance_officer);
    await a.save();
    expect(await jc.findOrgByCode(old)).toBeNull();
    expect((await jc.findOrgByCode(a.codes.compliance_officer.value)).kind).toBe("compliance_officer");
  });
});

describe("codeProblem", () => {
  test("null when usable; suspended / expired / full otherwise", async () => {
    const org = await makeOrg();
    expect(jc.codeProblem(org, "ml_engineer")).toBeNull();

    const now = new Date("2026-01-01T00:00:00Z");
    org.codes.ml_engineer.expiresAt = new Date("2025-12-31T23:59:59Z");
    expect(jc.codeProblem(org, "ml_engineer", now)).toBe("expired");
    org.codes.ml_engineer.expiresAt = now; // boundary: expiresAt <= now is expired
    expect(jc.codeProblem(org, "ml_engineer", now)).toBe("expired");
    org.codes.ml_engineer.expiresAt = new Date("2026-01-01T00:00:01Z");
    expect(jc.codeProblem(org, "ml_engineer", now)).toBeNull();
    expect(jc.codeProblem(org, "compliance_officer", now)).toBeNull(); // other kind unaffected

    org.codes.ml_engineer.expiresAt = null;
    org.codes.ml_engineer.seatLimit = 2;
    org.codes.ml_engineer.used = 1;
    expect(jc.codeProblem(org, "ml_engineer")).toBeNull();
    org.codes.ml_engineer.used = 2;
    expect(jc.codeProblem(org, "ml_engineer")).toBe("full");

    org.status = "suspended";
    expect(jc.codeProblem(org, "compliance_officer")).toBe("suspended"); // suspension wins
  });
});

describe("reserveSeat / releaseSeat", () => {
  test("20 concurrent reservations with seatLimit 5: exactly 5 succeed and used never exceeds the limit", async () => {
    const org = await makeOrg();
    org.codes.ml_engineer.seatLimit = 5;
    await org.save();
    const fresh = await reload(org);
    const results = await Promise.all(Array.from({ length: 20 }, () => jc.reserveSeat(fresh, "ml_engineer")));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect((await reload(org)).codes.ml_engineer.used).toBe(5);
    expect((await reload(org)).codes.compliance_officer.used).toBe(0);
    expect(await jc.reserveSeat(fresh, "ml_engineer")).toBeNull(); // stays full
    // the returned doc is the updated one
    const first = results.filter(Boolean).map((o) => o.codes.ml_engineer.used).sort();
    expect(first[0]).toBeGreaterThanOrEqual(1);
    expect(first[first.length - 1]).toBe(5);
  });

  test("no seat limit: every reservation succeeds", async () => {
    const org = await makeOrg();
    const results = await Promise.all(Array.from({ length: 20 }, () => jc.reserveSeat(org, "compliance_officer")));
    expect(results.every(Boolean)).toBe(true);
    expect((await reload(org)).codes.compliance_officer.used).toBe(20);
  });

  test("expiry race: a stale in-memory org that still looks usable cannot take a seat after the code expired", async () => {
    const org = await makeOrg();
    const stale = await reload(org);
    expect(jc.codeProblem(stale, "ml_engineer")).toBeNull();
    await Organization.updateOne({ _id: org._id }, { $set: { "codes.ml_engineer.expiresAt": new Date(Date.now() - 1000) } });
    expect(await jc.reserveSeat(stale, "ml_engineer")).toBeNull();
    expect((await reload(org)).codes.ml_engineer.used).toBe(0);
    // a future expiry still works
    await Organization.updateOne({ _id: org._id }, { $set: { "codes.ml_engineer.expiresAt": new Date(Date.now() + 60000) } });
    expect(await jc.reserveSeat(stale, "ml_engineer")).not.toBeNull();
  });

  test("a suspended org or a regenerated code cannot be reserved from a stale object", async () => {
    const org = await makeOrg();
    const stale = await reload(org);
    await Organization.updateOne({ _id: org._id }, { $set: { status: "suspended" } });
    expect(await jc.reserveSeat(stale, "ml_engineer")).toBeNull();
    await Organization.updateOne({ _id: org._id }, { $set: { status: "active", "codes.ml_engineer.value": jc.generateCode() } });
    expect(await jc.reserveSeat(stale, "ml_engineer")).toBeNull();
    expect((await reload(org)).codes.ml_engineer.used).toBe(0);
  });

  test("releaseSeat gives a seat back for the same gen, never goes below zero", async () => {
    const org = await makeOrg();
    await jc.reserveSeat(org, "ml_engineer");
    await jc.reserveSeat(org, "ml_engineer");
    await jc.releaseSeat(org._id, "ml_engineer", 1);
    expect((await reload(org)).codes.ml_engineer.used).toBe(1);
    await jc.releaseSeat(org._id, "ml_engineer", 1);
    await jc.releaseSeat(org._id, "ml_engineer", 1);
    await jc.releaseSeat(org._id, "ml_engineer", 1);
    expect((await reload(org)).codes.ml_engineer.used).toBe(0);
  });

  test("releaseSeat with a stale gen (after regenerate) is a no-op", async () => {
    const org = await makeOrg();
    await jc.reserveSeat(org, "compliance_officer"); // seat taken under gen 1
    const cur = await reload(org);
    cur.codes.compliance_officer = jc.newCodeEntry(cur.codes.compliance_officer); // gen 2, used reset to 0
    await cur.save();
    const again = await reload(org);
    await jc.reserveSeat(again, "compliance_officer"); // a new signup under gen 2
    expect((await reload(org)).codes.compliance_officer).toMatchObject({ gen: 2, used: 1 });
    await jc.releaseSeat(org._id, "compliance_officer", 1); // the old account is deleted: must not free the new seat
    expect((await reload(org)).codes.compliance_officer.used).toBe(1);
  });

  test("releaseSeat ignores bad kinds, null gen and unknown orgs", async () => {
    const org = await makeOrg();
    await jc.reserveSeat(org, "ml_engineer");
    await jc.releaseSeat(org._id, "admin", 1);
    await jc.releaseSeat(org._id, "ml_engineer", null);
    await jc.releaseSeat(org._id, "ml_engineer", undefined);
    await jc.releaseSeat(org._id, "codes.ml_engineer.used", 1);
    await jc.releaseSeat(new (require("mongoose").Types.ObjectId)(), "ml_engineer", 1);
    expect((await reload(org)).codes.ml_engineer.used).toBe(1);
  });

  test("reserve, release, reserve again against a limit of 1", async () => {
    const org = await makeOrg();
    org.codes.ml_engineer.seatLimit = 1;
    await org.save();
    const o = await reload(org);
    expect(await jc.reserveSeat(o, "ml_engineer")).not.toBeNull();
    expect(await jc.reserveSeat(o, "ml_engineer")).toBeNull();
    await jc.releaseSeat(org._id, "ml_engineer", 1);
    expect(await jc.reserveSeat(o, "ml_engineer")).not.toBeNull();
  });
});
