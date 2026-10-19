// Jest setupFiles: runs before any test module is loaded, so config/env.js sees these.
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test_secret_test_secret_test_secret_123456";
process.env.MONGO_URI = `mongodb://127.0.0.1:27017/${process.env.TEST_DB_NAME || "modelward_jest"}`;
process.env.STORAGE_MODE = "local";
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `modelward-test-uploads-${process.env.TEST_DB_NAME || "modelward_jest"}`);
process.env.ALLOW_MODEL_FILES = "true";
process.env.METRICS_SERVICE_URL = "http://127.0.0.1:59999"; // nothing listens here; tests mock metricsClient
process.env.METRICS_WAKE_TIMEOUT_MS = "0";
process.env.LOGIN_MAX_FAILURES = "5";
// Mail goes to email.outbox (never the network); links point at a fixed, local web app.
process.env.EMAIL_PROVIDER = "console";
process.env.APP_URL = "http://localhost:5173";
// Deterministic limits/identity: nothing from a developer's .env may change a test (dotenv never overrides a set value).
process.env.APPS_SCRIPT_URL = "";
process.env.APPS_SCRIPT_SECRET = "";
process.env.CLIENT_ORIGIN = "";
process.env.TRUST_PROXY = "";
process.env.SUPER_ADMIN_EMAIL = "";
process.env.SUPER_ADMIN_PASSWORD = "";
process.env.JOIN_CODE_MAX_FAILURES = "10";
process.env.RESEND_VERIFY_MAX = "5";
process.env.SIGNUP_MAX_PER_HOUR = "20";
process.env.LOGIN_ACCOUNT_MAX_FAILURES = "10";
process.env.AUDIT_HMAC_KEY = "";
