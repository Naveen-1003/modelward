// Single source of truth for configuration. Loaded once at startup; every other
// module reads from here instead of touching process.env directly.
//
// Parsing never throws (a bad value must not crash `require`): problems are
// collected in `loadProblems` and reported by validateEnv(), which server.js
// calls at startup and which throws with ALL problems listed.
require("dotenv").config();
const path = require("path");

const loadProblems = [];
const raw = (name) => {
  const v = process.env[name];
  return v === undefined ? "" : String(v).trim();
};

const KNOWN_NODE_ENVS = ["development", "production", "test"];
const nodeEnvRaw = raw("NODE_ENV");
const nodeEnv = (nodeEnvRaw || "development").toLowerCase();
if (!KNOWN_NODE_ENVS.includes(nodeEnv)) {
  loadProblems.push(`NODE_ENV "${nodeEnvRaw}" is not one of: ${KNOWN_NODE_ENVS.join(", ")}`);
}
const isProd = nodeEnv === "production";

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];
function bool(name, fallback) {
  const v = raw(name).toLowerCase();
  if (v === "") return fallback;
  if (TRUE_WORDS.includes(v)) return true;
  if (FALSE_WORDS.includes(v)) return false;
  loadProblems.push(`${name} must be one of true/false/1/0/yes/no/on/off (got "${raw(name)}")`);
  return fallback;
}
// Strict integer: "abc", "1.5", "10s" and values below `min` are reported (and the
// fallback is used) instead of being silently half-parsed.
function int(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = raw(name);
  if (v === "") return fallback;
  const n = /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    loadProblems.push(`${name} must be an integer between ${min} and ${max === Number.MAX_SAFE_INTEGER ? "infinity" : max} (got "${v}")`);
    return fallback;
  }
  return n;
}
function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Canonical form of a browser origin: lowercase scheme + host, no trailing slash,
// default ports dropped. Used for both CLIENT_ORIGIN entries and the request's
// Origin header so the comparison is not defeated by cosmetics. Returns null when
// the value is not a plain http(s) origin.
function normalizeOrigin(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) return null;
    return u.origin; // already lowercased, no trailing slash
  } catch {
    return null;
  }
}

const clientOrigins = [];
for (const entry of list(process.env.CLIENT_ORIGIN)) {
  const n = normalizeOrigin(entry);
  if (n) clientOrigins.push(n);
  else loadProblems.push(`CLIENT_ORIGIN entry "${entry}" is not a valid origin (expected e.g. https://app.example.com, no path)`);
}

// TRUST_PROXY: "true"/"false" -> booleans, digits -> hop count, anything else is
// passed to Express as a proxy-addr spec ("loopback", "10.0.0.0/8", "a,b", ...).
// Invalid values are reported and ignored (trust nothing) rather than crashing.
function parseTrustProxy() {
  const v = raw("TRUST_PROXY");
  if (v === "") return false;
  const lower = v.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n > 32) {
      loadProblems.push(`TRUST_PROXY hop count ${n} is implausibly large`);
      return false;
    }
    return n;
  }
  try {
    require("proxy-addr").compile(list(v)); // the same compiler Express uses
    return v;
  } catch (err) {
    loadProblems.push(`TRUST_PROXY "${v}" is not a valid proxy-addr value (${err.message})`);
    return false;
  }
}

// jsonwebtoken reads a bare numeric STRING as milliseconds, so plain digits are
// converted to a number (= seconds). Otherwise: digits + s|m|h|d.
function parseJwtExpiry() {
  const v = raw("JWT_EXPIRES_IN");
  if (v === "") return "12h";
  if (/^\d+$/.test(v) && Number(v) > 0) return Number(v);
  if (/^[1-9]\d*[smhd]$/i.test(v)) return v.toLowerCase();
  loadProblems.push(`JWT_EXPIRES_IN must be seconds or a number followed by s, m, h or d, e.g. 3600 or 12h (got "${v}")`);
  return "12h";
}

const metricsUrlRaw = raw("METRICS_SERVICE_URL");

// Email delivery (utils/email.js). "console" prints / records mails (development, tests);
// "apps_script" posts them to a Google Apps Script web app that sends them.
const EMAIL_PROVIDERS = ["console", "apps_script"];
const emailProviderRaw = raw("EMAIL_PROVIDER").toLowerCase();
let emailProvider = "console";
if (emailProviderRaw && EMAIL_PROVIDERS.includes(emailProviderRaw)) emailProvider = emailProviderRaw;
else if (emailProviderRaw) loadProblems.push(`EMAIL_PROVIDER "${raw("EMAIL_PROVIDER")}" is not one of: ${EMAIL_PROVIDERS.join(", ")}`);

