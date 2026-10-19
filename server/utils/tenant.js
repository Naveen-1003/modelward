// Multi-tenant isolation: one AsyncLocalStorage context + one Mongoose plugin.
//
// How it works
//  - authGuard resolves the caller's organization and runs the rest of the request chain
//    inside runWithOrg(orgId, next). The store lives across awaits, so every query a route
//    makes sees it without passing the org around.
//  - tenantPlugin(schema) adds `orgId` and restricts EVERY query hook and aggregate() of that
//    model with  this.and([{ orgId }])  -- `and`, never `where`, because `where` would
//    overwrite a caller-supplied orgId (e.g. a body field that leaked into a filter) while
//    `$and` can only narrow the result.
//  - FAIL CLOSED: a query that has no org context (no store, or a store whose orgId is null,
//    e.g. a super admin who has not selected an organization) throws TenantContextError
//    instead of running unfiltered.
//
// Ways to run cross-tenant (all of them are reviewed: tests/tenantAllowlist.test.js fails if
// `bypassTenant` / `runSystem` shows up in a file that is not on the allow-list):
//    Model.find(f).setOptions({ bypassTenant: true })       one explicit query
//    Model.aggregate(p).option({ bypassTenant: true })       one explicit aggregate
//    runSystem(() => ...)                                    a whole job / migration / test
//
// NOT covered (the plugin cannot see them; do not use them on tenant models):
//    - Model.collection.* (raw driver calls) never reach Mongoose hooks.
//    - $lookup / $graphLookup / $unionWith stages inside an aggregation: only the root
//      collection is filtered. populate() IS covered: it runs a normal find on the target
//      model, but it does NOT inherit `bypassTenant` from the parent query -- pass
//      populate({ path, options: { bypassTenant: true } }) or use runSystem.
//    - bulkWrite() is refused outright (it cannot be scoped); estimatedDocumentCount() is
//      refused in a scoped context (it ignores filters by design) -- use countDocuments().
//    - Aggregations that must begin with $geoNear / $search / $searchMeta / $vectorSearch are
//      refused in a scoped context (a leading $match would break them).
//    - doc.save() of an already-loaded document writes by _id and runs no query hook; it is
//      guarded separately (see the save hook).
const { AsyncLocalStorage } = require("async_hooks");
const mongoose = require("mongoose");

const { ObjectId } = mongoose.Types;

// Store shape: { orgId: ObjectId|null, bypass: boolean }
const als = new AsyncLocalStorage();

class TenantContextError extends Error {
  constructor(message = "Select an organization first") {
    super(message);
    this.name = "TenantContextError";
    this.status = 400;
    this.code = "ORG_REQUIRED";
  }
}

// A tenant rule was broken by the CODE (writing into another org, changing an orgId, using an
// unscopable operation). A bug, not a client error: no `status`, so it surfaces as a 500.
class TenantViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantViolationError";
    this.code = "TENANT_VIOLATION";
  }
}

// ObjectId | 24-hex string | document with _id -> ObjectId. null/undefined -> null.
function toObjectId(value) {
  if (value == null) return null;
  if (value instanceof ObjectId) return value;
  const raw = value && value._id ? value._id : value;
  if (raw instanceof ObjectId) return raw;
  if (typeof raw === "string" && /^[a-f0-9]{24}$/i.test(raw)) return new ObjectId(raw);
  throw new TypeError("orgId must be an ObjectId or a 24-character hex string");
}

// A Mongoose Query / Aggregate is lazy: it only picks up the async context when it EXECUTES.
// `runWithOrg(id, () => Model.find())` would hand the unexecuted query back and it would run
// after the context is gone (and fail closed). So a returned Query/Aggregate is executed here,
// inside the context; the caller gets the promise. Anything else is returned untouched.
const isLazyQuery = (r) => r && !(r instanceof Promise) && typeof r.exec === "function" && typeof r.then === "function";
function enter(store, fn) {
  return als.run(store, () => {
    const result = fn();
    return isLazyQuery(result) ? result.exec() : result;
  });
}

