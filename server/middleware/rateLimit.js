const net = require("net");
const { rateLimit, MemoryStore } = require("express-rate-limit");
const env = require("../config/env");

// Every limiter is built by a factory with its own MemoryStore so tests can build
// fresh ones (or call resetAll()). Single-instance deployment => in-memory is fine.
const stores = [];

// --- client key helpers ------------------------------------------------------

// Expand any IPv6 text form (compressed, zone id, embedded IPv4) to 8 numeric groups.
function ipv6Groups(ip) {
  let s = ip.toLowerCase().split("%")[0];
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    s = dotted[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
}

// One rate-limit bucket per client NETWORK, not per address: an IPv6 customer
// normally owns a whole /64, so keying on the full address would let one machine
// rotate through 2^64 addresses. IPv4-mapped IPv6 (::ffff:1.2.3.4, as Node reports
// dual-stack sockets) collapses to the plain IPv4 so both spellings share a bucket.
// (express-rate-limit v7 ships no ipKeyGenerator helper.)
function ipKey(ip) {
  if (!ip || typeof ip !== "string") return "unknown";
  const s = ip.trim();
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return s.toLowerCase().slice(0, 100);
  const g = ipv6Groups(s);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

// Normalized login identifier: trimmed, lowercased, capped. null if not a usable string.
function emailKey(email) {
  if (typeof email !== "string") return null;
  const s = email.trim().toLowerCase().slice(0, 254);
  return s || null;
}

const byIp = (req) => ipKey(req.ip);

// --- factories ----------------------------------------------------------------

function minutesLeft(req, windowMs) {
  const reset = req.rateLimit && req.rateLimit.resetTime ? req.rateLimit.resetTime.getTime() : Date.now() + windowMs;
  return Math.max(1, Math.ceil((reset - Date.now()) / 60000));
}

function makeLimiter({ windowMs, limit, label, skipSuccessfulRequests = false, keyGenerator = byIp }) {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({
    windowMs,
    limit,
    store,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler(req, res) {
      const mins = minutesLeft(req, windowMs);
      res.set("Retry-After", String(Math.max(1, Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000))));
      res.status(429).json({ error: `Too many ${label}. Try again in ${mins} minute${mins === 1 ? "" : "s"}` });
    },
  });
}

const loginWindowMs = (opts) => (opts.windowMinutes ?? env.loginWindowMinutes) * 60 * 1000;

// Only FAILED logins (status >= 400) count, per IP.
const createIpLoginLimiter = (opts = {}) =>
  makeLimiter({
    windowMs: loginWindowMs(opts),
    limit: opts.maxFailures ?? env.loginMaxFailures,
    label: "failed login attempts",
    skipSuccessfulRequests: true,
  });

// Failed logins per ACCOUNT (normalized email), so rotating IPs does not buy
// unlimited guesses against one account. Unknown emails are counted exactly like
// known ones, so a 429 reveals nothing about whether an account exists. Trade-off:
// someone can lock a victim's login for the window by failing on purpose.
const createAccountLoginLimiter = (opts = {}) =>
  makeLimiter({
    windowMs: loginWindowMs(opts),
    limit: opts.maxAccountFailures ?? env.loginAccountMaxFailures,
    label: "failed login attempts for this account",
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const e = emailKey(req.body && req.body.email);
      return e ? `acct:${e}` : `noacct:${byIp(req)}`; // malformed bodies fall back to the IP bucket
    },
  });

// Both limiters, as one middleware array (Express flattens it).
const createLoginLimiter = (opts = {}) => [createIpLoginLimiter(opts), createAccountLoginLimiter(opts)];

const createSignupLimiter = (opts = {}) =>
  makeLimiter({ windowMs: 60 * 60 * 1000, limit: opts.maxPerHour ?? env.signupMaxPerHour, label: "signup attempts" });

const createApiLimiter = (opts = {}) =>
  makeLimiter({ windowMs: 60 * 1000, limit: opts.maxPerMinute ?? env.apiMaxPerMinute, label: "requests" });

// Test hook: forget every counter.
function resetAll() {
  stores.forEach((s) => s.resetAll());
}

module.exports = {
  apiLimiter: createApiLimiter(),
  loginLimiter: createLoginLimiter(),
  signupLimiter: createSignupLimiter(),
  createLoginLimiter,
  createIpLoginLimiter,
  createAccountLoginLimiter,
  createSignupLimiter,
  createApiLimiter,
  resetAll,
  ipKey,
  emailKey,
};
