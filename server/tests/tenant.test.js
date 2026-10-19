const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { connect, reset, disconnect, makeUser, makeOrg, defaultOrg, sys, auth } = require("./helpers");
const { als, runWithOrg, runSystem, currentOrgId, TenantContextError, TenantViolationError, updateTouchesOrg } = require("../utils/tenant");

const { ObjectId } = mongoose.Types;
const oid = () => new ObjectId();

let ModelM, Version, Comment, Snapshot, AuditLog, Settings, User, Organization;
let writeAuditLog, authGuard, roleGuard, errorHandlerMod, auditChain, crossOrg, settingsUtil, httpErrors, env;
let A, B; // two organizations

beforeAll(async () => {
  await connect();
  ModelM = require("../models/Model");
  Version = require("../models/Version");
  Comment = require("../models/Comment");
  Snapshot = require("../models/MetricSnapshot");
  AuditLog = require("../models/AuditLog");
  Settings = require("../models/Settings");
  User = require("../models/User");
  Organization = require("../models/Organization");
  writeAuditLog = require("../middleware/audit");
  authGuard = require("../middleware/auth");
  roleGuard = require("../middleware/role");
  errorHandlerMod = require("../middleware/errorHandler");
  auditChain = require("../utils/auditChain");
  crossOrg = require("../utils/crossOrg");
  settingsUtil = require("../utils/settings");
  httpErrors = require("../utils/httpErrors");
  env = require("../config/env");
});
afterAll(disconnect);
beforeEach(async () => {
  await reset();
  A = await makeOrg({ name: "Org A" });
  B = await makeOrg({ name: "Org B" });
});

const inA = (fn) => runWithOrg(A._id, fn);
const inB = (fn) => runWithOrg(B._id, fn);
// Seeds a row in a chosen org from outside any request.
const mkModel = (org, name, extra = {}) => runSystem(() => ModelM.create({ name, createdBy: oid(), orgId: org._id, ...extra }));
const mkVersion = (org, modelId, n = 1, extra = {}) =>
  runSystem(() => Version.create({ modelId, versionNumber: n, fileType: "csv", createdBy: oid(), orgId: org._id, ...extra }));
const names = (docs) => docs.map((d) => d.name).sort();
const rejection = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
};

describe("context primitives", () => {
  test("currentOrgId / runWithOrg / runSystem / nesting", async () => {
    expect(currentOrgId()).toBeNull();
    expect(als.getStore()).toBeUndefined();
    const r = await runWithOrg(A._id, async () => {
      expect(String(currentOrgId())).toBe(String(A._id));
      await new Promise((res) => setTimeout(res, 5)); // survives awaits
      expect(String(currentOrgId())).toBe(String(A._id));
      const inner = await runWithOrg(String(B._id), async () => String(currentOrgId())); // string ids accepted
      expect(inner).toBe(String(B._id));
      expect(String(currentOrgId())).toBe(String(A._id)); // restored
      return "done";
    });
    expect(r).toBe("done");
    expect(als.getStore()).toBeUndefined();
    runSystem(() => {
      expect(als.getStore()).toEqual({ orgId: null, bypass: true });
      expect(currentOrgId()).toBeNull();
    });
    runWithOrg(null, () => expect(als.getStore()).toEqual({ orgId: null, bypass: false }));
  });

  test("runWithOrg rejects a malformed org id", () => {
    expect(() => runWithOrg("nope", () => {})).toThrow(TypeError);
  });

  test("concurrent contexts do not leak into each other", async () => {
    await mkModel(A, "a-only");
    await mkModel(B, "b-only");
    const delays = [30, 1, 15, 5];
    const out = await Promise.all(
      delays.map((d, i) =>
        runWithOrg(i % 2 ? B._id : A._id, async () => {
          await new Promise((r) => setTimeout(r, d));
          return names(await ModelM.find().lean());
        })
      )
    );
    expect(out).toEqual([["a-only"], ["b-only"], ["a-only"], ["b-only"]]);
  });

  test("TenantContextError shape", () => {
    const e = new TenantContextError();
    expect(e).toMatchObject({ name: "TenantContextError", status: 400, code: "ORG_REQUIRED", message: "Select an organization first" });
    expect(e).toBeInstanceOf(Error);
  });
});

describe("query filtering", () => {
  let a1, a2, b1;
  beforeEach(async () => {
    a1 = await mkModel(A, "alpha");
    a2 = await mkModel(A, "beta", { useCase: "x" });
    b1 = await mkModel(B, "gamma", { useCase: "x" });
  });

  test("find / findOne / findById only see the current org", async () => {
    expect(names(await inA(() => ModelM.find()))).toEqual(["alpha", "beta"]);
    expect(names(await inB(() => ModelM.find()))).toEqual(["gamma"]);
    expect(await inA(() => ModelM.findOne({ name: "gamma" }))).toBeNull();
    expect(await inA(() => ModelM.findById(b1._id))).toBeNull();
    expect((await inB(() => ModelM.findById(b1._id)))._id.toString()).toBe(String(b1._id));
    expect(await inA(() => ModelM.exists({ _id: b1._id }))).toBeNull();
    expect(await inA(() => ModelM.exists({ _id: a1._id }))).toBeTruthy();
  });

  test("countDocuments / distinct", async () => {
    expect(await inA(() => ModelM.countDocuments())).toBe(2);
    expect(await inA(() => ModelM.countDocuments({ useCase: "x" }))).toBe(1);
    expect((await inA(() => ModelM.distinct("name"))).sort()).toEqual(["alpha", "beta"]);
    expect(await inB(() => ModelM.distinct("name"))).toEqual(["gamma"]);
  });

  test("updateOne / updateMany / findOneAndUpdate cannot touch another org", async () => {
    const r1 = await inA(() => ModelM.updateOne({ _id: b1._id }, { $set: { description: "hacked" } }));
    expect(r1.matchedCount).toBe(0);
    const r2 = await inA(() => ModelM.updateMany({}, { $set: { description: "mine" } }));
    expect(r2.matchedCount).toBe(2);
    expect(await inA(() => ModelM.findOneAndUpdate({ _id: b1._id }, { description: "hacked" }, { new: true }))).toBeNull();
    const own = await inA(() => ModelM.findOneAndUpdate({ _id: a1._id }, { description: "ok" }, { new: true }));
    expect(own.description).toBe("ok");
    const b = await sys(ModelM).findById(b1._id).lean();
    expect(b.description).toBe("");
  });

  test("deleteOne / deleteMany / findOneAndDelete cannot touch another org", async () => {
    expect((await inA(() => ModelM.deleteOne({ _id: b1._id }))).deletedCount).toBe(0);
    expect(await inA(() => ModelM.findOneAndDelete({ _id: b1._id }))).toBeNull();
    expect((await inA(() => ModelM.deleteMany({ useCase: "x" }))).deletedCount).toBe(1);
    expect(await sys(ModelM).countDocuments()).toBe(2); // alpha + gamma left
    expect(await sys(ModelM).exists({ _id: b1._id })).toBeTruthy();
  });

  test("aggregate is prefixed with an org $match (and keeps the caller's own stages)", async () => {
    const rows = await inA(() => ModelM.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]));
    expect(rows).toEqual([{ _id: null, n: 2 }]);
    const own = await inB(() => ModelM.aggregate([{ $match: { useCase: "x" } }, { $count: "n" }]));
    expect(own).toEqual([{ n: 1 }]);
    // a $match for another org's rows cannot widen it
    const attack = await inA(() => ModelM.aggregate([{ $match: { orgId: B._id } }]));
    expect(attack).toEqual([]);
  });

  test("aggregate refuses pipelines that must start with a special stage", async () => {
    const e = await rejection(inA(() => ModelM.aggregate([{ $geoNear: { near: [0, 0], distanceField: "d" } }])));
    expect(e).toBeInstanceOf(TenantViolationError);
  });

  test("estimatedDocumentCount and bulkWrite are refused in a scoped context, allowed for the system", async () => {
    expect(await rejection(inA(() => ModelM.estimatedDocumentCount()))).toBeInstanceOf(TenantViolationError);
    expect(await rejection(inA(() => ModelM.bulkWrite([{ updateOne: { filter: {}, update: { $set: { description: "x" } } } }])))).toBeInstanceOf(
      TenantViolationError
    );
    expect(await runSystem(() => ModelM.estimatedDocumentCount())).toBe(3);
    const r = await runSystem(() => ModelM.bulkWrite([{ updateOne: { filter: { name: "gamma" }, update: { $set: { description: "bw" } } } }]));
    expect(r.modifiedCount).toBe(1);
    expect(await rejection(ModelM.bulkWrite([]))).toBeInstanceOf(TenantContextError);
  });

  test("a cursor is scoped too", async () => {
    const seen = [];
    await inA(() => ModelM.find().cursor().eachAsync((d) => seen.push(d.name)));
    expect(seen.sort()).toEqual(["alpha", "beta"]);
  });

  test("the same holds for every other tenant model", async () => {
    const m = a1;
    const vA = await mkVersion(A, m._id);
    const mB = await mkModel(B, "other");
    const vB = await mkVersion(B, mB._id);
    expect((await inA(() => Version.find())).map((v) => String(v._id))).toEqual([String(vA._id)]);
    expect(await inA(() => Version.findById(vB._id))).toBeNull();
    await runSystem(() => Comment.create({ versionId: vB._id, authorId: oid(), authorName: "x", authorRole: "admin", body: "hi", orgId: B._id }));
    await runSystem(() => Snapshot.create({ versionId: vB._id, accuracy: 0.9, fairnessGap: 0.1, orgId: B._id }));
    expect(await inA(() => Comment.countDocuments())).toBe(0);
    expect(await inA(() => Snapshot.countDocuments())).toBe(0);
    expect(await inB(() => Comment.countDocuments())).toBe(1);
    expect(await inB(() => Snapshot.countDocuments())).toBe(1);
  });
});

