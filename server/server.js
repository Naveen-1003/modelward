require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const authRoutes = require("./routes/auth");
const modelRoutes = require("./routes/models");
const versionRoutes = require("./routes/versions");
const auditRoutes = require("./routes/audit");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, service: "modelward-server" }));

app.use("/api/auth", authRoutes);
app.use("/api/models", modelRoutes);
app.use("/api", versionRoutes); // versions.js defines full paths: /models/:id/versions, /versions/:id, ...
app.use("/api/audit-log", auditRoutes);

// Central error handler -- catches anything (e.g. Multer errors) that slipped
// past a route's own try/catch instead of crashing the process.
app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Unexpected server error", details: err.message });
});

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] ModelWard API listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("[server] Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });
