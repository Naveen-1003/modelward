const express = require("express");
const Model = require("../models/Model");
const Version = require("../models/Version");
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const writeAuditLog = require("../middleware/audit");

const router = express.Router();

// A Model has no stored risk tier -- it's derived, on read, from its latest
// version. No versions yet = "unrated". Never cached back onto the Model doc.
async function annotateWithLatestRiskTier(modelDoc) {
  const latestVersion = await Version.findOne({ modelId: modelDoc._id })
    .sort({ versionNumber: -1 })
    .select("versionNumber riskTier status")
    .lean();

  return {
    ...modelDoc.toObject(),
    latestRiskTier: latestVersion ? latestVersion.riskTier || "unrated" : "unrated",
    latestVersionNumber: latestVersion ? latestVersion.versionNumber : null,
    latestVersionStatus: latestVersion ? latestVersion.status : null,
  };
}

router.post("/", authGuard, roleGuard(["ml_engineer", "admin"]), async (req, res) => {
  try {
    const { name, description, useCase } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    if ("riskTier" in req.body) {
      return res.status(400).json({ error: "riskTier is not accepted at creation -- it is computed per version" });
    }

    const model = await Model.create({
      name,
      description: description || "",
      useCase: useCase || "",
      createdBy: req.user._id,
    });

    await writeAuditLog({
      actor: req.user,
      action: "create_model",
      targetType: "Model",
      targetId: model._id,
      details: `Created model "${model.name}"`,
    });

    res.status(201).json({ model: await annotateWithLatestRiskTier(model) });
  } catch (err) {
    res.status(500).json({ error: "Failed to create model", details: err.message });
  }
});

router.get("/", authGuard, async (req, res) => {
  try {
    const models = await Model.find().sort({ createdAt: -1 });
    const annotated = await Promise.all(models.map(annotateWithLatestRiskTier));
    res.json({ models: annotated });
  } catch (err) {
    res.status(500).json({ error: "Failed to list models", details: err.message });
  }
});

router.get("/:id", authGuard, async (req, res) => {
  try {
    const model = await Model.findById(req.params.id);
    if (!model) return res.status(404).json({ error: "Model not found" });
    res.json({ model: await annotateWithLatestRiskTier(model) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch model", details: err.message });
  }
});

module.exports = router;