describe("fail closed", () => {
  beforeEach(async () => {
    await mkModel(A, "alpha");
  });

  const everyOp = {
    find: () => ModelM.find(),
    findOne: () => ModelM.findOne(),
    findById: () => ModelM.findById(oid()),
    findOneAndUpdate: () => ModelM.findOneAndUpdate({}, { description: "x" }),
    findOneAndDelete: () => ModelM.findOneAndDelete({}),
    findOneAndReplace: () => ModelM.findOneAndReplace({}, { name: "x", createdBy: oid() }),
    countDocuments: () => ModelM.countDocuments(),
    updateOne: () => ModelM.updateOne({}, { description: "x" }),
    updateMany: () => ModelM.updateMany({}, { description: "x" }),
    deleteOne: () => ModelM.deleteOne({}),
    deleteMany: () => ModelM.deleteMany({}),
    replaceOne: () => ModelM.replaceOne({}, { name: "x", createdBy: oid() }),
    distinct: () => ModelM.distinct("name"),
    exists: () => ModelM.exists({}),
    estimatedDocumentCount: () => ModelM.estimatedDocumentCount(),
    aggregate: () => ModelM.aggregate([{ $count: "n" }]),
  };

  test.each(Object.keys(everyOp))("%s without any context throws TenantContextError", async (op) => {
    const e = await rejection(everyOp[op]());
    expect(e).toBeInstanceOf(TenantContextError);
    expect(e.code).toBe("ORG_REQUIRED");
  });

  test("a store with a null org (super admin, nothing selected) fails closed too", async () => {
    expect(await rejection(runWithOrg(null, () => ModelM.find()))).toBeInstanceOf(TenantContextError);
    expect(await rejection(runWithOrg(null, () => ModelM.aggregate([{ $count: "n" }])))).toBeInstanceOf(TenantContextError);
  });

  test("every tenant model fails closed", async () => {
    for (const M of [ModelM, Version, Comment, Snapshot, Settings, AuditLog]) {
      expect(await rejection(M.find())).toBeInstanceOf(TenantContextError);
    }
  });

  test("User queries fail closed as well", async () => {
    expect(await rejection(User.findOne({ email: "x@y.z" }))).toBeInstanceOf(TenantContextError);
  });
});

describe("bypass", () => {
  beforeEach(async () => {
    await mkModel(A, "alpha");
    await mkModel(B, "gamma");
  });

  test("option bypassTenant:true on a query", async () => {
    expect(names(await ModelM.find().setOptions({ bypassTenant: true }))).toEqual(["alpha", "gamma"]);
    expect(await ModelM.countDocuments().setOptions({ bypassTenant: true })).toBe(2);
    // also inside a context it widens the query (that is what the option is for)
    expect(names(await inA(() => ModelM.find().setOptions({ bypassTenant: true })))).toEqual(["alpha", "gamma"]);
  });

  test("only the exact value true bypasses", async () => {
    for (const v of ["true", 1, {}, "yes"]) {
      expect(await rejection(ModelM.find().setOptions({ bypassTenant: v }))).toBeInstanceOf(TenantContextError);
    }
    expect(names(await inA(() => ModelM.find().setOptions({ bypassTenant: "true" })))).toEqual(["alpha"]);
  });

  test("aggregate option", async () => {
    const rows = await ModelM.aggregate([{ $count: "n" }]).option({ bypassTenant: true });
    expect(rows).toEqual([{ n: 2 }]);
  });

  test("runSystem, and the sys() test helper", async () => {
    expect(await runSystem(() => ModelM.countDocuments())).toBe(2);
    expect(await sys(ModelM).countDocuments()).toBe(2);
    expect(names(await sys(ModelM).find().lean())).toEqual(["alpha", "gamma"]);
    expect((await sys(ModelM).aggregate([{ $count: "n" }]))[0].n).toBe(2);
    expect(await sys(ModelM).distinct("name")).toHaveLength(2);
    expect(sys(ModelM).modelName).toBe("Model");
  });

  test("populate does not inherit bypassTenant from its parent query", async () => {
    const m = await mkModel(B, "pop");
    await mkVersion(A, m._id, 1);
    // runSystem covers the populate query as well
    const v = await runSystem(() => Version.findOne().populate("modelId"));
    expect(v.modelId.name).toBe("pop");
    // inside org A the foreign model does not populate
    const v2 = await inA(() => Version.findOne().populate("modelId"));
    expect(v2.modelId).toBeNull();
    // explicit populate option is how a query-level bypass is spelled
    const v3 = await Version.findOne().setOptions({ bypassTenant: true }).populate({ path: "modelId", options: { bypassTenant: true } });
    expect(v3.modelId.name).toBe("pop");
  });
});