// Runs fn with the given organization as the tenant. orgId null = "no organization selected":
// queries on tenant models fail closed inside it. (fn should await its queries; see above.)
function runWithOrg(orgId, fn) {
  return enter({ orgId: toObjectId(orgId), bypass: false }, fn);
}

// Cross-tenant execution for jobs, migrations and tests. Never use it in request handlers.
function runSystem(fn) {
  return enter({ orgId: null, bypass: true }, fn);
}

function currentOrgId() {
  const store = als.getStore();
  return (store && store.orgId) || null;
}

// What a query may do right now: null = unrestricted (explicit, reviewed bypass), an ObjectId =
// restricted to that organization; otherwise fail closed.
// Resolution order: option `bypassTenant: true` -> store.bypass -> store.orgId -> throw.
function scopeFor(options) {
  if (options && options.bypassTenant === true) return null;
  const store = als.getStore();
  if (store && store.bypass) return null;
  if (store && store.orgId) return store.orgId;
  throw new TenantContextError();
}

const QUERY_HOOKS = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "countDocuments",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "replaceOne",
  "distinct",
];
const UPDATE_OPS = new Set(["findOneAndUpdate", "updateOne", "updateMany"]);
const REPLACE_OPS = new Set(["findOneAndReplace", "replaceOne"]);
const FIRST_STAGE_ONLY = ["$geoNear", "$search", "$searchMeta", "$vectorSearch"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Does this update try to write the orgId field? Top level (mongoose wraps it into $set),
// any operator ($set, $setOnInsert, $unset, $rename target, $min, ...) or an update pipeline.
function updateTouchesOrg(update) {
  if (!update) return false;
  if (Array.isArray(update)) {
    // Pipeline update: conservative text check, plus whole-document replacement stages.
    return update.some((stage) => {
      const keys = isPlainObject(stage) ? Object.keys(stage) : [];
      return keys.includes("$replaceRoot") || keys.includes("$replaceWith") || JSON.stringify(stage).includes('"orgId"');
    });
  }
  if (!isPlainObject(update)) return false;
  for (const key of Object.keys(update)) {
    if (key === "orgId") return true;
    if (key.startsWith("$") && isPlainObject(update[key])) {
      if (Object.prototype.hasOwnProperty.call(update[key], "orgId")) return true;
      if (key === "$rename" && Object.values(update[key]).includes("orgId")) return true;
    }
  }
  return false;
}

// Create rules, applied to a document that is being inserted (save of a new doc, insertMany):
//   - no orgId  -> takes the context org; with no context at all the caller must have set one
//                  explicitly (signup / migration / seed), otherwise TenantContextError;
//   - an orgId that differs from the (non-bypass) context org -> TenantViolationError;
//   - optionalOrg schemas (User, AuditLog) may be created with no org: an explicit `null`
//     means "platform level" and is never overwritten by the context.
function applyCreateRules(doc, optionalOrg) {
  const store = als.getStore();
  const ctxOrg = store && !store.bypass ? store.orgId : null;
  const current = doc.orgId;
  if (current == null) {
    if (current === null && optionalOrg) return;
    if (ctxOrg) {
      doc.orgId = ctxOrg;
      return;
    }
    if (optionalOrg) return;
    throw new TenantContextError();
  }
  if (ctxOrg && String(current._id || current) !== String(ctxOrg)) {
    throw new TenantViolationError("Cannot create a document in a different organization than the current one");
  }
}

function tenantPlugin(schema, opts = {}) {
  const optionalOrg = Boolean(opts.optionalOrg);
  const orgPath = { type: mongoose.Schema.Types.ObjectId, ref: "Organization" };
  // `unique` (Settings: one document per org) replaces the plain index; they cannot both exist.
  if (opts.unique) orgPath.unique = true;
  else orgPath.index = true;
  if (!optionalOrg) orgPath.required = true;
  schema.add({ orgId: orgPath });

  // --- queries ---------------------------------------------------------------------------
  function scopeQuery(next) {
    try {
      const orgId = scopeFor(this.getOptions());
      if (orgId) {
        const op = this.op;
        if (UPDATE_OPS.has(op)) {
          const update = this.getUpdate();
          if (updateTouchesOrg(update)) {
            throw new TenantViolationError("orgId cannot be changed by an update");
          }
          // An upsert creates the row from the filter's equality conditions, but say it
          // explicitly: the new row belongs to the current org no matter what.
          if (this.getOptions().upsert && isPlainObject(update)) {
            this.setUpdate({ ...update, $setOnInsert: { ...update.$setOnInsert, orgId } });
          }
        } else if (REPLACE_OPS.has(op)) {
          const replacement = this.getUpdate() || {};
          if (replacement.orgId != null && String(replacement.orgId) !== String(orgId)) {
            throw new TenantViolationError("orgId cannot be changed by a replacement");
          }
          this.setUpdate({ ...replacement, orgId }); // a replacement without orgId would orphan the row
        }
        this.and([{ orgId }]);
      }
      next();
    } catch (err) {
      next(err);
    }
  }
  QUERY_HOOKS.forEach((hook) => schema.pre(hook, scopeQuery));

  // Collection metadata ignores filters, so it cannot be scoped.
  schema.pre("estimatedDocumentCount", function guardEstimated(next) {
    try {
      if (scopeFor(this.getOptions())) throw new TenantViolationError("estimatedDocumentCount() cannot be scoped to an organization; use countDocuments()");
      next();
    } catch (err) {
      next(err);
    }
  });

  schema.pre("aggregate", function scopeAggregate(next) {
    try {
      const orgId = scopeFor(this.options);
      if (orgId) {
        const pipeline = this.pipeline();
        // (checked on every stage: another plugin's leading $match may already sit in front)
        const special = pipeline.map((stage) => Object.keys(stage || {})[0]).find((key) => FIRST_STAGE_ONLY.includes(key));
        if (special) {
          throw new TenantViolationError(`${special} must be the first stage and cannot be tenant-scoped; use bypassTenant and filter inside the stage`);
        }
        pipeline.unshift({ $match: { orgId } });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  // bulkWrite takes arbitrary mixed operations; scoping them is not worth the risk.
  schema.pre("bulkWrite", function guardBulk(next, ops, options) {
    try {
      if (scopeFor(options)) throw new TenantViolationError("bulkWrite() is not allowed on tenant-scoped models inside an organization; run it under runSystem");
      next();
    } catch (err) {
      next(err);
    }
  });

  // --- creates ---------------------------------------------------------------------------
  // `validate` runs before the `required` check, so a context-filled orgId satisfies it.
  // `save` repeats it for validateBeforeSave:false; applyCreateRules is idempotent.
  schema.pre("validate", function createRulesOnValidate(next) {
    try {
      if (this.isNew) applyCreateRules(this, optionalOrg);
      next();
    } catch (err) {
      next(err);
    }
  });

  schema.pre("save", function guardSave(next) {
    try {
      if (this.isNew) {
        applyCreateRules(this, optionalOrg);
        return next();
      }
      // A loaded document is written by _id (no query hook runs). Never let its org move,
      // and never let a request in org A save a document that belongs to org B.
      const store = als.getStore();
      if (store && store.bypass) return next();
      if (this.isModified("orgId")) throw new TenantViolationError("orgId cannot be changed");
      const ctxOrg = store && store.orgId;
      if (ctxOrg && !optionalOrg && this.orgId && String(this.orgId._id || this.orgId) !== String(ctxOrg)) {
        throw new TenantViolationError("Cannot save a document that belongs to a different organization");
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  // insertMany skips save middleware. `docs` are the raw inputs (plain objects or documents).
  schema.pre("insertMany", function createRulesOnInsertMany(next, docs) {
    try {
      (Array.isArray(docs) ? docs : [docs]).forEach((d) => applyCreateRules(d, optionalOrg));
      next();
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { als, runWithOrg, runSystem, currentOrgId, tenantPlugin, TenantContextError, TenantViolationError };
module.exports.updateTouchesOrg = updateTouchesOrg;
