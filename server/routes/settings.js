const express = require("express");
const authGuard = require("../middleware/auth");
const roleGuard = require("../middleware/role");
const writeAuditLog = require("../middleware/audit");
const { parse, z } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");
const { THRESHOLD_KEYS, getThresholds } = require("../utils/settings");
const Settings = require("../models/Settings");

const router = express.Router();

// A number in [0.001, 1]; strings like "0.5" are rejected on purpose. The floor
// stops a threshold of ~0 from silently turning a rule off (or 1e-320 denormals).
const ratio = z
  .number({ invalid_type_error: "must be a number", required_error: "is required" })
  .finite("must be a number")
  .gte(0.001, "must be at least 0.001")
  .lte(1, "must be at most 1");

const putSchema = z
  .object({
    lowAccuracy: ratio,
    lowFairnessGap: ratio,
    mediumAccuracy: ratio,
    mediumFairnessGap: ratio,
    driftThreshold: ratio,
  })
  .superRefine((v, ctx) => {
    if (v.lowAccuracy < v.mediumAccuracy) {
      ctx.addIssue({ code: "custom", path: ["lowAccuracy"], message: "must be at least mediumAccuracy" });
    }
    if (v.lowFairnessGap > v.mediumFairnessGap) {
      ctx.addIssue({ code: "custom", path: ["lowFairnessGap"], message: "must be at most mediumFairnessGap" });
    }
  });

router.get("/", authGuard, async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: "global" }).populate("updatedBy", "name").lean();
    const values = await getThresholds();
    res.json({
      settings: {
        ...values,
        updatedAt: doc ? doc.updatedAt : null,
        updatedBy: doc && doc.updatedBy ? String(doc.updatedBy._id || doc.updatedBy) : null,
        updatedByName: doc && doc.updatedBy && doc.updatedBy.name ? doc.updatedBy.name : null,
      },
    });
  } catch (err) {
    serverError(res, err, "Failed to load settings");
  }
});

router.put("/", authGuard, roleGuard(["admin"]), async (req, res) => {
  try {
    const data = parse(putSchema, req.body, res);
    if (!data) return;

    const before = await getThresholds();
    const doc = await Settings.findOneAndUpdate(
      { key: "global" },
      { $set: { ...data, updatedBy: req.user._id } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const changes = THRESHOLD_KEYS.filter((k) => before[k] !== data[k]).map((k) => `${k} ${before[k]}->${data[k]}`);
    await writeAuditLog({
      actor: req.user,
      action: "update_settings",
      targetType: "Settings",
      targetId: doc._id,
      details: changes.length ? `Thresholds changed: ${changes.join(", ")}` : "Thresholds saved (no changes)",
    });

    res.json({
      settings: {
        ...data,
        updatedAt: doc.updatedAt,
        updatedBy: String(req.user._id),
        updatedByName: req.user.name,
      },
    });
  } catch (err) {
    // two admins saving for the very first time at once: unique key collision
    if (err && err.code === 11000) return res.status(409).json({ error: "Settings were just created by someone else; retry" });
    serverError(res, err, "Failed to save settings");
  }
});

module.exports = router;