describe("create rules", () => {
  test("save of a new doc takes the context org", async () => {
    const d = await inA(() => ModelM.create({ name: "n1", createdBy: oid() }));
    expect(String(d.orgId)).toBe(String(A._id));
    const d2 = await inB(() => new ModelM({ name: "n1", createdBy: oid() }).save()); // same name, other org: fine
    expect(String(d2.orgId)).toBe(String(B._id));
  });

  test("an explicit orgId equal to the context org is fine; a different one throws", async () => {
    await inA(() => ModelM.create({ name: "same", createdBy: oid(), orgId: A._id }));
    const e = await rejection(inA(() => ModelM.create({ name: "other", createdBy: oid(), orgId: B._id })));
    expect(e).toBeInstanceOf(TenantViolationError);
    expect(await sys(ModelM).countDocuments({ name: "other" })).toBe(0);
  });

  test("no context: explicit orgId required (signup / seed / migration)", async () => {
    const d = await ModelM.create({ name: "seeded", createdBy: oid(), orgId: B._id });
    expect(String(d.orgId)).toBe(String(B._id));
    expect(await rejection(ModelM.create({ name: "orphan", createdBy: oid() }))).toBeInstanceOf(TenantContextError);
    expect(await rejection(runSystem(() => ModelM.create({ name: "orphan", createdBy: oid() })))).toBeInstanceOf(TenantContextError);
    expect(await rejection(runWithOrg(null, () => ModelM.create({ name: "orphan", createdBy: oid() })))).toBeInstanceOf(TenantContextError);
  });

  test("system context may create in any org", async () => {
    await runSystem(async () => {
      await ModelM.create({ name: "s-a", createdBy: oid(), orgId: A._id });
      await ModelM.create({ name: "s-b", createdBy: oid(), orgId: B._id });
    });
    expect(await sys(ModelM).countDocuments({ name: /^s-/ })).toBe(2);
  });

  test("insertMany: fills the context org, rejects foreign ones, requires an org without context", async () => {
    const docs = await inA(() => ModelM.insertMany([{ name: "i1", createdBy: oid() }, { name: "i2", createdBy: oid() }]));
    expect(docs.map((d) => String(d.orgId))).toEqual([String(A._id), String(A._id)]);
    const e = await rejection(inA(() => ModelM.insertMany([{ name: "i3", createdBy: oid() }, { name: "i4", createdBy: oid(), orgId: B._id }])));
    expect(e).toBeInstanceOf(TenantViolationError);
    expect(await sys(ModelM).countDocuments({ name: { $in: ["i3", "i4"] } })).toBe(0); // all or nothing
    expect(await rejection(ModelM.insertMany([{ name: "i5", createdBy: oid() }]))).toBeInstanceOf(TenantContextError);
    const ok = await ModelM.insertMany([{ name: "i6", createdBy: oid(), orgId: B._id }]);
    expect(String(ok[0].orgId)).toBe(String(B._id));
    const one = await inB(() => ModelM.insertMany({ name: "i7", createdBy: oid() }));
    expect(String(one[0].orgId)).toBe(String(B._id));
  });

  test("insertMany with Mongoose documents", async () => {
    const docs = await inA(() => ModelM.insertMany([new ModelM({ name: "d1", createdBy: oid() })]));
    expect(String(docs[0].orgId)).toBe(String(A._id));
  });

  test("optionalOrg models: User and AuditLog may be created without an org", async () => {
    const su = await User.create({ name: "S", email: "s@root.io", passwordHash: "x", role: "super_admin" });
    expect(su.orgId == null).toBe(true);
    // even inside an org context a super admin is never put into that org
    const su2 = await inA(() => User.create({ name: "S2", email: "s2@root.io", passwordHash: "x", role: "super_admin", orgId: B._id }));
    expect(su2.orgId).toBeNull();
    const row = await AuditLog.create({ actorName: "x", actorRole: "none", action: "login", targetType: "User" });
    expect(row.orgId == null).toBe(true);
    const platform = await inA(() => AuditLog.create({ actorName: "x", actorRole: "none", action: "login", targetType: "User", orgId: null }));
    expect(platform.orgId).toBeNull(); // explicit null = platform level, never overwritten by the context
    const filled = await inA(() => AuditLog.create({ actorName: "x", actorRole: "none", action: "login", targetType: "User" }));
    expect(String(filled.orgId)).toBe(String(A._id));
  });

  test("a non-super user must belong to an organization", async () => {
    const e = await rejection(User.create({ name: "N", email: "n@x.io", passwordHash: "x", role: "admin" }));
    expect(e.name).toBe("ValidationError");
    expect(e.errors.orgId).toBeDefined();
    const u = await inA(() => User.create({ name: "N", email: "n2@x.io", passwordHash: "x", role: "admin" }));
    expect(String(u.orgId)).toBe(String(A._id));
    const forced = await User.create({ name: "N", email: "n3@x.io", passwordHash: "x", role: "admin", orgId: B._id });
    expect(String(forced.orgId)).toBe(String(B._id));
  });
});

describe("orgId cannot be changed", () => {
  let m;
  beforeEach(async () => {
    m = await mkModel(A, "alpha");
  });

  test.each([
    ["top level", { orgId: "B" }],
    ["$set", { $set: { orgId: "B" } }],
    ["$setOnInsert", { $setOnInsert: { orgId: "B" } }],
    ["$unset", { $unset: { orgId: "" } }],
    ["$rename", { $rename: { name: "orgId" } }],
    ["$min", { $min: { orgId: "B" } }],
    ["pipeline $set", [{ $set: { orgId: "B" } }]],
    ["pipeline $replaceRoot", [{ $replaceRoot: { newRoot: { name: "x" } } }]],
  ])("update through %s throws", async (_label, upd) => {
    const body = JSON.parse(JSON.stringify(upd).replace(/"B"/g, JSON.stringify(String(B._id))));
    for (const run of [
      () => ModelM.updateOne({ _id: m._id }, body),
      () => ModelM.updateMany({}, body),
      () => ModelM.findOneAndUpdate({ _id: m._id }, body),
    ]) {
      expect(await rejection(inA(run))).toBeInstanceOf(TenantViolationError);
    }
    expect(String((await sys(ModelM).findById(m._id).lean()).orgId)).toBe(String(A._id));
  });

  test("allowed when bypassed (option or runSystem)", async () => {
    await ModelM.updateOne({ _id: m._id }, { $set: { orgId: B._id } }).setOptions({ bypassTenant: true });
    expect(String((await sys(ModelM).findById(m._id).lean()).orgId)).toBe(String(B._id));
    await runSystem(() => ModelM.updateOne({ _id: m._id }, { orgId: A._id }));
    expect(String((await sys(ModelM).findById(m._id).lean()).orgId)).toBe(String(A._id));
  });

  test("doc.save() with a modified orgId throws; saving a foreign doc throws; a normal save works", async () => {
    const doc = await inA(() => ModelM.findById(m._id));
    doc.orgId = B._id;
    expect(await rejection(inA(() => doc.save()))).toBeInstanceOf(TenantViolationError);

    const foreign = await sys(ModelM).findById(m._id); // loaded cross-tenant, org A
    foreign.description = "changed";
    expect(await rejection(inB(() => foreign.save()))).toBeInstanceOf(TenantViolationError); // org B request
    await inA(() => foreign.save());
    expect((await sys(ModelM).findById(m._id).lean()).description).toBe("changed");

    const ok = await inA(() => ModelM.findById(m._id));
    ok.description = "again";
    await inA(() => ok.save());
    expect((await sys(ModelM).findById(m._id).lean()).description).toBe("again");
  });

  test("replaceOne / findOneAndReplace keep the org", async () => {
    await inA(() => ModelM.replaceOne({ _id: m._id }, { name: "replaced", createdBy: oid() }));
    const after = await sys(ModelM).findById(m._id).lean();
    expect(after.name).toBe("replaced");
    expect(String(after.orgId)).toBe(String(A._id));
    expect(await rejection(inA(() => ModelM.replaceOne({ _id: m._id }, { name: "x", createdBy: oid(), orgId: B._id })))).toBeInstanceOf(TenantViolationError);
    const viaFind = await inA(() => ModelM.findOneAndReplace({ _id: m._id }, { name: "r2", createdBy: oid() }, { new: true }));
    expect(String(viaFind.orgId)).toBe(String(A._id));
  });

  test("updateTouchesOrg unit cases", () => {
    expect(updateTouchesOrg({ name: "x" })).toBe(false);
    expect(updateTouchesOrg({ $set: { name: "x" }, $inc: { versionSeq: 1 } })).toBe(false);
    expect(updateTouchesOrg([{ $set: { name: "x" } }])).toBe(false);
    expect(updateTouchesOrg([{ $set: { v: "$orgId" } }])).toBe(false);
    expect(updateTouchesOrg(null)).toBe(false);
    expect(updateTouchesOrg({ $set: { orgId: 1 } })).toBe(true);
  });
});

