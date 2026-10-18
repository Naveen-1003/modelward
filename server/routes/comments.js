// Mounted at /api with full paths. Any authenticated role may read and post.
const express = require("express");
const Comment = require("../models/Comment");
const Version = require("../models/Version");
const authGuard = require("../middleware/auth");
const audit = require("../middleware/audit");
const writeAuditLog = audit.writeAuditLog || audit;
const validId = require("../middleware/validId");
const { parse, requiredStr, z } = require("../middleware/validate");
const { serverError } = require("../utils/httpErrors");

const router = express.Router();
router.param("id", validId);

const commentSchema = z.object({ body: requiredStr(2000) });

const toJson = (c) => ({
  _id: c._id,
  authorName: c.authorName,
  authorRole: c.authorRole,
  body: c.body,
  createdAt: c.createdAt,
});

// Archived versions are invisible (soft-delete plugin), so they 404 here too.
async function findVersion(id) {
  return Version.findById(id).select("_id modelId versionNumber").lean();
}

router.get("/versions/:id/comments", authGuard, async (req, res) => {
  try {
    if (!(await findVersion(req.params.id))) return res.status(404).json({ error: "Version not found" });
    const comments = await Comment.find({ versionId: req.params.id }).sort({ createdAt: 1, _id: 1 }).limit(1000).lean();
    res.json({ comments: comments.map(toJson) });
  } catch (err) {
    serverError(res, err, "Failed to load comments");
  }
});

router.post("/versions/:id/comments", authGuard, async (req, res) => {
  try {
    const data = parse(commentSchema, req.body, res);
    if (!data) return;
    const version = await findVersion(req.params.id);
    if (!version) return res.status(404).json({ error: "Version not found" });

    const comment = await Comment.create({
      versionId: version._id,
      authorId: req.user._id,
      authorName: req.user.name,
      authorRole: req.user.role,
      body: data.body,
    });

    const excerpt = data.body.replace(/\s+/g, " ");
    await writeAuditLog({
      actor: req.user,
      action: "comment",
      targetType: "Version",
      targetId: version._id,
      details: `v${version.versionNumber}: ${excerpt.length > 120 ? excerpt.slice(0, 117) + "..." : excerpt}`,
    });
    res.status(201).json({ comment: toJson(comment) });
  } catch (err) {
    serverError(res, err, "Failed to post comment");
  }
});

module.exports = router;
