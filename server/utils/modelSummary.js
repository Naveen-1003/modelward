const mongoose = require("mongoose");
const Version = require("../models/Version");
const Model = require("../models/Model");
const { LIVE_STATUSES } = Version;

// Pipeline stages that keep only versions whose model is NOT archived (a $lookup against the
// models collection), for aggregations over "everything" where an id list would be huge.
// Adds `model` = [{ name }] to each surviving version.
// Only the root collection of an aggregation is tenant-filtered (the plugin cannot see inside a
// $lookup), so the join also requires the model to carry the SAME orgId as the version it joins.
const ACTIVE_MODEL_STAGES = [
  {
    $lookup: {
      from: Model.collection.name,
      let: { modelId: "$modelId", orgId: "$orgId" },
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ["$_id", "$$modelId"] }, { $eq: ["$orgId", "$$orgId"] }] } } },
        { $match: { isDeleted: { $ne: true } } },
        { $project: { name: 1 } },
      ],
      as: "model",
    },
  },
  { $match: { "model.0": { $exists: true } } },
];

// Per-model summary used by the registry list, model detail and /stats.
// ONE aggregation over the non-archived versions of every requested model
// (the softDelete plugin adds the isDeleted filter to aggregate() for us).
//
//   latest = highest versionNumber (any status, drafts included)
//   live   = the deployed / needs_review version (newest if, defensively, several)
//   displayRiskTier = live tier if there is a live version, else latest tier, else "unrated"
async function summarizeModels(modelIds) {
  const ids = [...new Set((modelIds || []).map(String))]
    .filter((id) => /^[a-f\d]{24}$/i.test(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const out = new Map();
  for (const id of ids) out.set(String(id), emptySummary());
  if (!ids.length) return out;

  const rows = await Version.aggregate([{ $match: { modelId: { $in: ids } } }, ...SUMMARY_STAGES], { allowDiskUse: true });
  for (const row of rows) out.set(String(row._id), fold(row));
  return out;
}

// Same summary for EVERY non-archived model with at least one non-archived version, without
// passing ids around (used by /stats). Models absent from the map are "unrated" / empty.
async function summarizeActive() {
  const rows = await Version.aggregate([...ACTIVE_MODEL_STAGES, ...SUMMARY_STAGES], { allowDiskUse: true });
  return new Map(rows.map((row) => [String(row._id), fold(row)]));
}

const SUMMARY_STAGES = [
  { $sort: { versionNumber: -1 } },
  {
    $group: {
      _id: "$modelId",
      versionCount: { $sum: 1 },
      latest: { $first: { versionNumber: "$versionNumber", status: "$status", riskTier: "$riskTier" } },
      live: {
        $push: {
          $cond: [
            { $in: ["$status", LIVE_STATUSES] },
            { versionNumber: "$versionNumber", status: "$status", riskTier: "$riskTier" },
            "$$REMOVE",
          ],
        },
      },
    },
  },
];

function fold(row) {
  const live = row.live && row.live.length ? row.live[0] : null; // sorted newest-first
  const latestRiskTier = row.latest.riskTier || "unrated";
  return {
    versionCount: row.versionCount,
    latestVersionNumber: row.latest.versionNumber,
    latestVersionStatus: row.latest.status,
    latestRiskTier,
    liveVersionNumber: live ? live.versionNumber : null,
    liveVersionStatus: live ? live.status : null,
    liveRiskTier: live ? live.riskTier || "unrated" : null,
    displayRiskTier: live ? live.riskTier || "unrated" : latestRiskTier,
  };
}

function emptySummary() {
  return {
    versionCount: 0,
    latestVersionNumber: null,
    latestVersionStatus: null,
    latestRiskTier: "unrated",
    liveVersionNumber: null,
    liveVersionStatus: null,
    liveRiskTier: null,
    displayRiskTier: "unrated",
  };
}

module.exports = { summarizeModels, summarizeActive, emptySummary, ACTIVE_MODEL_STAGES };