describe("caller-supplied orgId cannot widen a query ($and, not where)", () => {
  let b1;
  beforeEach(async () => {
    await mkModel(A, "alpha");
    b1 = await mkModel(B, "gamma");
  });

  test.each([
    ["plain orgId", (id) => ({ orgId: id })],
    ["$and", (id) => ({ $and: [{ orgId: id }] })],
    ["$or with orgId", (id) => ({ $or: [{ orgId: id }, { name: "gamma" }] })],
    ["$in", (id) => ({ orgId: { $in: [id] } })],
    ["$ne own org", () => ({ orgId: { $ne: A._id } })],
    ["$exists", () => ({ orgId: { $exists: true }, name: "gamma" })],
    ["_id of the foreign row", () => ({ _id: b1._id })],
    ["$nor", () => ({ $nor: [{ orgId: A._id }] })],
  ])("%s", async (_l, mk) => {
    expect(await inA(() => ModelM.find(mk(B._id)))).toEqual([]);
    expect(await inA(() => ModelM.findOne(mk(B._id)))).toBeNull();
    expect(await inA(() => ModelM.countDocuments(mk(B._id)))).toBe(0);
    expect((await inA(() => ModelM.updateMany(mk(B._id), { description: "x" }))).matchedCount).toBe(0);
    expect((await inA(() => ModelM.deleteMany(mk(B._id)))).deletedCount).toBe(0);
    expect(await inA(() => ModelM.distinct("name", mk(B._id)))).toEqual([]);
    expect(await sys(ModelM).countDocuments({ name: "gamma" })).toBe(1);
  });

  test("a body-style object spread into a filter cannot switch org", async () => {
    const body = JSON.parse(`{"name":"gamma","orgId":"${B._id}"}`);
    expect(await inA(() => ModelM.find({ ...body }))).toEqual([]);
    expect(await inA(() => ModelM.findOne({ ...body, orgId: B._id }))).toBeNull();
  });
});

describe("upsert", () => {
  const T = { lowAccuracy: 0.9, lowFairnessGap: 0.05, mediumAccuracy: 0.8, mediumFairnessGap: 0.1, driftThreshold: 0.05 };

  test("upsert creates the row in the current org, one per org", async () => {
    await inA(() => Settings.findOneAndUpdate({}, { $set: T }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }));
    await inB(() => Settings.findOneAndUpdate({}, T, { upsert: true, new: true }));
    await inA(() => Settings.findOneAndUpdate({}, { $set: { driftThreshold: 0.2 } }, { upsert: true, new: true }));
    const all = await sys(Settings).find().lean();
    expect(all).toHaveLength(2);
    expect(all.map((s) => String(s.orgId)).sort()).toEqual([String(A._id), String(B._id)].sort());
    expect((await inA(() => Settings.findOne())).driftThreshold).toBe(0.2);
    expect((await inB(() => Settings.findOne())).driftThreshold).toBe(0.05);
  });

  test("orgId is unique on Settings", async () => {
    await Settings.create({ ...T, orgId: A._id });
    const e = await rejection(Settings.create({ ...T, orgId: A._id }));
    expect(e && e.code).toBe(11000);
  });

  test("getThresholds is per org", async () => {
    await Settings.create({ ...T, orgId: A._id });
    expect((await inA(() => settingsUtil.getThresholds())).lowAccuracy).toBe(0.9);
    expect(await inB(() => settingsUtil.getThresholds())).toEqual(settingsUtil.DEFAULT_THRESHOLDS);
    expect((await runSystem(() => settingsUtil.getThresholds(A._id))).driftThreshold).toBe(0.05);
    expect((await runSystem(() => settingsUtil.getThresholds(String(B._id)))).driftThreshold).toBe(0.1);
    expect(await rejection(settingsUtil.getThresholds())).toBeInstanceOf(TenantContextError);
    // an explicit other org inside a request still cannot read it (the plugin filter wins)
    expect(await inB(() => settingsUtil.getThresholds(A._id))).toEqual(settingsUtil.DEFAULT_THRESHOLDS);
  });
});

describe("soft delete coexistence", () => {
  test("archived rows stay hidden, includeDeleted stays inside the org", async () => {
    const a1 = await mkModel(A, "alpha");
    await mkModel(A, "beta");
    const b1 = await mkModel(B, "gamma");
    await sys(ModelM).findById(a1._id).then((d) => d.softDelete({ reason: "r" }));
    await sys(ModelM).findById(b1._id).then((d) => d.softDelete({ reason: "r" }));
    expect(names(await inA(() => ModelM.find()))).toEqual(["beta"]);
    expect(names(await inA(() => ModelM.find().setOptions({ includeDeleted: true })))).toEqual(["alpha", "beta"]);
    expect(await inA(() => ModelM.findOne({ _id: b1._id }).setOptions({ includeDeleted: true }))).toBeNull();
    expect(await inA(() => ModelM.countDocuments({ isDeleted: true }))).toBe(1);
    expect((await inA(() => ModelM.aggregate([{ $count: "n" }]).option({ includeDeleted: true })))[0].n).toBe(2);
    expect((await inA(() => ModelM.aggregate([{ $count: "n" }])))[0].n).toBe(1);
  });

  test("name uniqueness is per organization (partial on isDeleted:false)", async () => {
    await mkModel(A, "Credit Scorer");
    await mkModel(B, "credit scorer"); // other org: fine
    const dup = await rejection(mkModel(A, "CREDIT SCORER"));
    expect(dup && dup.code).toBe(11000);
    const archived = await sys(ModelM).findOne({ name: "Credit Scorer", orgId: A._id });
    await archived.softDelete({});
    await mkModel(A, "Credit Scorer"); // archived name is reusable
    expect(await sys(ModelM).countDocuments({ orgId: A._id })).toBe(1); // live rows
    expect(await sys(ModelM).countDocuments({ orgId: A._id }).setOptions({ includeDeleted: true })).toBe(2);
  });

  test("restore/softDelete on a loaded doc work inside the org context", async () => {
    const a1 = await mkModel(A, "alpha");
    const doc = await inA(() => ModelM.findById(a1._id));
    await inA(() => doc.softDelete({ by: null, reason: "x" }));
    expect(await inA(() => ModelM.findById(a1._id))).toBeNull();
    const again = await inA(() => ModelM.findOne({ _id: a1._id }).setOptions({ includeDeleted: true }));
    await inA(() => again.restore());
    expect(await inA(() => ModelM.findById(a1._id))).toBeTruthy();
  });
});

describe("immutable collections keep their guarantees", () => {
  test("Comment: no update/delete, with or without context", async () => {
    const c = await inA(() => Comment.create({ versionId: oid(), authorId: oid(), authorName: "n", authorRole: "admin", body: "hello" }));
    expect(String(c.orgId)).toBe(String(A._id));
    for (const run of [
      () => Comment.updateOne({ _id: c._id }, { body: "x" }),
      () => Comment.deleteOne({ _id: c._id }),
      () => Comment.deleteMany({}),
      () => Comment.findOneAndUpdate({ _id: c._id }, { body: "x" }),
    ]) {
      expect((await rejection(inA(run))).message).toBe("Comments are immutable");
      expect((await rejection(run())).message).toBe("Comments are immutable"); // not masked by the tenant error
    }
    c.body = "edited";
    expect((await rejection(inA(() => c.save()))).message).toBe("Comments are immutable");
    expect(await sys(Comment).countDocuments({ body: "hello" })).toBe(1);
  });

  test("AuditLog: immutable regardless of tenant context", async () => {
    const row = await inA(() => AuditLog.create({ actorName: "x", actorRole: "none", action: "login", targetType: "User" }));
    for (const run of [
      () => AuditLog.updateOne({ _id: row._id }, { details: "x" }),
      () => AuditLog.deleteMany({}),
      () => AuditLog.findOneAndDelete({ _id: row._id }),
      () => AuditLog.bulkWrite([{ deleteOne: { filter: {} } }]),
    ]) {
      expect((await rejection(run())).message).toMatch(/AUDIT_LOG_IMMUTABLE/);
      expect((await rejection(inA(run))).message).toMatch(/AUDIT_LOG_IMMUTABLE/);
      expect((await rejection(runSystem(run))).message).toMatch(/AUDIT_LOG_IMMUTABLE/);
    }
    const doc = await sys(AuditLog).findById(row._id);
    doc.details = "tamper";
    expect((await rejection(doc.save())).message).toMatch(/AUDIT_LOG_IMMUTABLE/);
  });
});

