// Shared fixtures for the models / versions / softdelete tests (not a test file itself).
const request = require("supertest");
const app = require("../app");
const { auth } = require("./helpers");

const metrics = (over = {}) => ({
  accuracy: 0.95,
  fairnessGap: 0.02,
  latencyMs: null,
  rows: 200,
  demographicParityDiff: null,
  equalOpportunityDiff: null,
  disparateImpactRatio: null,
  precision: null,
  recall: null,
  f1: null,
  auc: null,
  groups: [{ group: "0", count: 100, accuracy: 0.95, positiveRate: 0.5, tpr: 0.9 }],
  warnings: [],
  ...over,
});
const GOOD = metrics(); // low tier
const MEDIUM = metrics({ accuracy: 0.78, fairnessGap: 0.15 });
const BAD = metrics({ accuracy: 0.455, fairnessGap: 0.3 }); // high tier

const CSV = Buffer.from("predicted,actual,protected_attribute\n0,0,1\n1,1,0\n");

let n = 0;
const uniqueName = (prefix = "Model") => `${prefix} ${Date.now()}-${++n}`;

async function createModel(token, name = uniqueName(), extra = {}) {
  const res = await auth(request(app).post("/api/models"), token).send({ name, ...extra });
  if (res.status !== 201) throw new Error(`createModel failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.model;
}

// Uploads a csv version (mocked scoring decides the outcome).
function uploadCsv(token, modelId, { latencyMs = "12", fields = {}, filename = "preds.csv", buffer = CSV } = {}) {
  let req = auth(request(app).post(`/api/models/${modelId}/versions`), token).field("fileType", "csv");
  if (latencyMs !== null) req = req.field("latencyMs", latencyMs);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach("file", buffer, filename);
}

async function newVersion(token, modelId, opts) {
  const res = await uploadCsv(token, modelId, opts);
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.version;
}

const post = (token, url, body) => auth(request(app).post(url), token).send(body || {});
const get = (token, url) => auth(request(app).get(url), token);

// draft -> submitted -> approved (-> deployed)
async function approve(engineer, officer, versionId, comment = "ok") {
  await post(engineer, `/api/versions/${versionId}/submit`).expect(200);
  await post(officer, `/api/versions/${versionId}/review`, { decision: "approve", comment }).expect(200);
}
async function deploy(engineer, officer, versionId) {
  await approve(engineer, officer, versionId);
  const res = await post(officer, `/api/versions/${versionId}/deploy`);
  if (res.status !== 200) throw new Error(`deploy failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.version;
}

module.exports = { metrics, GOOD, MEDIUM, BAD, CSV, uniqueName, createModel, uploadCsv, newVersion, post, get, approve, deploy };
