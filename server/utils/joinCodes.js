// Join codes: two per organization (ML engineer / compliance officer). The code, never the
// signing-up user, decides the role. Admin is not obtainable through a code.
const crypto = require("crypto");
const Organization = require("../models/Organization");

const KINDS = ["ml_engineer", "compliance_officer"];
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_LENGTH = 12; // 32^12 = 60 bits

function generateCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

// What the user typed -> canonical form, or null if it cannot be a code ("abcd-efgh-jklm" ok).
function normalizeCode(raw) {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, "");
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

// "ABCDEFGHJKLM" -> "ABCD-EFGH-JKLM" (display only)
const formatCode = (value) => String(value || "").replace(/(.{4})(?=.)/g, "$1-");

// A fresh code entry. Regenerating bumps `gen` and resets the seat count and limits.
function newCodeEntry(previous) {
  return { value: generateCode(), expiresAt: null, seatLimit: null, used: 0, gen: ((previous && previous.gen) || 0) + 1 };
}

const newCodes = () => ({ ml_engineer: newCodeEntry(), compliance_officer: newCodeEntry() });

// Finds the org owning a code and which role it grants. null for anything unknown.
async function findOrgByCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  const org = await Organization.findOne({
    $or: [{ "codes.ml_engineer.value": code }, { "codes.compliance_officer.value": code }],
  });
  if (!org) return null;
  const kind = KINDS.find((k) => org.codes[k] && org.codes[k].value === code);
  return kind ? { org, kind } : null;
}

// null when usable, else why not: "suspended" | "expired" | "full".
function codeProblem(org, kind, now = new Date()) {
  if (org.status !== "active") return "suspended";
  const c = org.codes[kind];
  if (c.expiresAt && c.expiresAt <= now) return "expired";
  if (c.seatLimit != null && c.used >= c.seatLimit) return "full";
  return null;
}

// Atomically takes one seat, re-checking everything (same code, active org, not expired,
// not full) in the update's own filter so two simultaneous signups cannot both take the
// last seat. Returns the updated org, or null if the code stopped being usable.
async function reserveSeat(org, kind) {
  const p = `codes.${kind}`;
  const now = new Date();
  return Organization.findOneAndUpdate(
    {
      _id: org._id,
      status: "active",
      [`${p}.value`]: org.codes[kind].value,
      $and: [
        { $or: [{ [`${p}.expiresAt`]: null }, { [`${p}.expiresAt`]: { $gt: now } }] },
        { $or: [{ [`${p}.seatLimit`]: null }, { $expr: { $lt: [`$${p}.used`, `$${p}.seatLimit`] } }] },
      ],
    },
    { $inc: { [`${p}.used`]: 1 } },
    { new: true }
  );
}

// Gives a seat back (signup failed, account rejected, unverified account expired).
// `gen` pins it to the code it was taken from: after a regenerate it is a no-op.
async function releaseSeat(orgId, kind, gen) {
  if (!KINDS.includes(kind) || gen == null) return;
  const p = `codes.${kind}`;
  await Organization.updateOne({ _id: orgId, [`${p}.gen`]: gen, [`${p}.used`]: { $gt: 0 } }, { $inc: { [`${p}.used`]: -1 } });
}

module.exports = { KINDS, generateCode, normalizeCode, formatCode, newCodeEntry, newCodes, findOrgByCode, codeProblem, reserveSeat, releaseSeat };
