const mongoose = require("mongoose");

// The registered AI model being governed (not to be confused with a Mongoose "model").
// Deliberately has NO riskTier field -- risk is a property of a measured Version,
// never a claim made by the uploader at registration time.
const modelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: "" },
  useCase: { type: String, default: "" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model("Model", modelSchema);
