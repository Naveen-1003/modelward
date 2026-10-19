// Guards the tenant boundary at the source level: the explicit ways of leaving it
// (`bypassTenant` option, `runSystem`) may only appear in reviewed files (plan section 2).
// Adding a new use means adding the file to ALLOWED here, which is the review.
const fs = require("fs");
const path = require("path");

const SERVER_ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "tests", "uploads", "coverage", ".git"]);

// Paths relative to server/, forward slashes.
const ALLOWED = new Set([
  "utils/tenant.js", // defines them
  "middleware/auth.js",
  "middleware/audit.js",
  "utils/auditChain.js",
  "routes/auth.js",
  "routes/orgs.js",
  "routes/users.js", // actor re-check only
  "routes/audit.js", // super admin all-orgs view
  "routes/stats.js",
  "utils/crossOrg.js",
  "utils/superAdmin.js",
  "migrations/index.js",
  "jobs/cleanup.js",
  "jobs/expireUnverified.js",
]);

const PATTERN = /\b(bypassTenant|runSystem)\b/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.(js|cjs|mjs|ts)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const rel = (f) => path.relative(SERVER_ROOT, f).split(path.sep).join("/");

describe("bypassTenant / runSystem allow-list", () => {
  const files = walk(SERVER_ROOT);

  test("the scan sees the server source", () => {
    const rels = files.map(rel);
    expect(rels).toEqual(expect.arrayContaining(["app.js", "utils/tenant.js", "middleware/auth.js", "models/User.js"]));
    expect(rels.some((r) => r.startsWith("tests/") || r.startsWith("node_modules/"))).toBe(false);
  });

  test("they only appear in reviewed files", () => {
    const offenders = files.filter((f) => PATTERN.test(fs.readFileSync(f, "utf8"))).map(rel).filter((r) => !ALLOWED.has(r));
    expect(offenders).toEqual([]);
  });

  test("the core files that must use them still do", () => {
    for (const f of ["utils/tenant.js", "middleware/auth.js", "middleware/audit.js", "utils/auditChain.js", "utils/crossOrg.js"]) {
      expect(PATTERN.test(fs.readFileSync(path.join(SERVER_ROOT, f), "utf8"))).toBe(true);
    }
  });

  test("models and the plain middleware never bypass", () => {
    const strict = files.map(rel).filter((r) => /^(models|middleware)\//.test(r) && !ALLOWED.has(r));
    expect(strict.length).toBeGreaterThan(0);
    for (const r of strict) expect(PATTERN.test(fs.readFileSync(path.join(SERVER_ROOT, r), "utf8"))).toBe(false);
  });
});
