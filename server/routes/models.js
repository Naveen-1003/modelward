const express = require("express");
const Model = require("../models/Model");
const Version = require("../models/Version");
const { LIVE_STATUSES } = Version;
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const writeAuditLog = require("../middleware/audit");
const validId = require("../middleware/validId");
const { parse, z, str, requiredStr } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const { summarizeModels, emptySummary } = require("../utils/modelSummary");
const { paginationFields, pageWindow, envelope, escapeRegex } = require("../utils/query");

const router = express.Router();
router.param("id", validId);

const NAME_COLLATION = { locale: "en", strength: 2 }; // case-insensitive, matches the unique index

const createSchema = z.object({
  name: requiredStr(120),
  description: str(2000).optional(),
  useCase: str(200).optional(),
}).strict();

const listSchema = z.object({
  ...paginationFields,
  q: str(100).optional(),
  tier: z.enum(["low", "medium", "high", "unrated"]).optional(),
});

const reasonSchema = z.object({ reason: str(500).optional() });

// Model JSON = stored fields + the derived summary (a Model has no stored risk tier).
const present = (model, summary) => ({ ...model.toJSON(), ...(summary || emptySummary()) });

const activeNameClash = (name, exceptId) =>
  Model.findOne({ name, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).collation(NAME_COLLATION).select("_id").lean();

const dupName = (res, name) =>
  res.status(409).json({ error: `A model named "${name}" already exists`, fields: { name: "already exists" } });

router.post("/", authGuard, roleGuard(["ml_engineer", "admin"]), async (req, res) => {
  try {
    if (req.body && typeof req.body === "object" && "riskTier" in req.body) {
      return res.status(400).json({ error: "riskTier is not accepted at creation -- it is computed per version" });
    }
    const data = parse(createSchema, req.body, res);
    if (!data) return;

    if (await activeNameClash(data.name)) return dupName(res, data.name);

    let model;
    try {
      model = await Model.create({
        name: data.name,
        description: data.description || "",
        useCase: data.useCase || "",
        createdBy: req.user._id,
      });
    } catch (err) {
      if (err && err.code === 11000) return dupName(res, data.name); // lost a race against the partial unique index
      throw err;
    }

    await writeAuditLog({
      actor: req.user,
      action: "create_model",
      targetType: "Model",
      targetId: model._id,
      details: `Created model "${model.name}"`,
    });

    res.status(201).json({ model: present(model) });
  } catch (err) {
    serverError(res, err, "Failed to create model");
  }
});

router.get("/", authGuard, async (req, res) => {
  try {
    const q = parse(listSchema, req.query, res);
    if (!q) return;
    const win = pageWindow(q, 12);

    const filter = {};
    if (q.q) filter.name = { $regex: escapeRegex(q.q), $options: "i" };

    let models;
    let summaries;
    let total;
    if (!q.tier) {
      total = await Model.countDocuments(filter);
      models = await Model.find(filter).sort({ createdAt: -1, _id: -1 }).skip(win.skip).limit(win.limit);
      summaries = await summarizeModels(models.map((m) => m._id));
    } else {
      // The tier filter applies to the DERIVED displayRiskTier, so summarise every
      // candidate (still one aggregation) and paginate afterwards.
      const all = await Model.find(filter).sort({ createdAt: -1, _id: -1 });
      summaries = await summarizeModels(all.map((m) => m._id));
      const matching = all.filter((m) => summaries.get(String(m._id)).displayRiskTier === q.tier);
      total = matching.length;
      models = matching.slice(win.skip, win.skip + win.limit);
    }

    res.json(envelope(models.map((m) => present(m, summaries.get(String(m._id)))), "models", win, total));
  } catch (err) {
    serverError(res, err, "Failed to list models");
  }
});

router.get("/:id", authGuard, async (req, res) => {
  try {
    const model = await Model.findById(req.params.id);
    if (!model) return res.status(404).json({ error: "Model not found" });
    const summaries = await summarizeModels([model._id]);
    res.json({ model: present(model, summaries.get(String(model._id))) });
  } catch (err) {
    serverError(res, err, "Failed to fetch model");
  }
});

const hasLiveVersion = (modelId) => Version.exists({ modelId, status: { $in: LIVE_STATUSES } });
const CLEAR_ARCHIVE = { isDeleted: false, deletedAt: null, deletedBy: null, deleteReason: "", deletedByCascade: false };

// Archive a model and, with it, all of its (not yet archived) versions.
router.delete("/:id", authGuard, roleGuard(["admin"]), async (req, res) => {
  try {
    const data = parse(reasonSchema, req.body, res);
    if (!data) return;
    const reason = data.reason || "";

    const model = await Model.findById(req.params.id);
    if (!model) return res.status(404).json({ error: "Model not found" });
    const LIVE_MSG = "This model has a live version -- retire it before archiving the model";
    if (await hasLiveVersion(model._id)) return res.status(409).json({ error: LIVE_MSG });

    const now = new Date();
    const archived = await Model.findOneAndUpdate(
      { _id: model._id },
      { $set: { isDeleted: true, deletedAt: now, deletedBy: req.user._id, deleteReason: reason, deletedByCascade: false } }
    );
    if (!archived) return res.status(404).json({ error: "Model not found" });

    // A deploy may have slipped in between the check and the archive: undo and refuse.
    if (await hasLiveVersion(model._id)) {
      await Model.updateOne({ _id: model._id, isDeleted: true }, { $set: CLEAR_ARCHIVE });
      return res.status(409).json({ error: LIVE_MSG });
    }

    // Versions already archived on their own keep their own reason (the plugin hides them from this update).
    let cascade;
    try {
      cascade = await Version.updateMany(
        { modelId: model._id },
        { $set: { isDeleted: true, deletedAt: now, deletedBy: req.user._id, deleteReason: reason, deletedByCascade: true } }
      );
    } catch (err) {
      // never leave an archived model with active versions: put the model back, then report the 500
      await Model.updateOne({ _id: model._id, isDeleted: true }, { $set: CLEAR_ARCHIVE }).catch(() => {});
      await Version.updateMany({ modelId: model._id, isDeleted: true, deletedByCascade: true, deletedAt: now }, { $set: CLEAR_ARCHIVE }).catch(() => {});
      throw err;
    }

    await writeAuditLog({
      actor: req.user,
      action: "archive_model",
      targetType: "Model",
      targetId: model._id,
      details: `Archived model "${model.name}" (${cascade.modifiedCount} version(s) archived with it)${reason ? ` -- ${reason}` : ""}`,
    });

    res.json({ ok: true });
  } catch (err) {
    serverError(res, err, "Failed to archive model");
  }
});

// Restore an archived model plus the versions that were archived WITH it (not the
// ones someone archived individually earlier).
router.post("/:id/restore", authGuard, roleGuard(["admin"]), async (req, res) => {
  try {
    const model = await Model.findById(req.params.id).setOptions({ includeDeleted: true });
    if (!model) return res.status(404).json({ error: "Model not found" });
    if (!model.isDeleted) return res.status(409).json({ error: "Model is not archived" });

    const clash = `Cannot restore: an active model named "${model.name}" already exists`;
    if (await activeNameClash(model.name, model._id)) return res.status(409).json({ error: clash });

    let restored;
    try {
      restored = await Model.findOneAndUpdate({ _id: model._id, isDeleted: true }, { $set: CLEAR_ARCHIVE }, { new: true });
    } catch (err) {
      if (err && err.code === 11000) return res.status(409).json({ error: clash });
      throw err;
    }
    if (!restored) return res.status(409).json({ error: "Model is not archived" });

    const versions = await Version.updateMany(
      { modelId: model._id, isDeleted: true, deletedByCascade: true },
      { $set: CLEAR_ARCHIVE }
    );

    await writeAuditLog({
      actor: req.user,
      action: "restore_model",
      targetType: "Model",
      targetId: model._id,
      details: `Restored model "${model.name}" (${versions.modifiedCount} version(s) restored)`,
    });

    const summaries = await summarizeModels([restored._id]);
    res.json({ model: present(restored, summaries.get(String(restored._id))) });
  } catch (err) {
    serverError(res, err, "Failed to restore model");
  }
});

module.exports = router;
