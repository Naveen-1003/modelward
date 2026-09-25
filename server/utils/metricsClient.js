const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

const METRICS_SERVICE_URL = process.env.METRICS_SERVICE_URL || "http://127.0.0.1:8000";

// Forwards the uploaded file(s) to the FastAPI microservice and returns
// { accuracy, fairnessGap, latencyMs } on success.
// Throws a normal Error with a short, human-readable message on failure --
// the caller (routes/versions.js) is responsible for catching it and marking
// the version as "upload_failed" instead of letting it crash the request.
async function computeMetrics({ fileType, primaryFilePath, datasetFilePath }) {
  const form = new FormData();
  form.append("file_type", fileType);
  form.append("primary_file", fs.createReadStream(primaryFilePath));
  if (datasetFilePath) {
    form.append("dataset_file", fs.createReadStream(datasetFilePath));
  }

  try {
    const response = await axios.post(`${METRICS_SERVICE_URL}/compute-metrics`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    const { accuracy, fairness_gap, latency_ms } = response.data;
    return {
      accuracy,
      fairnessGap: fairness_gap,
      latencyMs: latency_ms ?? null,
    };
  } catch (err) {
    if (err.response && err.response.data && err.response.data.error) {
      throw new Error(err.response.data.error);
    }
    if (err.code === "ECONNREFUSED") {
      throw new Error("Metrics microservice is unreachable -- is it running on " + METRICS_SERVICE_URL + "?");
    }
    throw new Error(err.message || "Metrics microservice request failed");
  }
}

module.exports = computeMetrics;
