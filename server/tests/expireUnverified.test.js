const User = require("../models/User");
const Organization = require("../models/Organization");
const { expireUnverified, startExpiryJob } = require("../jobs/expireUnverified");
const { reserveSeat } = require("../utils/joinCodes");
const { connect, reset, disconnect, makeUser, makeOrg, sys } = require("./helpers");

const HOUR = 60 * 60 * 1000;
const used = async (org, kind) => (await Organization.findById(org._id)).codes[kind].used;
const exists = async (id) => !!(await sys(User).findOne({ _id: id }).lean());

beforeAll(connect);
afterAll(disconnect);
beforeEach(reset);

// A signed-up account: a seat is reserved and the user holds it.
async function signedUp(org, kind, status, verifyExpiresAt) {
  const fresh = await Organization.findById(org._id);
  const reserved = await reserveSeat(fresh, kind);
  const { user } = await makeUser(kind, {
    orgId: org._id,
    status,
    extra: { seatKind: kind, seatGen: reserved.codes[kind].gen, verifyExpiresAt },
  });
  return user;
}

describe("expireUnverified", () => {
  test("removes only unverified accounts past their deadline and releases their seats", async () => {
    const org = await makeOrg();
    const other = await makeOrg();
    const past = new Date(Date.now() - HOUR);
    const future = new Date(Date.now() + HOUR);
    const expiredEng = await signedUp(org, "ml_engineer", "unverified", past);
    const expiredCo = await signedUp(org, "compliance_officer", "unverified", past);
    const expiredOther = await signedUp(other, "ml_engineer", "unverified", past);
    const fresh = await signedUp(org, "ml_engineer", "unverified", future);
    // statuses that must never be touched, even with an old deadline
    const pending = await signedUp(org, "ml_engineer", "pending", past);
    const active = await signedUp(org, "ml_engineer", "active", past);
    const invited = (await makeUser("admin", { orgId: org._id, status: "invited", extra: { verifyExpiresAt: past } })).user;
    const noDeadline = await signedUp(org, "ml_engineer", "unverified", undefined);
    expect(await used(org, "ml_engineer")).toBe(5);
    expect(await used(org, "compliance_officer")).toBe(1);

    expect(await expireUnverified()).toEqual({ removed: 3 });

    for (const gone of [expiredEng, expiredCo, expiredOther]) expect(await exists(gone._id)).toBe(false);
    for (const kept of [fresh, pending, active, invited, noDeadline]) expect(await exists(kept._id)).toBe(true);
    expect(await used(org, "ml_engineer")).toBe(4); // 5 - 1
    expect(await used(org, "compliance_officer")).toBe(0);
    expect(await used(other, "ml_engineer")).toBe(0);

    expect(await expireUnverified()).toEqual({ removed: 0 }); // idempotent
    expect(await used(org, "ml_engineer")).toBe(4);
  });

  test("a regenerated code is not credited (seat generation mismatch) and an unverified user without a seat is fine", async () => {
    const org = await makeOrg();
    const stale = await signedUp(org, "ml_engineer", "unverified", new Date(Date.now() - HOUR));
    const noSeat = (await makeUser("ml_engineer", { orgId: org._id, status: "unverified", extra: { verifyExpiresAt: new Date(Date.now() - HOUR) } })).user;
    await Organization.updateOne({ _id: org._id }, { $set: { "codes.ml_engineer.gen": 7, "codes.ml_engineer.used": 0 } });
    expect(await expireUnverified()).toEqual({ removed: 2 });
    expect(await exists(stale._id)).toBe(false);
    expect(await exists(noSeat._id)).toBe(false);
    expect(await used(org, "ml_engineer")).toBe(0);
  });

  test("an account verified between the lookup and the delete survives", async () => {
    const org = await makeOrg();
    const u = await signedUp(org, "ml_engineer", "unverified", new Date(Date.now() - HOUR));
    const original = User.find;
    // the user clicks the link right after the job read the expired list
    User.find = function patched(...args) {
      const q = original.apply(this, args);
      const exec = q.lean.bind(q);
      q.lean = (...a) => {
        const r = exec(...a);
        return r.then(async (rows) => {
          await User.collection.updateOne({ _id: u._id }, { $set: { status: "pending" } });
          return rows;
        });
      };
      return q;
    };
    try {
      expect(await expireUnverified()).toEqual({ removed: 0 });
    } finally {
      User.find = original;
    }
    expect(await exists(u._id)).toBe(true);
    expect(await used(org, "ml_engineer")).toBe(1); // seat kept
  });

  test("startExpiryJob is a no-op under test (no timers)", () => {
    const spy = jest.spyOn(global, "setInterval");
    startExpiryJob();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
