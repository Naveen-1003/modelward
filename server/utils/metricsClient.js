const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const env = require("../config/env");

const HEALTH_TRY_TIMEOUT_MS = 5000;
const HEALTH_POLL_GAP_MS = 2000;
const RETRY_GAP_MS = 1000;
// A successful call proves the (Render free-tier) service is awake; it sleeps
// after ~15 min idle, so skip the /health wake-up dance for a couple of minutes.
const AWAKE_FOR_MS = 2 * 60 * 1000;
let lastOkAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors carry a user-presentable message (never raw axios text, URLs, stacks or
// the shared secret) and `.retryable`: true when trying again later could work
// (service down/asleep/overloaded/misconfigured), false when the upload itself
// is what has to change.
function failure(message, retryable, transient = false) {
  const err = new Error(message);
  err.retryable = retryable;
  err.transient = transient; // worth one immediate automatic retry
  return err;
}

const authHeaders = () => (env.metricsSecret ? { "X-Metrics-Secret": env.metricsSecret } : {});

async function waitUntilAwake() {
  if (!(env.metricsWakeTimeoutMs > 0)) return;
  if (Date.now() - lastOkAt < AWAKE_FOR_MS) return;
  const deadline = Date.now() + env.metricsWakeTimeoutMs;
  for (;;) {
    try {
      const res = await axios.get(`${env.metricsUrl}/health`, {
        timeout: HEALTH_TRY_TIMEOUT_MS,
        validateStatus: () => true,
        // /health is public on the metrics service: never send the shared secret to it
      });
      if (res.status < 500) return; // a sleeping Render service answers 5xx from its proxy while booting
    } catch (_) {
      // not up yet
    }
    if (Date.now() + HEALTH_POLL_GAP_MS >= deadline) {
      throw failure("Metrics service is starting up, try again shortly", true);
    }
    await sleep(HEALTH_POLL_GAP_MS);
  }
}

const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Accuracy, rates and the like live in [0, 1]. A number outside that (or 1e999 -> Infinity) means
// the service is broken or fed garbage: reject it (non-retryable, the upload will not "heal"),
// never store it. Non-numbers / null stay null.
const OUT_OF_RANGE = "Metrics service returned out-of-range values";
function unit(v) {
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v) || v < 0 || v > 1) throw failure(OUT_OF_RANGE, false);
  return v;
}

function mapResponse(data) {
  const d = data && typeof data === "object" ? data : {};
  const accuracy = unit(d.accuracy);
  const fairnessGap = unit(d.fairness_gap);
  if (accuracy == null || fairnessGap == null) {
    throw failure("Metrics service returned an unexpected response, try again shortly", true);
  }
  return {
    accuracy,
    fairnessGap,
    latencyMs: numOrNull(d.latency_ms),
    rows: numOrNull(d.rows),
    demographicParityDiff: unit(d.demographic_parity_diff),
    equalOpportunityDiff: unit(d.equal_opportunity_diff),
    disparateImpactRatio: unit(d.disparate_impact_ratio),
    precision: unit(d.precision),
    recall: unit(d.recall),
    f1: unit(d.f1),
    auc: unit(d.auc),
    groups: Array.isArray(d.groups)
      ? d.groups.map((g) => ({
          group: String(g && g.group !== undefined && g.group !== null ? g.group : ""),
          count: numOrNull(g && g.count),
          accuracy: unit(g && g.accuracy),
          positiveRate: unit(g && g.positive_rate),
          tpr: unit(g && g.tpr),
        }))
      : [],
    warnings: Array.isArray(d.warnings) ? d.warnings.filter((w) => typeof w === "string").map((w) => w.slice(0, 500)) : [],
  };
}

// One HTTP attempt. Returns mapped metrics or throws a `failure()`.
async function attempt({ fileType, primaryFilePath, datasetFilePath }) {
  // Streams are single-use, so the form is rebuilt for every attempt.
  const form = new FormData();
  form.append("file_type", fileType);
  form.append("primary_file", fs.createReadStream(primaryFilePath));
  if (datasetFilePath) form.append("dataset_file", fs.createReadStream(datasetFilePath));

  let res;
  try {
    res = await axios.post(`${env.metricsUrl}/compute-metrics`, form, {
      headers: { ...form.getHeaders(), ...authHeaders() },
      timeout: env.metricsTimeoutMs,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
  } catch (err) {
    if (err && (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT")) {
      throw failure("Metrics service timed out, try again shortly", true);
    }
    throw failure("Metrics service is unreachable, try again shortly", true, true);
  }

  if (res.status >= 200 && res.status < 300) {
    lastOkAt = Date.now();
    return mapResponse(res.data);
  }
  const serviceMsg = res.data && typeof res.data.error === "string" ? res.data.error.slice(0, 500) : null;
  if (res.status === 400 || res.status === 413) {
    throw failure(serviceMsg || "The uploaded file could not be scored", false);
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    // 404 = wrong METRICS_SERVICE_URL / route: an operator problem, fixable without a new upload
    throw failure("Metrics service rejected the request (server misconfiguration), contact an administrator", true);
  }
  if (res.status === 408 || res.status === 425 || res.status === 429) {
    throw failure("Metrics service is busy, try again shortly", true);
  }
  if (res.status >= 500) throw failure("Metrics service had an internal error, try again shortly", true, true);
  throw failure("The metrics service rejected the upload", false);
}

// Forwards the uploaded file(s) to the FastAPI service and returns
// { accuracy, fairnessGap, latencyMs, rows, demographicParityDiff, equalOpportunityDiff,
//   disparateImpactRatio, precision, recall, f1, auc, groups[], warnings[] }
// (every optional metric is null when the service did not provide it).
// Throws Error with `.retryable`; the caller (routes/versions.js) turns that into an
// upload_failed version instead of a 500.
async function computeMetrics(args) {
  await waitUntilAwake();
  try {
    return await attempt(args);
  } catch (err) {
    if (!err.transient) throw err;
    // One automatic retry for network errors / 5xx (e.g. the instance was still booting).
    await sleep(RETRY_GAP_MS);
    return attempt(args);
  }
}

module.exports = computeMetrics;
module.exports.computeMetrics = computeMetrics;
module.exports._resetForTests = () => { lastOkAt = 0; };
