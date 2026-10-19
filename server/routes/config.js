const express = require("express");
const env = require("../config/env");

const router = express.Router();

// Public, no secrets: lets the client adapt its UI to the deployment.
router.get("/", (req, res) => {
  res.json({
    allowModelFiles: env.allowModelFiles,
    maxUploadMb: env.maxUploadMb,
    enableDriftSimulation: env.enableDriftSimulation,
    storageMode: env.storageMode,
    minPasswordLength: env.minPasswordLength,
    signupEnabled: env.signupEnabled,
  });
});

module.exports = router;
