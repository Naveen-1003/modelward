// Demo data for local development: one organization and a handful of active users.
// Usage: npm run seed:demo        (refuses to run against a production database)
require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const Organization = require("../models/Organization");
const User = require("../models/User");
const { newCodes } = require("../utils/joinCodes");
const { normalizeEmail } = require("../utils/identity");

const ORG = "Demo Organization";
const PASSWORD = process.env.DEMO_PASSWORD || "Demo@12345";
const USERS = [
  ["Demo Admin", "admin@demo.test", "admin"],
  ["Asha ML Engineer", "asha.ml@demo.test", "ml_engineer"],
  ["Ben ML Engineer", "ben.ml@demo.test", "ml_engineer"],
  ["Chitra Compliance", "chitra.compliance@demo.test", "compliance_officer"],
  ["Dev Compliance", "dev.compliance@demo.test", "compliance_officer"],
];

(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data with NODE_ENV=production");
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`[seed] database: ${mongoose.connection.host}/${mongoose.connection.name}`);
  const org =
    (await Organization.findOne({ name: ORG })) ||
    (await Organization.create({ name: ORG, contactEmail: "admin@demo.test", domainRuleEnabled: false, autoApprove: false, codes: newCodes() }));
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  // Written at collection level with an explicit orgId: this script is not part of the request path,
  // so it stays outside the tenant context helpers.
  for (const [name, email, role] of USERS) {
    if (await User.collection.findOne({ email })) { console.log(`[seed] exists   ${email}`); continue; }
    await User.collection.insertOne({
      name, email, emailKey: normalizeEmail(email), passwordHash, role, orgId: org._id,
      status: "active", isActive: true, createdAt: new Date(), __v: 0,
    });
    console.log(`[seed] created  ${email} (${role})`);
  }
  console.log(`[seed] done. Password for all: ${PASSWORD}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