describe("audit log with orgId", () => {
  const actorOf = (user) => user;

  test("orgId derivation: context, actor, explicit, platform", async () => {
    const { user } = await makeUser("admin", { orgId: A._id });
    await inB(() => writeAuditLog({ actor: user, action: "login", targetType: "User", targetId: user._id })); // context wins
    await writeAuditLog({ actor: user, action: "login", targetType: "User" }); // no context -> actor's org
    await inB(() => writeAuditLog({ actor: user, action: "login", targetType: "User", orgId: null })); // explicit platform
    await inA(() => writeAuditLog({ actor: user, action: "login", targetType: "User", orgId: B._id })); // explicit other org
    await writeAuditLog({ action: "login_failed", targetType: "User" }); // anonymous, no org
    const rows = await sys(AuditLog).find().sort({ seq: 1 }).lean();
    expect(rows.map((r) => (r.orgId ? String(r.orgId) : null))).toEqual([String(B._id), String(A._id), null, String(B._id), null]);
    expect(rows.every((r) => r.chainV === 2)).toBe(true);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    const v = await auditChain.verifyChain(AuditLog);
    expect(v).toMatchObject({ ok: true, checked: 5 });
  });

  test("a super admin actor without org writes platform-level rows", async () => {
    const { user } = await makeUser("super_admin");
    await writeAuditLog({ actor: actorOf(user), action: "org_create", targetType: "Organization" });
    const row = await sys(AuditLog).findOne().lean();
    expect(row.orgId).toBeNull();
    expect(row.actorRole).toBe("super_admin");
  });

  test("queries are tenant-scoped; the global chain reads are not", async () => {
    const { user } = await makeUser("admin", { orgId: A._id });
    await writeAuditLog({ actor: user, action: "login", targetType: "User", orgId: A._id });
    await writeAuditLog({ actor: user, action: "login", targetType: "User", orgId: B._id });
    await writeAuditLog({ actor: user, action: "login", targetType: "User", orgId: null });
    expect(await inA(() => AuditLog.countDocuments())).toBe(1);
    expect(await inB(() => AuditLog.countDocuments())).toBe(1);
    expect(await rejection(AuditLog.countDocuments())).toBeInstanceOf(TenantContextError);
    expect(await sys(AuditLog).countDocuments()).toBe(3);
    const rows = await sys(AuditLog).find().sort({ seq: 1 }).lean();
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]); // ONE sequence across orgs
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(rows[2].prevHash).toBe(rows[1].hash);
  });

  test("concurrent writers across orgs keep a gap-free chain", async () => {
    const { user } = await makeUser("admin", { orgId: A._id });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => runWithOrg(i % 2 ? A._id : B._id, () => writeAuditLog({ actor: user, action: "login", targetType: "User", details: `n${i}` })))
    );
    expect((await sys(AuditLog).find().sort({ seq: 1 }).lean()).map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await auditChain.verifyChain(AuditLog)).toMatchObject({ ok: true, checked: 12 });
  });

  describe("verifyChain with legacy + v2 rows", () => {
    const raw = () => mongoose.connection.collection("auditlogs");
    const legacy = (seq, prevHash, over = {}) => {
      const e = { seq, prevHash, actorName: "old", actorRole: "admin", actorId: oid(), action: "login", targetType: "User", targetId: oid(), details: `legacy ${seq}`, createdAt: new Date(Date.now() - 100000 + seq), hashAlg: "sha256", ...over };
      e.hash = auditChain.computeHash(e, "sha256"); // exactly the pre-tenant hash input
      return e;
    };
    const seedLegacy = async (n) => {
      const rows = [];
      let prev = "GENESIS";
      for (let i = 1; i <= n; i += 1) {
        const r = legacy(i, prev);
        prev = r.hash;
        rows.push(r);
      }
      await raw().insertMany(rows);
      return rows;
    };

    test("legacy rows verify, with or without a backfilled orgId; v2 rows chain onto them", async () => {
      await seedLegacy(3);
      expect(await auditChain.verifyChain(AuditLog)).toMatchObject({ ok: true, checked: 3 });
      await raw().updateMany({}, { $set: { orgId: A._id } }); // what the migration does
      expect(await auditChain.verifyChain(AuditLog)).toMatchObject({ ok: true, checked: 3 });

      const { user } = await makeUser("admin", { orgId: B._id });
      await inB(() => writeAuditLog({ actor: user, action: "create_model", targetType: "Model" }));
      await writeAuditLog({ actor: user, action: "login", targetType: "User", orgId: null });
      const rows = await sys(AuditLog).find().sort({ seq: 1 }).lean();
      expect(rows.map((r) => r.chainV)).toEqual([undefined, undefined, undefined, 2, 2]);
      expect(rows[3].prevHash).toBe(rows[2].hash);
      expect(await auditChain.verifyChain(AuditLog)).toMatchObject({ ok: true, checked: 5 });
    });

    test("computeHash: orgId is part of the hash for chainV 2 only", () => {
      const base = { seq: 1, prevHash: "GENESIS", actorName: "a", actorRole: "admin", action: "login", targetType: "User", details: "", createdAt: new Date(0) };
      const legacyHash = auditChain.computeHash(base, "sha256");
      expect(auditChain.computeHash({ ...base, orgId: A._id }, "sha256")).toBe(legacyHash); // ignored without chainV
      const v2a = auditChain.computeHash({ ...base, chainV: 2, orgId: A._id }, "sha256");
      const v2b = auditChain.computeHash({ ...base, chainV: 2, orgId: B._id }, "sha256");
      const v2n = auditChain.computeHash({ ...base, chainV: 2 }, "sha256");
      expect(new Set([legacyHash, v2a, v2b, v2n]).size).toBe(4);
      expect(auditChain.computeHash({ ...base, chainV: 2, orgId: null }, "sha256")).toBe(v2n);
    });

    test("tampering with a v2 row's orgId, or stripping chainV, is detected", async () => {
      await seedLegacy(1);
      const { user } = await makeUser("admin", { orgId: A._id });
      await inA(() => writeAuditLog({ actor: user, action: "login", targetType: "User" }));
      await inA(() => writeAuditLog({ actor: user, action: "login", targetType: "User" }));
      expect((await auditChain.verifyChain(AuditLog)).ok).toBe(true);

      await raw().updateOne({ seq: 2 }, { $set: { orgId: B._id } }); // move an event to another org
      let v = await auditChain.verifyChain(AuditLog);
      expect(v.ok).toBe(false);
      expect(v.brokenSeqs).toEqual([2]);
      await raw().updateOne({ seq: 2 }, { $set: { orgId: A._id } });
      expect((await auditChain.verifyChain(AuditLog)).ok).toBe(true);

      await raw().updateOne({ seq: 3 }, { $unset: { chainV: "" } }); // pretend it is a legacy row
      v = await auditChain.verifyChain(AuditLog);
      expect(v.ok).toBe(false);
      expect(v.brokenSeqs).toEqual([3]);
    });
  });
});

