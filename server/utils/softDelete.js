// Mongoose plugin: soft delete with automatic filtering.
//
//  - Adds isDeleted / deletedAt / deletedBy / deleteReason / deletedByCascade.
//  - Every find*/count*/update*/replace*/delete-style QUERY and every aggregate()
//    silently excludes deleted documents, unless you opt in with
//        Query.setOptions({ includeDeleted: true })
//    or Model.aggregate(...).option({ includeDeleted: true }),
//    or your filter already mentions `isDeleted` explicitly -- at the top level or
//    anywhere inside $and / $or / $nor (recursively). Careful: a mention inside an
//    $or switches the automatic filter off for the WHOLE query.
//
//  NOT covered (the plugin cannot see them; filter by hand):
//    - $lookup / $graphLookup / $unionWith stages inside an aggregation, and
//      populate() across models: the joined collection's deleted docs come through.
//    - bulkWrite() / insertMany() / Model.collection.* (raw driver calls).
//    - estimatedDocumentCount(): it reads collection metadata and ignores filters
//      by design, so it is NOT hooked and counts deleted documents too. Use
//      countDocuments() when deleted documents must be excluded.
//    - aggregate pipelines that must start with $geoNear / $search / $vectorSearch:
//      the injected leading $match would break them; pass includeDeleted and
//      filter inside the stage instead.
//  - doc.softDelete({ by, reason, cascade }) / doc.restore() mutate and save.
//
// Note: documents written before this plugin existed have no isDeleted field.
// migrations/index.js backfills `isDeleted: false`; the query filter uses
// { $ne: true } so un-migrated documents are still treated as live.
const QUERY_HOOKS = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "replaceOne",
  "countDocuments",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "distinct",
];

const LOGICAL_OPERATORS = ["$and", "$or", "$nor"];

// True if the filter mentions `isDeleted` at the top level or inside $and/$or/$nor.
function mentionsIsDeleted(filter) {
  if (!filter || typeof filter !== "object") return false;
  return Object.keys(filter).some((key) => {
    if (key === "isDeleted") return true;
    return LOGICAL_OPERATORS.includes(key) && Array.isArray(filter[key]) && filter[key].some(mentionsIsDeleted);
  });
}

module.exports = function softDeletePlugin(schema) {
  schema.add({
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: schema.constructor.Types.ObjectId, ref: "User", default: null },
    deleteReason: { type: String, default: "" },
    deletedByCascade: { type: Boolean, default: false }, // archived because its parent Model was archived
  });

  function excludeDeleted(next) {
    const opts = this.getOptions ? this.getOptions() : {};
    if (opts && opts.includeDeleted) return next();
    const filter = this.getFilter ? this.getFilter() : {};
    if (!mentionsIsDeleted(filter)) {
      this.where({ isDeleted: { $ne: true } });
    }
    next();
  }
  QUERY_HOOKS.forEach((hook) => schema.pre(hook, excludeDeleted));

  schema.pre("aggregate", function excludeDeletedAggregate(next) {
    const opts = this.options || {};
    if (opts.includeDeleted) return next();
    this.pipeline().unshift({ $match: { isDeleted: { $ne: true } } });
    next();
  });

  schema.methods.softDelete = function softDelete({ by = null, reason = "", cascade = false } = {}) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = by;
    this.deleteReason = reason;
    this.deletedByCascade = cascade;
    return this.save();
  };

  schema.methods.restore = function restore() {
    this.isDeleted = false;
    this.deletedAt = null;
    this.deletedBy = null;
    this.deleteReason = "";
    this.deletedByCascade = false;
    return this.save();
  };
};
module.exports.mentionsIsDeleted = mentionsIsDeleted;