// Base URL used to build links in emails (verification, password setup).
let appUrl = clientOrigins[0] || "http://localhost:5173";
if (raw("APP_URL")) {
  const n = normalizeOrigin(raw("APP_URL").replace(/\/+$/, ""));
  if (n) appUrl = n;
  else loadProblems.push(`APP_URL "${raw("APP_URL")}" is not a valid origin (expected e.g. https://app.example.com, no path)`);
}

const superAdminEmail = raw("SUPER_ADMIN_EMAIL").toLowerCase();
if (superAdminEmail && !/^[^\s@]+@[^\s@]+$/.test(superAdminEmail)) {
  loadProblems.push("SUPER_ADMIN_EMAIL is not a valid email address");
}

const env = {
  isProd,
  nodeEnv,
  port: int("PORT", 5000, { max: 65535 }),
  mongoUri: raw("MONGO_URI") || "mongodb://127.0.0.1:27017/modelward",

  jwtSecret: process.env.JWT_SECRET || "",
  jwtExpiresIn: parseJwtExpiry(),

  // Comma-separated list of allowed browser origins (e.g. the Vercel URL),
  // normalized (see normalizeOrigin).
  // Unset in development => any localhost origin is accepted.
  // Unset in production => no cross-origin access.
  clientOrigins,
  normalizeOrigin,
  // Render sits behind a proxy; set TRUST_PROXY=1 there so rate limiting sees real IPs.
  trustProxy: parseTrustProxy(),

  metricsUrl: (metricsUrlRaw || "http://127.0.0.1:8000").replace(/\/+$/, ""),
  metricsUrlConfigured: metricsUrlRaw !== "",
  metricsSecret: process.env.METRICS_SHARED_SECRET || "",
  metricsTimeoutMs: int("METRICS_TIMEOUT_MS", 90000),
  // How long to keep pinging /health for a sleeping (Render free tier) service
  // before giving up. 0 = do not wait (fast fail, the dev default).
  metricsWakeTimeoutMs: int("METRICS_WAKE_TIMEOUT_MS", isProd ? 60000 : 0, { min: 0 }),

  // Pickle/joblib files execute code when loaded. Off by default in production.
  allowModelFiles: bool("ALLOW_MODEL_FILES", !isProd),

  // "local"   = keep uploaded files on disk (downloadable, re-scorable). Dev default.
  // "discard" = delete files once scoring is done (Render's disk is ephemeral). Prod default.
  storageMode: ["local", "discard"].includes(process.env.STORAGE_MODE)
    ? process.env.STORAGE_MODE
    : (isProd ? "discard" : "local"),
  uploadDir: process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(__dirname, "..", "uploads"),
  maxUploadMb: int("MAX_UPLOAD_MB", 25),
  retentionDays: int("RETENTION_DAYS", 30),

  minPasswordLength: 8,

  // Email (utils/email.js). The secret travels in the request body because Apps Script
  // cannot read custom headers; it is never logged or returned.
  emailProvider,
  appsScriptUrl: raw("APPS_SCRIPT_URL"),
  appsScriptSecret: raw("APPS_SCRIPT_SECRET"),
  emailFromName: raw("EMAIL_FROM_NAME") || "ModelWard",
  appUrl,
  // Self-signup depends on email verification, so it is off in production unless real
  // email delivery is configured.
  signupEnabled: !(isProd && emailProvider === "console"),

  // Platform owner, promoted/seeded at startup (utils/superAdmin.js). Never created by signup.
  superAdminEmail,
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || "",
  superAdminName: raw("SUPER_ADMIN_NAME") || "Platform Admin",
  // Organization that receives pre-existing data when the multi-tenant migration runs.
  defaultOrgName: raw("DEFAULT_ORG_NAME") || "Default Organization",

  // Optional key for the audit-log hash chain (HMAC-SHA256 instead of plain
  // SHA-256). See utils/auditChain.js for what this does and does not protect.
  auditHmacKey: process.env.AUDIT_HMAC_KEY || "",

  enableDriftSimulation: bool("ENABLE_DRIFT_SIMULATION", true),

  // Rate limits. Failed-login limiters only count failed attempts.
  loginMaxFailures: int("LOGIN_MAX_FAILURES", 10), // per IP
  loginAccountMaxFailures: int("LOGIN_ACCOUNT_MAX_FAILURES", 10), // per (normalized) email
  loginWindowMinutes: int("LOGIN_WINDOW_MINUTES", 15),
  signupMaxPerHour: int("SIGNUP_MAX_PER_HOUR", 20),
  joinCodeMaxFailures: int("JOIN_CODE_MAX_FAILURES", 10), // invalid join codes per IP
  joinCodeWindowMinutes: 15,
  resendVerifyMax: int("RESEND_VERIFY_MAX", 5), // verification re-sends per IP / per email per hour
  apiMaxPerMinute: int("API_MAX_PER_MINUTE", 600),
};

