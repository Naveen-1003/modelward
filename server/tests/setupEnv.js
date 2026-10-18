// Jest setupFiles: runs before any test module is loaded, so config/env.js sees these.
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test_secret_test_secret_test_secret_123456";
process.env.MONGO_URI = `mongodb://127.0.0.1:27017/${process.env.TEST_DB_NAME || "modelward_jest"}`;
process.env.STORAGE_MODE = "local";
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `modelward-test-uploads-${process.env.TEST_DB_NAME || "modelward_jest"}`);
process.env.ALLOW_MODEL_FILES = "true";
process.env.ADMIN_INVITE_CODE = "test-admin-code";
process.env.COMPLIANCE_INVITE_CODE = "test-compliance-code";
process.env.METRICS_SERVICE_URL = "http://127.0.0.1:59999"; // nothing listens here; tests mock metricsClient
process.env.METRICS_WAKE_TIMEOUT_MS = "0";
process.env.LOGIN_MAX_FAILURES = "5";
