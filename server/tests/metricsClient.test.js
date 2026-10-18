// Real HTTP round-trips against a tiny fake metrics service (no mocking of axios).
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const env = require("../config/env");
const computeMetrics = require("../utils/metricsClient");

let server;
let calls;
let handler;
let tmpFile;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const FULL = {
  accuracy: 0.9, fairness_gap: 0.05, latency_ms: 4.2, rows: 120,
  demographic_parity_diff: 0.02, equal_opportunity_diff: 0.03, disparate_impact_ratio: 0.95,
  precision: 0.8, recall: 0.7, f1: 0.75, auc: 0.88,
  groups: [{ group: "A", count: 60, accuracy: 0.9, positive_rate: 0.4, tpr: 0.7 }, { group: 1, count: 60, accuracy: 0.85, positive_rate: null, tpr: null }],
  warnings: ["w1", 5],
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, secret: req.headers["x-metrics-secret"] });
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  tmpFile = path.join(os.tmpdir(), `mc-test-${Date.now()}.csv`);
  fs.writeFileSync(tmpFile, "predicted,actual,protected_attribute\n0,0,1\n");
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.unlinkSync(tmpFile);
});
beforeEach(() => {
  calls = [];
  computeMetrics._resetForTests();
  env.metricsUrl = `http://127.0.0.1:${server.address().port}`;
  env.metricsSecret = "";
  env.metricsWakeTimeoutMs = 0;
  env.metricsTimeoutMs = 5000;
  handler = (req, res) => json(res, 200, FULL);
});

const run = () => computeMetrics({ fileType: "csv", primaryFilePath: tmpFile, datasetFilePath: null });
const failure = async () => run().then(() => { throw new Error("expected failure"); }, (e) => e);

test("maps snake_case to camelCase, tolerating junk", async () => {
  const m = await run();
  expect(m).toEqual({
    accuracy: 0.9, fairnessGap: 0.05, latencyMs: 4.2, rows: 120,
    demographicParityDiff: 0.02, equalOpportunityDiff: 0.03, disparateImpactRatio: 0.95,
    precision: 0.8, recall: 0.7, f1: 0.75, auc: 0.88,
    groups: [
      { group: "A", count: 60, accuracy: 0.9, positiveRate: 0.4, tpr: 0.7 },
      { group: "1", count: 60, accuracy: 0.85, positiveRate: null, tpr: null },
    ],
    warnings: ["w1"],
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "POST", url: "/compute-metrics" });
});

test("an OLD service returning only 3 fields still works: every new metric is null / []", async () => {
  handler = (req, res) => json(res, 200, { accuracy: 0.8, fairness_gap: 0.1, latency_ms: null });
  expect(await run()).toEqual({
    accuracy: 0.8, fairnessGap: 0.1, latencyMs: null, rows: null,
    demographicParityDiff: null, equalOpportunityDiff: null, disparateImpactRatio: null,
    precision: null, recall: null, f1: null, auc: null, groups: [], warnings: [],
  });
});

test("sends X-Metrics-Secret only when configured", async () => {
  await run();
  expect(calls[0].secret).toBeUndefined();
  env.metricsSecret = "s3cret-value";
  await run();
  expect(calls[1].secret).toBe("s3cret-value");
});

test("400 / 413 are user-fixable: service message, not retryable, no retry", async () => {
  handler = (req, res) => json(res, 400, { error: "CSV is missing required column(s): actual" });
  const e = await failure();
  expect(e).toMatchObject({ message: "CSV is missing required column(s): actual", retryable: false });
  expect(calls).toHaveLength(1);
  handler = (req, res) => json(res, 413, { error: "File too large" });
  expect(await failure()).toMatchObject({ message: "File too large", retryable: false });
});

test("401 is retryable, generic, and never mentions the secret or the URL", async () => {
  env.metricsSecret = "s3cret-value";
  handler = (req, res) => json(res, 401, { error: "bad secret s3cret-value" });
  const e = await failure();
  expect(e.retryable).toBe(true);
  expect(e.message).not.toMatch(/s3cret|127\.0\.0\.1|http/);
});

test("5xx is retried once automatically, then reported as retryable", async () => {
  handler = (req, res) => json(res, 500, { error: "Traceback ... /srv/app/secret.py" });
  const e = await failure();
  expect(e).toMatchObject({ retryable: true, message: "Metrics service had an internal error, try again shortly" });
  expect(calls).toHaveLength(2);

  calls = [];
  let n = 0;
  handler = (req, res) => (++n === 1 ? json(res, 503, {}) : json(res, 200, FULL));
  expect((await run()).accuracy).toBe(0.9);
  expect(calls).toHaveLength(2);
});

test("network errors: one retry, retryable, no URL in the message", async () => {
  env.metricsUrl = "http://127.0.0.1:1"; // nothing listens on port 1
  const e = await failure();
  expect(e).toMatchObject({ retryable: true, message: "Metrics service is unreachable, try again shortly" });
});

test("timeouts are retryable and not retried", async () => {
  env.metricsTimeoutMs = 200;
  handler = (req, res) => setTimeout(() => json(res, 200, FULL), 1500);
  const e = await failure();
  expect(e).toMatchObject({ retryable: true, message: "Metrics service timed out, try again shortly" });
  expect(calls).toHaveLength(1);
});

test("a 200 without the core metrics is a retryable 'unexpected response'", async () => {
  handler = (req, res) => json(res, 200, { hello: "world" });
  expect(await failure()).toMatchObject({ retryable: true, message: expect.stringMatching(/unexpected response/) });
});

test("wake-up: polls /health until the service answers, then scores", async () => {
  env.metricsWakeTimeoutMs = 10000;
  let healthHits = 0;
  handler = (req, res) => {
    if (req.url === "/health") return ++healthHits < 2 ? json(res, 503, {}) : json(res, 200, { ok: true });
    return json(res, 200, FULL);
  };
  expect((await run()).accuracy).toBe(0.9);
  expect(calls.map((c) => c.url)).toEqual(["/health", "/health", "/compute-metrics"]);
  // a successful call proves the service is awake: no /health ping next time
  calls = [];
  await run();
  expect(calls.map((c) => c.url)).toEqual(["/compute-metrics"]);
});

test("wake-up budget exhausted: retryable 'starting up' error, no scoring attempted", async () => {
  env.metricsWakeTimeoutMs = 1000;
  handler = (req, res) => json(res, 503, {});
  const e = await failure();
  expect(e).toMatchObject({ retryable: true, message: "Metrics service is starting up, try again shortly" });
  expect(calls.every((c) => c.url === "/health")).toBe(true);
});
