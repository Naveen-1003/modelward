const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const env = require("../config/env");

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

// "file" = the primary CSV or pickle/joblib model.
// "datasetFile" = companion CSV, required by the route handler when fileType != csv.
const uploadVersionFiles = makeUpload(["file", "datasetFile"]).fields([
  { name: "file", maxCount: 1 },
  { name: "datasetFile", maxCount: 1 },
]);

// Monitoring batch: a single predictions CSV in "file".
const uploadBatchFile = makeUpload(["file"]).single("file");

module.exports = uploadVersionFiles;
module.exports.uploadVersionFiles = uploadVersionFiles;
module.exports.uploadBatchFile = uploadBatchFile;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
