// Dashboard numbers. Everything is computed with aggregations/countDocuments
// over non-archived rows; no per-row queries and no id lists (archived models are
// filtered with a $lookup, so cost does not grow with the number of models in an $in).
const express = require("express");
const Model = require("../models/Model");
const Version = require("../models/Version");
const User = require("../models/User");
const authGuard = require("../middleware/auth");
const { isAdmin } = require("../middleware/role");
const { summarizeActive, ACTIVE_MODEL_STAGES } = require("../utils/modelSummary");
const { serverError } = require("../utils/httpErrors");

const router = express.Router();
const LIST_LIMIT = 10;
const TIERS = ["low", "medium", "high", "unrated"];

// Newest-first versions in `status`, limited to versions of non-archived models. The
// archived-model filter and the model name come from ONE $lookup (no id list, no 2nd query).
async function versionList(status) {
  const rows = await Version.aggregate(
    [
      { $match: { status } },
      { $sort: { updatedAt: -1, _id: -1 } },
      ...ACTIVE_MODEL_STAGES,
      { $limit: LIST_LIMIT },
      { $project: { modelId: 1, versionNumber: 1, riskTier: 1, updatedAt: 1, modelName: { $arrayElemAt: ["$model.name", 0] } } },
    ],
    { allowDiskUse: true }
  );
  return rows.map((v) => ({
    versionId: v._id,
    modelId: v.modelId,
    modelName: v.modelName || "",
    versionNumber: v.versionNumber,
    riskTier: v.riskTier || null,
    updatedAt: v.updatedAt,
  }));
}

router.get("/", authGuard, async (req, res) => {
  try {
    const [modelCount, statusRows, summaries, needsReview, awaitingReview] = await Promise.all([
      Model.countDocuments(),
      Version.aggregate([...ACTIVE_MODEL_STAGES, { $group: { _id: "$status", n: { $sum: 1 } } }], { allowDiskUse: true }),
      summarizeActive(),
      versionList("needs_review"),
      versionList("submitted"),
    ]);

    const byStatus = Object.fromEntries(Version.STATUSES.map((s) => [s, 0]));
    let versions = 0;
    for (const r of statusRows) {
      byStatus[r._id] = (byStatus[r._id] || 0) + r.n;
      versions += r.n;
    }

    // models without any (non-archived) version are not in `summaries`: they are "unrated"
    const byTier = { low: 0, medium: 0, high: 0, unrated: Math.max(0, modelCount - summaries.size) };
    for (const sum of summaries.values()) {
      byTier[TIERS.includes(sum.displayRiskTier) ? sum.displayRiskTier : "unrated"] += 1;
    }

    const body = {
      totals: {
        models: modelCount,
        versions,
        live: (byStatus.deployed || 0) + (byStatus.needs_review || 0),
        awaitingReview: byStatus.submitted || 0,
        needsReview: byStatus.needs_review || 0,
      },
      byStatus,
      byTier,
      needsReview,
      awaitingReview,
    };

    if (isAdmin(req.user)) {
      // This organization's users (the tenant plugin scopes both queries). total/active/byRole count
      // people who can be listed in Users (active or invited); `pending` are verified sign-ups
      // waiting for approval; unverified accounts are counted nowhere.
      const [rows, pending] = await Promise.all([
        User.aggregate([
          { $match: { status: { $in: ["active", "invited", null] } } }, // null: legacy rows without a status
          { $group: { _id: { role: "$role", active: { $ne: ["$isActive", false] } }, n: { $sum: 1 } } },
        ]),
        User.countDocuments({ status: "pending" }),
      ]);
      const users = { total: 0, active: 0, pending, byRole: {} };
      for (const r of rows) {
        users.total += r.n;
        if (r._id.active) users.active += r.n;
        users.byRole[r._id.role] = (users.byRole[r._id.role] || 0) + r.n;
      }
      body.users = users;
    }

    res.json(body);
  } catch (err) {
    serverError(res, err, "Failed to load stats");
  }
});

module.exports = router;
