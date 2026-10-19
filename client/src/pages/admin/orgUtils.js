// Small helpers shared by the organization screens (mirror server/routes/orgs.js + utils/identity.js).
import { extractFields } from "../../api/axios.js";

export const MAX_DOMAINS = 20;
// Same pattern as the server's normalizeDomain().
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// "Acme.com, @beta.org\nacme.com" -> { domains: ["acme.com","beta.org"], invalid: [...] }
// (comma, semicolon, space or newline separated; lowercase, no leading '@', de-duplicated).
export function parseDomains(text) {
  const domains = [];
  const invalid = [];
  for (const raw of String(text || "").split(/[\s,;]+/)) {
    const d = raw.trim().toLowerCase().replace(/^@+/, "");
    if (!d) continue;
    if (DOMAIN_RE.test(d)) {
      if (!domains.includes(d)) domains.push(d);
    } else if (!invalid.includes(d)) {
      invalid.push(d);
    }
  }
  return { domains, invalid };
}

// Server field errors keyed by the top-level field ("allowedDomains.0" -> "allowedDomains").
export function serverFields(err) {
  const out = {};
  for (const [key, msg] of Object.entries(extractFields(err))) {
    const top = key.split(".")[0];
    if (typeof msg === "string" && !out[top]) out[top] = msg;
  }
  return out;
}

export const errorCode = (err) => err?.response?.data?.code || "";
