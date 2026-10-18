const mongoose = require("mongoose");

// Discussion thread on a version. Append-only like the audit log: a comment can
// be added but never edited or removed (the review trail must stay trustworthy).
const commentSchema = new mongoose.Schema({
  versionId: { type: mongoose.Schema.Types.ObjectId, ref: "Version", required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  authorName: { type: String, required: true },
  authorRole: { type: String, required: true },
  body: { type: String, required: true, maxlength: 2000 },
}, { timestamps: { createdAt: true, updatedAt: false } });

commentSchema.index({ versionId: 1, createdAt: 1 });

function blocked(next) {
  next(new Error("Comments are immutable"));
}
["updateOne", "updateMany", "replaceOne", "findOneAndUpdate", "findOneAndReplace",
  "findOneAndDelete", "deleteOne", "deleteMany"].forEach((hook) => commentSchema.pre(hook, blocked));
commentSchema.pre("save", function noUpdates(next) {
  if (!this.isNew) return next(new Error("Comments are immutable"));
  next();
});
commentSchema.pre("deleteOne", { document: true, query: false }, blocked);
commentSchema.pre("updateOne", { document: true, query: false }, blocked);

module.exports = mongoose.model("Comment", commentSchema);
