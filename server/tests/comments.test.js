const request = require("supertest");
const app = require("../app");
const Model = require("../models/Model");
const Version = require("../models/Version");
const Comment = require("../models/Comment");
const { connect, reset, disconnect, makeUser, auth } = require("./helpers");

let eng, comp, admin, version;

beforeAll(async () => {
  await connect();
  await reset();
  eng = await makeUser("ml_engineer");
  comp = await makeUser("compliance_officer");
  admin = await makeUser("admin");
  const model = await Model.create({ name: "Comment model", createdBy: eng.user._id });
  version = await Version.create({ modelId: model._id, versionNumber: 1, fileType: "csv", createdBy: eng.user._id });
});
afterAll(disconnect);

const url = (id = version._id) => `/api/versions/${id}/comments`;

describe("comments", () => {
  test("requires authentication", async () => {
    expect((await request(app).get(url())).status).toBe(401);
    expect((await request(app).post(url()).send({ body: "hi" })).status).toBe(401);
  });

  test("any role can post; list is oldest first with author info", async () => {
    for (const [u, text] of [[eng, "first"], [comp, "  second  "], [admin, "third"]]) {
      const r = await auth(request(app).post(url()), u.token).send({ body: text });
      expect(r.status).toBe(201);
      expect(r.body.comment).toMatchObject({ authorName: u.user.name, authorRole: u.user.role });
      expect(r.body.comment.authorId).toBeUndefined();
    }
    const list = await auth(request(app).get(url()), eng.token);
    expect(list.status).toBe(200);
    expect(list.body.comments.map((c) => c.body)).toEqual(["first", "second", "third"]);
    expect(list.body.comments[0]).toEqual(expect.objectContaining({ _id: expect.any(String), createdAt: expect.any(String) }));
  });

  test("validates body", async () => {
    for (const bad of [{}, { body: 123 }, { body: ["a"] }, { body: { $gt: "" } }, { body: "   " }, { body: "" }, { body: "x".repeat(2001) }]) {
      const r = await auth(request(app).post(url()), eng.token).send(bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toBeTruthy();
    }
    const ok = await auth(request(app).post(url()), eng.token).send({ body: "x".repeat(2000) });
    expect(ok.status).toBe(201);
  });

  test("bad id is 400, unknown version is 404", async () => {
    expect((await auth(request(app).get(url("nope")), eng.token)).status).toBe(400);
    expect((await auth(request(app).get(url("a".repeat(24))), eng.token)).status).toBe(404);
    expect((await auth(request(app).post(url("a".repeat(24))), eng.token).send({ body: "x" })).status).toBe(404);
  });

  test("archived version -> 404", async () => {
    const model = await Model.create({ name: "Archived holder", createdBy: eng.user._id });
    const v = await Version.create({ modelId: model._id, versionNumber: 1, fileType: "csv", createdBy: eng.user._id });
    await v.softDelete({ by: admin.user._id });
    expect((await auth(request(app).get(url(v._id)), eng.token)).status).toBe(404);
    expect((await auth(request(app).post(url(v._id)), eng.token).send({ body: "x" })).status).toBe(404);
  });

  test("comments are immutable", async () => {
    const c = await Comment.findOne({ versionId: version._id });
    await expect(Comment.updateOne({ _id: c._id }, { body: "edited" })).rejects.toThrow(/immutable/);
    await expect(Comment.deleteOne({ _id: c._id })).rejects.toThrow(/immutable/);
    await expect(Comment.deleteMany({})).rejects.toThrow(/immutable/);
    c.body = "edited";
    await expect(c.save()).rejects.toThrow(/immutable/);
    await expect(c.deleteOne()).rejects.toThrow(/immutable/);
    expect(await Comment.countDocuments({ versionId: version._id, body: "edited" })).toBe(0);
  });
});
