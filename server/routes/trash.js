// Admin-only view of archived models and versions (restore lives on the
// models/versions routes).
const express = require("express");
const Model = require("../models/Model");
const Version = require("../models/Version");
const User = require("../models/User");
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const { serverError } = require("../utils/httpErrors");

const router = express.Router();
const CAP = 200;
const archived = { includeDeleted: true };

router.get("/", authGuard, roleGuard(["admin"]), async (req, res) => {
  try {
    const models = await Model.find({ isDeleted: true })
      .setOptions(archived)
      .sort({ deletedAt: -1 })
      .limit(CAP)
      .select("name deletedAt deleteReason deletedBy")
      .lean();

    // A version archived together with its (still archived) model comes back
    // with that model, so it is not listed on its own. Find archived parents
    // uncapped so the omission rule holds even beyond the 200-model cap.
    const archivedModelIds = (await Model.find({ isDeleted: true }).setOptions(archived).select("_id").lean()).map((m) => m._id);
    const versions = await Version.find({
      isDeleted: true,
      $nor: [{ deletedByCascade: true, modelId: { $in: archivedModelIds } }],
    })
      .setOptions(archived)
      .sort({ deletedAt: -1 })
      .limit(CAP)
      .select("versionNumber status modelId deletedAt deleteReason deletedBy deletedByCascade")
      .lean();

    const modelIds = [...new Set(versions.map((v) => String(v.modelId)))];
    const parents = modelIds.length
      ? await Model.find({ _id: { $in: modelIds } }).setOptions(archived).select("name").lean()
      : [];
    const modelName = new Map(parents.map((m) => [String(m._id), m.name]));

    const userIds = [...new Set([...models, ...versions].map((r) => r.deletedBy).filter(Boolean).map(String))];
    const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select("name").lean() : [];
    const userName = new Map(users.map((u) => [String(u._id), u.name]));
    const by = (r) => (r.deletedBy ? userName.get(String(r.deletedBy)) || "Unknown user" : null);

    res.json({
      models: models.map((m) => ({
        _id: m._id, name: m.name, deletedAt: m.deletedAt, deleteReason: m.deleteReason || "", deletedByName: by(m),
      })),
      versions: versions.map((v) => ({
        _id: v._id,
        versionNumber: v.versionNumber,
        status: v.status,
        modelId: v.modelId,
        modelName: modelName.get(String(v.modelId)) || "(unknown model)",
        deletedAt: v.deletedAt,
        deleteReason: v.deleteReason || "",
        deletedByName: by(v),
        deletedByCascade: !!v.deletedByCascade,
      })),
    });
  } catch (err) {
    serverError(res, err, "Failed to load trash");
  }
});

module.exports = router;
