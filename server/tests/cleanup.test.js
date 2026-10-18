const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const Model = require("../models/Model");
const Version = require("../models/Version");
const { runCleanupOnce, startCleanupJob } = require("../jobs/cleanup");
const { connect, reset, disconnect, makeUser } = require("./helpers");

const DAY = 24 * 60 * 60 * 1000;
let owner, model, seq = 0;

function touch(name, ageDays = 0) {
  const file = path.join(env.uploadDir, name);
  fs.writeFileSync(file, "data");
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(file, t, t);
  return file;
}
const mv = (extra) => Version.create({ modelId: model._id, versionNumber: (seq += 1), fileType: "csv", createdBy: owner.user._id, ...extra });
const raw = (id) => Version.findById(id).setOptions({ includeDeleted: true }).lean();
// Backdate via the raw collection so hooks/timestamps can't interfere.
const age = (id, days, field) =>
  Version.collection.updateOne({ _id: id }, { $set: { [field]: new Date(Date.now() - days * DAY) } });

beforeAll(async () => {
  await connect();
  await reset();
  owner = await makeUser("ml_engineer");
  model = await Model.create({ name: "Cleanup model", createdBy: owner.user._id });
});
beforeEach(() => {
  fs.rmSync(env.uploadDir, { recursive: true, force: true });
  fs.mkdirSync(env.uploadDir, { recursive: true });
});
afterAll(async () => {
  fs.rmSync(env.uploadDir, { recursive: true, force: true });
  await disconnect();
});

describe("cleanup job", () => {
  test("startCleanupJob is a no-op under NODE_ENV=test", () => {
    const spy = jest.spyOn(global, "setInterval");
    startCleanupJob();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("purges files of long-archived versions only", async () => {
    const f1 = touch("old-archived.csv", 1);
    const d1 = touch("old-archived-ds.csv", 1);
    const f2 = touch("recent-archived.csv", 1);
    const f3 = touch("live-draft.csv", 1);
    const old = await mv({ filePath: f1, datasetPath: d1, status: "rejected" });
    const recent = await mv({ filePath: f2, status: "rejected" });
    const live = await mv({ filePath: f3 });
    await old.softDelete({ by: owner.user._id });
    await recent.softDelete({ by: owner.user._id });
    await age(old._id, env.retentionDays + 1, "deletedAt");
    await age(recent._id, env.retentionDays - 1, "deletedAt");

    const res = await runCleanupOnce();
    expect(res).toEqual({ filesRemoved: 2, versionsUpdated: 1, orphansRemoved: 0 });
    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(d1)).toBe(false);
    expect(fs.existsSync(f2)).toBe(true);
    expect(fs.existsSync(f3)).toBe(true);

    const row = await raw(old._id);
    expect(row).toMatchObject({ filePath: null, datasetPath: null, isDeleted: true }); // row kept
    expect((await raw(recent._id)).filePath).toBe(f2);
    expect((await raw(live._id)).filePath).toBe(f3);
  });

  test("purges old upload_failed files, keeps recent ones", async () => {
    const fOld = touch("failed-old.csv", 1);
    const fNew = touch("failed-new.csv", 1);
    const vOld = await mv({ filePath: fOld, status: "upload_failed" });
    const vNew = await mv({ filePath: fNew, status: "upload_failed" });
    await age(vOld._id, env.retentionDays + 1, "updatedAt");

    const res = await runCleanupOnce();
    expect(res.filesRemoved).toBe(1);
    expect(fs.existsSync(fOld)).toBe(false);
    expect(fs.existsSync(fNew)).toBe(true);
    expect((await raw(vOld._id)).filePath).toBeNull();
    expect((await raw(vNew._id)).filePath).toBe(fNew);
    expect((await raw(vOld._id)).status).toBe("upload_failed");
  });

  test("tolerates already-missing files and refuses paths outside the upload dir", async () => {
    const outside = path.join(path.dirname(env.uploadDir), `outside-${Date.now()}.csv`);
    fs.writeFileSync(outside, "keep me");
    const v1 = await mv({ filePath: path.join(env.uploadDir, "missing.csv"), status: "rejected" });
    const v2 = await mv({ filePath: outside, status: "rejected" });
    for (const v of [v1, v2]) {
      await v.softDelete({ by: owner.user._id });
      await age(v._id, env.retentionDays + 1, "deletedAt");
    }
    const res = await runCleanupOnce();
    expect(res).toEqual({ filesRemoved: 0, versionsUpdated: 2, orphansRemoved: 0 });
    expect(fs.existsSync(outside)).toBe(true);
    fs.rmSync(outside);
  });

  test("orphan sweep: old unreferenced files go; young, referenced (incl. archived), .gitkeep and dirs stay", async () => {
    const orphan = touch("orphan.csv", 2);
    const young = touch("young-orphan.csv", 0);
    const refd = touch("referenced.csv", 2);
    const refDs = touch("referenced-ds.csv", 2);
    const archivedRef = touch("archived-ref.csv", 2);
    const keep = touch(".gitkeep", 5);
    fs.mkdirSync(path.join(env.uploadDir, "subdir"));
    await mv({ filePath: refd, datasetPath: refDs });
    const arch = await mv({ filePath: archivedRef, status: "rejected" });
    await arch.softDelete({ by: owner.user._id }); // archived just now -> inside retention

    const res = await runCleanupOnce();
    expect(res).toEqual({ filesRemoved: 0, versionsUpdated: 0, orphansRemoved: 1 });
    expect(fs.existsSync(orphan)).toBe(false);
    for (const f of [young, refd, refDs, archivedRef, keep]) expect(fs.existsSync(f)).toBe(true);
    expect(fs.statSync(path.join(env.uploadDir, "subdir")).isDirectory()).toBe(true);
  });

  test("a missing upload dir is not an error", async () => {
    fs.rmSync(env.uploadDir, { recursive: true, force: true });
    await expect(runCleanupOnce()).resolves.toEqual({ filesRemoved: 0, versionsUpdated: 0, orphansRemoved: 0 });
  });
});