describe("cross-org probe (utils/crossOrg)", () => {
  let user, req, mB, vB, cB, mA;
  beforeEach(async () => {
    ({ user } = await makeUser("ml_engineer", { orgId: A._id }));
    req = { user, orgId: A._id };
    mA = await mkModel(A, "mine");
    mB = await mkModel(B, "theirs");
    vB = await mkVersion(B, mB._id);
    cB = await runSystem(() => Comment.create({ versionId: vB._id, authorId: oid(), authorName: "n", authorRole: "admin", body: "b", orgId: B._id }));
  });
  const entries = () => sys(AuditLog).find({ action: "cross_org_attempt" }).sort({ seq: 1 }).lean();

  test.each([
    ["Model", () => mB._id, "Model"],
    ["Version", () => vB._id, "Version"],
    ["File", () => vB._id, "Version"],
    ["Comment", () => cB._id, "Comment"],
  ])("%s that lives in another org: logs once, returns true", async (kind, id, targetType) => {
    expect(await crossOrg.logCrossOrg(req, kind, id())).toBe(true);
    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorRole: "ml_engineer", targetType, chainV: 2 });
    expect(String(rows[0].orgId)).toBe(String(A._id));
    expect(String(rows[0].actorId)).toBe(String(user._id));
    expect(String(rows[0].targetId)).toBe(String(id()));
    expect(rows[0].details).not.toContain(String(B._id)); // never names the other org
    expect(await auditChain.verifyChain(AuditLog)).toMatchObject({ ok: true });
  });

  test("archived rows of another org count; string ids work", async () => {
    await sys(ModelM).findById(mB._id).then((d) => d.softDelete({}));
    expect(await crossOrg.logCrossOrg(req, "Model", String(mB._id))).toBe(true);
  });

  test("own-org id, unknown id, malformed id, unknown kind: false and nothing logged", async () => {
    expect(await crossOrg.logCrossOrg(req, "Model", mA._id)).toBe(false);
    expect(await crossOrg.logCrossOrg(req, "Model", oid())).toBe(false);
    expect(await crossOrg.logCrossOrg(req, "Model", "not-an-id")).toBe(false);
    expect(await crossOrg.logCrossOrg(req, "Model", { $ne: null })).toBe(false);
    expect(await crossOrg.logCrossOrg(req, "Nope", mB._id)).toBe(false);
    expect(await crossOrg.logCrossOrg(req, "__proto__", mB._id)).toBe(false);
    expect(await entries()).toHaveLength(0);
  });

  test("no org or no user on the request: false, never throws", async () => {
    expect(await crossOrg.logCrossOrg({ user, orgId: null }, "Model", mB._id)).toBe(false);
    expect(await crossOrg.logCrossOrg({ orgId: A._id }, "Model", mB._id)).toBe(false);
    expect(await crossOrg.logCrossOrg(undefined, "Model", mB._id)).toBe(false);
    expect(await entries()).toHaveLength(0);
  });

  test("works inside and outside an org context (the probe is explicit)", async () => {
    expect(await inA(() => crossOrg.logCrossOrg(req, "Model", mB._id))).toBe(true);
    expect(await runWithOrg(null, () => crossOrg.logCrossOrg(req, "Model", mB._id))).toBe(true);
    expect(await entries()).toHaveLength(2);
  });
});

describe("User model", () => {
  test("emailKey is derived and globally unique ('+tag' and case)", async () => {
    const u = await User.create({ name: "J", email: "Jo+hr@Acme.com", passwordHash: "x", role: "admin", orgId: A._id });
    expect(u.email).toBe("jo+hr@acme.com");
    expect(u.emailKey).toBe("jo@acme.com");
    const dupe = await rejection(User.create({ name: "J2", email: "jo@acme.com", passwordHash: "x", role: "ml_engineer", orgId: B._id }));
    expect(dupe && dupe.code).toBe(11000); // one person, one account, across organizations
    const other = await User.create({ name: "K", email: "k@acme.com", passwordHash: "x", role: "ml_engineer", orgId: B._id });
    expect(other.emailKey).toBe("k@acme.com");
  });

  test("ROLES / ALL_ROLES / schema enum", async () => {
    expect(User.ROLES).toEqual(["admin", "ml_engineer", "compliance_officer"]);
    expect(User.ALL_ROLES).toEqual(["admin", "ml_engineer", "compliance_officer", "super_admin"]);
    const e = await rejection(User.create({ name: "x", email: "x@y.io", passwordHash: "x", role: "root", orgId: A._id }));
    expect(e.name).toBe("ValidationError");
  });

  test("defaults, link-secret fields are never selected or serialized", async () => {
    const u = await User.create({ name: "J", email: "j@acme.com", passwordHash: "x", role: "ml_engineer", orgId: A._id, verifyTokenHash: "h1", setupTokenHash: "h2", verifyExpiresAt: new Date(), seatKind: "ml_engineer", seatGen: 3 });
    expect(u.status).toBe("active");
    const loaded = await sys(User).findById(u._id);
    expect(loaded.verifyTokenHash).toBeUndefined();
    expect(loaded.setupTokenHash).toBeUndefined();
    expect((await sys(User).findOne({ verifyTokenHash: "h1" }))._id.toString()).toBe(String(u._id)); // still queryable
    expect((await sys(User).findById(u._id).select("+setupTokenHash")).setupTokenHash).toBe("h2");
    const json = JSON.parse(JSON.stringify(u));
    expect(json.verifyTokenHash).toBeUndefined();
    expect(json.setupTokenHash).toBeUndefined();
    expect(json.verifyExpiresAt).toBeUndefined();
    const safe = u.toSafeJSON({ orgName: "Org A" });
    expect(safe).toMatchObject({ name: "J", role: "ml_engineer", isActive: true, status: "active", orgName: "Org A" });
    expect(String(safe.orgId)).toBe(String(A._id));
    expect(JSON.stringify(safe)).not.toMatch(/Hash|passwordHash|Expires/);
    expect("orgName" in u.toSafeJSON()).toBe(false);
  });

  test("canAuthenticate / authProblem matrix", async () => {
    const act = { ...A.toObject(), status: "active" };
    const sus = { ...A.toObject(), status: "suspended" };
    const mk = (over) => ({ role: "ml_engineer", isActive: true, status: "active", ...over });
    expect(User.canAuthenticate(mk({}), act)).toBe(true);
    expect(User.canAuthenticate(mk({ status: undefined }), act)).toBe(true); // legacy row
    expect(User.canAuthenticate(mk({ isActive: undefined }), act)).toBe(true);
    expect(User.canAuthenticate(mk({ isActive: false }), act)).toBe(false);
    for (const status of ["unverified", "pending", "invited"]) expect(User.canAuthenticate(mk({ status }), act)).toBe(false);
    expect(User.canAuthenticate(mk({}), sus)).toBe(false);
    expect(User.canAuthenticate(mk({}), null)).toBe(false);
    expect(User.canAuthenticate(mk({}))).toBe(false);
    expect(User.canAuthenticate(mk({ role: "super_admin" }))).toBe(true); // no org needed
    expect(User.canAuthenticate(mk({ role: "super_admin", status: "pending" }))).toBe(false);
    expect(User.canAuthenticate(null, act)).toBe(false);
    expect(User.authProblem(mk({ isActive: false }), act)).toMatchObject({ reason: "deactivated", code: "ACCOUNT_DEACTIVATED", message: "Account is deactivated" });
    expect(User.authProblem(mk({ status: "unverified" }), act)).toMatchObject({ reason: "not_active", code: "EMAIL_UNVERIFIED" });
    expect(User.authProblem(mk({ status: "pending" }), act)).toMatchObject({ reason: "not_active", code: "ACCOUNT_PENDING" });
    expect(User.authProblem(mk({}), sus)).toMatchObject({ reason: "org_suspended", code: "ORG_SUSPENDED" });
    expect(User.authProblem(mk({}), act)).toBeNull();
  });
});

describe("test helpers", () => {
  test("makeOrg / defaultOrg / makeUser", async () => {
    const o = await makeOrg();
    expect(o.allowedDomains).toEqual(["test.local"]);
    expect(o.domainRuleEnabled).toBe(true);
    expect(o.codes.ml_engineer.value).toHaveLength(12);
    expect(o.codes.ml_engineer.value).not.toBe(o.codes.compliance_officer.value);
    const o2 = await makeOrg({ allowedDomains: ["x.io"], autoApprove: true });
    expect(o2.allowedDomains).toEqual(["x.io"]);
    expect(o2.autoApprove).toBe(true);

    const d1 = await defaultOrg();
    const d2 = await defaultOrg();
    expect(String(d1._id)).toBe(String(d2._id));
    const u = await makeUser("admin");
    const u2 = await makeUser("compliance_officer", { orgId: A._id });
    const su = await makeUser("super_admin");
    expect(String(u.user.orgId)).toBe(String(d1._id));
    expect(String(u2.user.orgId)).toBe(String(A._id));
    expect(su.user.orgId == null).toBe(true);
    expect(u.user.status).toBe("active");
    expect(u.password).toBe("Password1!");
    expect(await bcrypt.compare("Password1!", u.user.passwordHash)).toBe(true);
    expect(jwt.verify(u.token, env.jwtSecret).sub).toBe(String(u.user._id));
    const inactive = await makeUser("ml_engineer", { extra: { isActive: false } });
    expect(inactive.user.isActive).toBe(false);
    // makeUser works inside another org's context too
    const nested = await inA(() => makeUser("admin", { orgId: B._id }));
    expect(String(nested.user.orgId)).toBe(String(B._id));
  });

  test("reset() clears the cached default org", async () => {
    const before = await defaultOrg();
    await reset();
    const after = await defaultOrg();
    expect(String(after._id)).not.toBe(String(before._id));
    expect(await Organization.countDocuments()).toBe(1);
  });
});

