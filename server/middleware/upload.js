const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const env = require("../config/env");
const { als, runWithOrg } = require("../utils/tenant");

const UPLOAD_DIR = env.uploadDir;
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = path.basename(file.originalname || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    // random suffix: two uploads of the same file in the same millisecond must not collide
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`);
  },
});

// Extension / content-type checks live in the routes (so the client gets a clean
// 400 and the temp files are removed); here we only refuse unexpected field names.
function makeUpload(allowedFields) {
  return multer({
    storage,
    limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: allowedFields.length, fields: 20, fieldSize: 64 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!allowedFields.includes(file.fieldname)) {
        return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
      }
      cb(null, true);
    },
  });
}

// multer finishes in a stream callback, which can lose the AsyncLocalStorage context that
// authGuard set up, and with it the tenant filter for everything the handler does next.
// Re-enter the request's organization (req.orgId, set by authGuard) before continuing; if the
// middleware ran outside authGuard, restore whatever context it was entered with.
function keepTenantContext(multerMiddleware) {
  return (req, res, next) => {
    const entered = als.getStore();
    multerMiddleware(req, res, (err) => {
      if (err) return next(err);
      if (req.orgId !== undefined) return runWithOrg(req.orgId, next);
      if (entered) return als.run(entered, next);
      return next();
    });
  };
}

// "file" = the primary CSV or pickle/joblib model.
// "datasetFile" = companion CSV, required by the route handler when fileType != csv.
const uploadVersionFiles = keepTenantContext(makeUpload(["file", "datasetFile"]).fields([
  { name: "file", maxCount: 1 },
  { name: "datasetFile", maxCount: 1 },
]));

// Monitoring batch: a single predictions CSV in "file".
const uploadBatchFile = keepTenantContext(makeUpload(["file"]).single("file"));

module.exports = uploadVersionFiles;
module.exports.uploadVersionFiles = uploadVersionFiles;
module.exports.uploadBatchFile = uploadBatchFile;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
