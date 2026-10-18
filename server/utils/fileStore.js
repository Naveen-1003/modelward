const fs = require("fs");
const path = require("path");
const env = require("../config/env");

// Best-effort delete. Accepts paths or multer file objects; ignores falsy entries,
// ENOENT and every other error -- a leftover temp file must never fail a request.
async function removeFiles(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  await Promise.all(
    list.map(async (p) => {
      try {
        await fs.promises.unlink(typeof p === "string" ? p : p.path);
      } catch (_) {
        /* already gone or not removable */
      }
    })
  );
}

// Decide what happens to uploaded files once scoring has finished.
//   STORAGE_MODE=local   -> keep everything (downloadable, re-scorable, auditable)
//   STORAGE_MODE=discard -> delete, EXCEPT when `keep` is true (a retryable failure:
//                           the user will press "Retry scoring", which needs the files)
// Returns true when the files were retained (so the caller stores/clears the paths).
async function finalizeAfterScoring({ files, keep = false }) {
  if (env.storageMode === "local" || keep) return true;
  await removeFiles(files);
  return false;
}

// Name offered to the browser on download: original upload name, stripped of anything
// that could break the Content-Disposition header or smuggle a path.
function sanitizeDownloadName(name, fallback = "download") {
  const base = path.basename(String(name || "")).replace(/[^\w.\- ()]/g, "_").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 150) : fallback;
}

function fileExists(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

module.exports = { removeFiles, finalizeAfterScoring, sanitizeDownloadName, fileExists };