// Anything that looks like a copied template value.
const PLACEHOLDER = /replace|change[-_]?me|example|secret/i;
// 127.0.0.1, localhost, 0.0.0.0, [::1] / ::1 (but not e.g. 2001:db8::1)
const LOCALHOST = /127\.0\.0\.1|localhost|0\.0\.0\.0|(^|[^0-9a-f:])::1([^0-9a-f:]|$)/i;
const WEAK_SECRETS = ["modelward_dev_secret_change_me", "changeme", "secret", "change_me"];

// Throws on a configuration that must never reach production; warns in development.
function validateEnv() {
  const problems = [...loadProblems];
  const warnings = [];

  if (!env.jwtSecret) problems.push("JWT_SECRET is required");
  else {
    const distinct = new Set(env.jwtSecret).size;
    const weak = env.jwtSecret.length < 32 || WEAK_SECRETS.includes(env.jwtSecret);
    if (isProd) {
      if (weak) problems.push("JWT_SECRET must be a random string of at least 32 characters in production");
      else if (PLACEHOLDER.test(env.jwtSecret)) problems.push("JWT_SECRET looks like a placeholder (contains replace/change-me/example/secret); generate a random one");
      else if (distinct < 10) problems.push("JWT_SECRET has fewer than 10 distinct characters; generate a random one");
    } else if (weak) {
      warnings.push("JWT_SECRET is weak -- fine for local development, never for production");
    }
  }

  if (env.emailProvider === "apps_script") {
    let urlOk = false;
    if (env.appsScriptUrl) {
      try {
        urlOk = new URL(env.appsScriptUrl).protocol === "https:";
      } catch {
        urlOk = false;
      }
    }
    if (isProd) {
      if (!urlOk) problems.push("APPS_SCRIPT_URL must be an https URL when EMAIL_PROVIDER=apps_script in production");
      if (!env.appsScriptSecret) problems.push("APPS_SCRIPT_SECRET is required when EMAIL_PROVIDER=apps_script in production");
    } else if (!urlOk || !env.appsScriptSecret) {
      warnings.push("EMAIL_PROVIDER=apps_script but APPS_SCRIPT_URL (https) or APPS_SCRIPT_SECRET is missing: emails will fail to send");
    }
  }

  if (isProd) {
    if (!env.superAdminEmail) warnings.push("SUPER_ADMIN_EMAIL is not set: nobody can manage organizations until a platform admin is configured");
    if (env.emailProvider === "console") warnings.push("EMAIL_PROVIDER=console in production: self-signup is disabled and no email is sent. Set EMAIL_PROVIDER=apps_script (APPS_SCRIPT_URL, APPS_SCRIPT_SECRET)");
    if (LOCALHOST.test(env.appUrl)) warnings.push("APP_URL points at localhost: links in emails will not work for recipients. Set APP_URL to the public site address");
    else if (!env.appUrl.startsWith("https://")) warnings.push("APP_URL is not https: the one-time verification and password-setup links in emails carry secrets and would travel in clear text");
    if (env.trustProxy === false) warnings.push("TRUST_PROXY is not set: behind a reverse proxy (Render: TRUST_PROXY=1) every client appears under the proxy's address, so all users share ONE rate-limit bucket (a few failed logins or join-code attempts would lock everyone out)");
    if (!env.metricsSecret) problems.push("METRICS_SHARED_SECRET is required in production");
    if (LOCALHOST.test(env.mongoUri)) problems.push("MONGO_URI points at localhost in production");
    if (!env.metricsUrlConfigured) problems.push("METRICS_SERVICE_URL is required in production");
    else if (LOCALHOST.test(env.metricsUrl)) problems.push("METRICS_SERVICE_URL points at localhost in production");
    if (env.clientOrigins.length === 0) {
      warnings.push("CLIENT_ORIGIN is not set: cross-origin browser calls will be blocked. Even behind a Vercel rewrite the browser's Origin is still the Vercel domain on POST/PUT/DELETE, so CLIENT_ORIGIN must still list it");
    }
    if (env.allowModelFiles) warnings.push("ALLOW_MODEL_FILES=true: pickle/joblib uploads execute code on the metrics service. Prefer CSV-only on a public deployment");
    if (env.trustProxy === true) warnings.push("TRUST_PROXY=true trusts every hop in X-Forwarded-For, so clients can spoof their IP and dodge rate limits. Use the exact hop count (Render: 1)");
    if (!env.auditHmacKey) warnings.push("AUDIT_HMAC_KEY is not set: the audit hash chain is unkeyed, so someone with database write access can rewrite it consistently. Set a key and record /api/audit-log/verify's head externally");
  }
  if (env.auditHmacKey && env.auditHmacKey.length < 16) warnings.push("AUDIT_HMAC_KEY is shorter than 16 characters");

  if (problems.length) {
    throw new Error("Invalid configuration:\n - " + problems.join("\n - "));
  }
  warnings.forEach((w) => console.warn(`[config] ${w}`));
}

module.exports = env;
module.exports.validateEnv = validateEnv;
module.exports.PLACEHOLDER = PLACEHOLDER;
