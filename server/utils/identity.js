// Identity helpers shared by signup, Add user, org creation and the migration.
const crypto = require("crypto");

const emailDomain = (email) => {
  const s = String(email || "");
  const at = s.lastIndexOf("@");
  return at < 0 ? "" : s.slice(at + 1).toLowerCase();
};

// Uniqueness key for "one person, one account": lowercase, and any "+tag" in the
// local part removed ("Jo+hr@Acme.com" -> "jo@acme.com"). The domain is untouched.
function normalizeEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1) return s;
  const local = s.slice(0, at);
  const plus = local.indexOf("+");
  const base = plus > 0 ? local.slice(0, plus) : local;
  return `${base}@${s.slice(at + 1)}`;
}

// Free public mailbox providers: anyone can own an address there, so a domain rule that
// lists one would let the whole world in. Organizations without their own domain turn the
// domain rule OFF instead (verification + manual approval stay mandatory).
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "ymail.com", "outlook.com",
  "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com",
  "yandex.ru", "rediffmail.com", "inbox.com", "fastmail.com", "tutanota.com", "tuta.io",
]);

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// "  @Acme.com " -> "acme.com"; null when it is not a plausible hostname.
function normalizeDomain(input) {
  const d = String(input == null ? "" : input).trim().toLowerCase().replace(/^@+/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

// Exact comparison, never suffix matching: "acme.com.evil.com" and "mail.acme.com" do not
// match "acme.com". With the rule switched off every address passes this check.
function domainAllowed(org, email) {
  if (!org.domainRuleEnabled) return true;
  return (org.allowedDomains || []).includes(emailDomain(email));
}

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

// One-time secrets (verification and setup links): only the hash is stored.
function newToken() {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, hash: sha256(token) };
}
const hashToken = (token) => sha256(typeof token === "string" ? token : "");

module.exports = { emailDomain, normalizeEmail, normalizeDomain, domainAllowed, FREE_MAIL_DOMAINS, newToken, hashToken };