describe("error mapping", () => {
  test("serverError and the central error handler answer 400 ORG_REQUIRED", async () => {
    const app = express();
    app.get("/a", async (req, res) => {
      try {
        await ModelM.find();
        res.json({});
      } catch (err) {
        httpErrors.serverError(res, err);
      }
    });
    app.get("/b", (req, res, next) => next(new TenantContextError()));
    app.get("/c", (req, res, next) => next(new TenantViolationError("boom")));
    app.use(errorHandlerMod.errorHandler);
    for (const p of ["/a", "/b"]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Select an organization first", code: "ORG_REQUIRED" });
    }
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect((await request(app).get("/c")).status).toBe(500);
    spy.mockRestore();
  });
});

describe("authGuard (tiny app)", () => {
  let app;
  const q = (token) => ({ authz: (r) => auth(r, token) });
  const mkApp = () => {
    const a = express();
    a.use(express.json());
    a.get("/scoped", authGuard, async (req, res) => {
      await new Promise((r) => setTimeout(r, Math.random() * 10)); // crosses awaits
      const rows = await ModelM.find().lean();
      res.json({ ctx: String(currentOrgId()), reqOrgId: String(req.orgId), org: req.org && req.org.name, names: names(rows), role: req.user.role });
    });
    a.get("/platform", authGuard.platform, async (req, res) => {
      res.json({ ctx: currentOrgId() && String(currentOrgId()), reqOrgId: req.orgId && String(req.orgId), org: req.org ? req.org.name : null });
    });
    a.get("/platform-query", authGuard.platform, async (req, res) => {
      try {
        res.json({ n: await ModelM.countDocuments() });
      } catch (err) {
        httpErrors.serverError(res, err);
      }
    });
    a.get("/admin-only", authGuard, roleGuard(["admin"]), (req, res) => res.json({ ok: true }));
    a.get("/review-only", authGuard, roleGuard(["compliance_officer"]), (req, res) => res.json({ ok: true }));
    a.use(errorHandlerMod.errorHandler);
    return a;
  };
  const orgAccessRows = () => sys(AuditLog).find({ action: "org_access" }).sort({ seq: 1 }).lean();

  beforeEach(async () => {
    app = mkApp();
    authGuard.resetOrgAccessThrottle();
    await mkModel(A, "a-model");
    await mkModel(B, "b-model");
  });

  test("normal user: context, req.org, req.orgId, filtered data", async () => {
    const { token } = await makeUser("ml_engineer", { orgId: A._id });
    const res = await auth(request(app).get("/scoped"), token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ctx: String(A._id), reqOrgId: String(A._id), org: "Org A", names: ["a-model"], role: "ml_engineer" });
  });

  test("a normal user cannot select an org with X-Org-Id (header ignored)", async () => {
    const { token } = await makeUser("admin", { orgId: A._id });
    const res = await auth(request(app).get("/scoped"), token).set("X-Org-Id", String(B._id));
    expect(res.status).toBe(200);
    expect(res.body.names).toEqual(["a-model"]);
    expect(await orgAccessRows()).toHaveLength(0);
    const bogus = await auth(request(app).get("/scoped"), token).set("X-Org-Id", "bogus");
    expect(bogus.status).toBe(200);
  });

  test("simultaneous requests of different orgs stay isolated", async () => {
    const ta = (await makeUser("admin", { orgId: A._id })).token;
    const tb = (await makeUser("admin", { orgId: B._id })).token;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => auth(request(app).get("/scoped"), i % 2 ? tb : ta)));
    results.forEach((r, i) => expect(r.body.names).toEqual([i % 2 ? "b-model" : "a-model"]));
  });

  test("missing / malformed / bad token => 401; deleted user => 401", async () => {
    expect((await request(app).get("/scoped")).status).toBe(401);
    expect((await request(app).get("/scoped").set("Authorization", "Token x")).status).toBe(401);
    expect((await auth(request(app).get("/scoped"), "garbage")).status).toBe(401);
    const { user, token } = await makeUser("admin");
    await sys(User).deleteOne({ _id: user._id });
    const res = await auth(request(app).get("/scoped"), token);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("User no longer exists");
    const badSub = jwt.sign({ sub: "not-an-id" }, env.jwtSecret, { expiresIn: "1h" });
    expect((await auth(request(app).get("/scoped"), badSub)).status).toBe(401);
  });

  test("deactivated => 401 'Account is deactivated'", async () => {
    const { token } = await makeUser("ml_engineer", { orgId: A._id, extra: { isActive: false } });
    const res = await auth(request(app).get("/scoped"), token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Account is deactivated" });
  });

  test.each(["pending", "unverified", "invited"])("status %s => 401 'Account is not active'", async (status) => {
    const { token } = await makeUser("ml_engineer", { orgId: A._id, status });
    const res = await auth(request(app).get("/scoped"), token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Account is not active" });
  });

  test("a user that is deactivated or becomes pending after the token was issued is locked out at once", async () => {
    const { user, token } = await makeUser("ml_engineer", { orgId: A._id });
    expect((await auth(request(app).get("/scoped"), token)).status).toBe(200);
    await sys(User).updateOne({ _id: user._id }, { status: "pending" });
    expect((await auth(request(app).get("/scoped"), token)).status).toBe(401);
  });

  test("suspended organization => 401 for its users, at once; other orgs unaffected", async () => {
    const { token } = await makeUser("admin", { orgId: A._id });
    const other = await makeUser("admin", { orgId: B._id });
    expect((await auth(request(app).get("/scoped"), token)).status).toBe(200);
    await Organization.updateOne({ _id: A._id }, { status: "suspended" });
    const res = await auth(request(app).get("/scoped"), token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Organization is suspended" });
    expect((await auth(request(app).get("/scoped"), other.token)).status).toBe(200);
    await Organization.updateOne({ _id: A._id }, { status: "active" });
    expect((await auth(request(app).get("/scoped"), token)).status).toBe(200);
  });

  test("a user whose organization row is gone => 401", async () => {
    const { token } = await makeUser("admin", { orgId: A._id });
    await Organization.deleteOne({ _id: A._id });
    expect((await auth(request(app).get("/scoped"), token)).status).toBe(401);
  });

  test("a user with no orgId (corrupt) is refused", async () => {
    const { user, token } = await makeUser("admin", { orgId: A._id });
    await mongoose.connection.collection("users").updateOne({ _id: user._id }, { $unset: { orgId: "" } });
    expect((await auth(request(app).get("/scoped"), token)).status).toBe(401);
  });

  describe("super admin", () => {
    let su;
    beforeEach(async () => {
      su = await makeUser("super_admin");
    });

    test("no org selected: default guard 400 ORG_REQUIRED, platform guard passes with a null org", async () => {
      const res = await auth(request(app).get("/scoped"), su.token);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Select an organization first", code: "ORG_REQUIRED" });
      const p = await auth(request(app).get("/platform"), su.token);
      expect(p.status).toBe(200);
      expect(p.body).toEqual({ ctx: null, reqOrgId: null, org: null });
      expect(await orgAccessRows()).toHaveLength(0);
    });

    test("org-scoped queries on the platform guard fail closed with 400 ORG_REQUIRED", async () => {
      const res = await auth(request(app).get("/platform-query"), su.token);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Select an organization first", code: "ORG_REQUIRED" });
    });

    test("X-Org-Id selects the org: scoped data, req.org, and one org_access entry", async () => {
      const res = await auth(request(app).get("/scoped"), su.token).set("X-Org-Id", String(B._id));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ctx: String(B._id), reqOrgId: String(B._id), org: "Org B", names: ["b-model"], role: "super_admin" });
      const rows = await orgAccessRows();
      expect(rows).toHaveLength(1);
      expect(String(rows[0].orgId)).toBe(String(B._id));
      expect(String(rows[0].targetId)).toBe(String(B._id));
      expect(String(rows[0].actorId)).toBe(String(su.user._id));
      expect(rows[0]).toMatchObject({ actorRole: "super_admin", targetType: "Organization", chainV: 2 });
      // same org again: throttled
      await auth(request(app).get("/scoped"), su.token).set("X-Org-Id", String(B._id));
      await auth(request(app).get("/platform"), su.token).set("X-Org-Id", String(B._id));
      expect(await orgAccessRows()).toHaveLength(1);
      // a different org: new entry; coming back to B: new entry again (the LAST audited org changed)
      await auth(request(app).get("/scoped"), su.token).set("X-Org-Id", String(A._id));
      expect(await orgAccessRows()).toHaveLength(2);
      await auth(request(app).get("/scoped"), su.token).set("X-Org-Id", String(B._id));
      expect(await orgAccessRows()).toHaveLength(3);
      expect(await auditChain.verifyChain(AuditLog)).toMatchObject({ ok: true });
    });

    test("concurrent first requests write a single org_access entry", async () => {
      await Promise.all(Array.from({ length: 6 }, () => auth(request(app).get("/scoped"), su.token).set("X-Org-Id", String(A._id))));
      expect(await orgAccessRows()).toHaveLength(1);
    });

    test("the throttle expires after an hour", async () => {
      await auth(request(app).get("/scoped"), su.token).set("X-Org-Id", String(A._id));
      authGuard.lastOrgAccess.get(String(su.user._id)).at -= 61 * 60 * 1000; // pretend the last audited access was 61 minutes ago
      await auth(request(app).get("/scoped"), su.token).set("X-Org-Id", String(A._id));
      expect(await orgAccessRows()).toHaveLength(2);
    });

    test("bogus / unknown X-Org-Id => 400 'Unknown organization' on both guards", async () => {
      for (const v of ["bogus", "123", "{\"$ne\":null}", "z".repeat(24), String(oid()), `${B._id},${A._id}`]) {
        for (const path of ["/scoped", "/platform"]) {
          const res = await auth(request(app).get(path), su.token).set("X-Org-Id", v);
          expect(res.status).toBe(400);
          expect(res.body).toEqual({ error: "Unknown organization", code: "ORG_REQUIRED" });
        }
      }
      expect(await orgAccessRows()).toHaveLength(0);
    });

    test("an empty X-Org-Id counts as no selection", async () => {
      const res = await auth(request(app).get("/platform"), su.token).set("X-Org-Id", "");
      expect(res.status).toBe(200);
      expect(res.body.org).toBeNull();
    });

    test("a suspended org may still be selected by the super admin", async () => {
      await Organization.updateOne({ _id: B._id }, { status: "suspended" });
      const res = await auth(request(app).get("/scoped"), su.token).set("X-Org-Id", String(B._id));
      expect(res.status).toBe(200);
      expect(res.body.names).toEqual(["b-model"]);
    });

    test("a deactivated or pending super admin is refused like anyone else", async () => {
      await sys(User).updateOne({ _id: su.user._id }, { isActive: false });
      expect((await auth(request(app).get("/platform"), su.token)).status).toBe(401);
      await sys(User).updateOne({ _id: su.user._id }, { isActive: true, status: "pending" });
      expect((await auth(request(app).get("/platform"), su.token)).status).toBe(401);
    });
  });

  describe("roleGuard", () => {
    test("super_admin counts as admin, never as a reviewer", async () => {
      const su = await makeUser("super_admin");
      const adm = await makeUser("admin", { orgId: A._id });
      const ml = await makeUser("ml_engineer", { orgId: A._id });
      const co = await makeUser("compliance_officer", { orgId: A._id });
      const get = (p, t, org) => {
        const r = auth(request(app).get(p), t);
        return org ? r.set("X-Org-Id", String(A._id)) : r;
      };
      expect((await get("/admin-only", su.token, true)).status).toBe(200);
      expect((await get("/admin-only", adm.token)).status).toBe(200);
      expect((await get("/admin-only", ml.token)).status).toBe(403);
      expect((await get("/admin-only", co.token)).status).toBe(403);
      expect((await get("/review-only", su.token, true)).status).toBe(403);
      expect((await get("/review-only", co.token)).status).toBe(200);
      expect((await get("/review-only", adm.token)).status).toBe(403);
    });

    test("isAdmin and the standalone roleGuard behaviour", () => {
      expect(roleGuard.isAdmin({ role: "admin" })).toBe(true);
      expect(roleGuard.isAdmin({ role: "super_admin" })).toBe(true);
      expect(roleGuard.isAdmin({ role: "ml_engineer" })).toBe(false);
      expect(roleGuard.isAdmin(null)).toBe(false);
      expect(roleGuard.isAdmin).toBe(require("../middleware/role").isAdmin);
      const run = (user, list) => {
        const out = {};
        roleGuard(list)({ user }, { status: (s) => ({ json: (b) => Object.assign(out, { s, b }) }) }, () => (out.next = true));
        return out;
      };
      expect(run(undefined, ["admin"])).toMatchObject({ s: 401 });
      expect(run({ role: "super_admin" }, ["admin", "ml_engineer"])).toEqual({ next: true });
      expect(run({ role: "super_admin" }, ["ml_engineer"]).s).toBe(403);
      expect(run({ role: "super_admin" }, []).s).toBe(403);
    });
  });

  test("middleware/upload re-enters the org context after multer", async () => {
    const { uploadBatchFile, uploadVersionFiles } = require("../middleware/upload");
    const a = express();
    const seen = {};
    a.post("/batch", authGuard, uploadBatchFile, async (req, res) => {
      seen.ctx = String(currentOrgId());
      seen.names = names(await ModelM.find().lean());
      res.json({ file: req.file && req.file.originalname });
    });
    a.post("/multi", authGuard, uploadVersionFiles, async (req, res) => {
      seen.multi = names(await ModelM.find().lean());
      res.json({ ok: true });
    });
    a.use(errorHandlerMod.errorHandler);
    const { token } = await makeUser("ml_engineer", { orgId: B._id });
    const res = await auth(request(a).post("/batch"), token).attach("file", Buffer.from("a,b\n1,2\n"), "p.csv");
    expect(res.status).toBe(200);
    expect(res.body.file).toBe("p.csv");
    expect(seen).toMatchObject({ ctx: String(B._id), names: ["b-model"] });
    const res2 = await auth(request(a).post("/multi"), token).attach("file", Buffer.from("a,b\n1,2\n"), "p.csv");
    expect(res2.status).toBe(200);
    expect(seen.multi).toEqual(["b-model"]);
    // a multer error still reaches the error handler
    const bad = await auth(request(a).post("/batch"), token).attach("other", Buffer.from("x"), "x.csv");
    expect(bad.status).toBe(400);
    // unauthenticated: authGuard rejects before multer
    expect((await request(a).post("/batch").attach("file", Buffer.from("x"), "x.csv")).status).toBe(401);
  });
});

describe("misc", () => {
  test("the new audit actions are accepted", async () => {
    const actions = ["org_create", "org_update", "org_suspend", "org_activate", "org_access", "code_update", "code_regenerate", "join_code_failed", "email_verified", "user_approve", "user_reject", "setup_link_issued", "password_setup", "cross_org_attempt"];
    for (const a of actions) expect(AuditLog.ACTIONS).toContain(a);
    for (const a of actions) await writeAuditLog({ action: a, targetType: "Organization", orgId: A._id });
    expect(await sys(AuditLog).countDocuments()).toBe(actions.length);
  });

  test("defaultOrg id is usable as a tenant", async () => {
    const d = await defaultOrg();
    const { user } = await makeUser("admin");
    await runWithOrg(d._id, () => ModelM.create({ name: "d", createdBy: user._id }));
    expect(await runWithOrg(d._id, () => ModelM.countDocuments())).toBe(1);
    expect(await inA(() => ModelM.countDocuments())).toBe(0);
  });
});
