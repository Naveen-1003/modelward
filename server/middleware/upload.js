const multer = require("multer");
const path = require("path");
const fs = require("fs");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB, plenty for an MVP
});

// "file" = the primary CSV or pickle/joblib model.
// "datasetFile" = optional companion CSV, required by the route handler when fileType != csv.
module.exports = upload.fields([
  { name: "file", maxCount: 1 },
  { name: "datasetFile", maxCount: 1 },
]);

module.exports.UPLOAD_DIR = UPLOAD_DIR;
