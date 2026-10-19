// Red-team (reviewer R2): the e-mail relay client against a hostile / broken relay, secret hygiene,
// link building, and client-IP handling behind a proxy.
const http = require("http");
const express = require("express");
const request = require("supertest");
const env = require("../config/env");
const email = require("../utils/email");
const rateLimit = require("../middleware/rateLimit");

const SECRET = "relay-secret-0123456789abcdef";
const saved = {};
const setEnv = (patch) => {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in saved)) saved[k] = env[k];
    env[k] = v;
  }
};
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  for (const k of Object.keys(saved)) env[k] = saved[k];
  email.clearOutbox();
});
const mail = { to: "ada@acme.com", subject: "Hi", html: "<p>x</p>", text: "x" };

// A real local web server standing in for the Apps Script relay.
function relayServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body: data, headers: req.headers });
        handler(req, res, data, seen);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const close = (s) => new Promise((r) => s.server.close(r) || s.server.closeAllConnections?.());
const useRelay = (url) => setEnv({ emailProvider: "apps_script", appsScriptUrl: url, appsScriptSecret: SECRET });

// Everything printed anywhere while env.nodeEnv is NOT "test" (so the module's own logging is live).
function spyConsole() {
  setEnv({ nodeEnv: "development" });
  return ["log", "warn", "error", "info", "debug"].map((k) => jest.spyOn(console, k).mockImplementation(() => {}));
}
const printed = (spies) => JSON.stringify(spies.map((s) => s.mock.calls));

describe("relay protocol (real HTTP server)", () => {
  test("Apps Script style: POST -> 302 -> GET of the result URL -> JSON ok:true; the POST body is exactly {secret,to,subject,html,name}", async () => {
    const s = await relayServer((req, res, body, seen) => {
      if (req.method === "POST") {
        res.writeHead(302, { Location: `${s.url}/echoed/result` });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      useRelay(`${s.url}/exec`);
      const r = await email.sendMail(mail);
      expect(r).toEqual({ ok: true });
      const post = s.seen.find((x) => x.method === "POST");
      expect(Object.keys(JSON.parse(post.body)).sort()).toEqual(["html", "name", "secret", "subject", "to"]);
      expect(JSON.parse(post.body).secret).toBe(SECRET);
      // the redirect hop must be a body-less GET: the secret is sent exactly once, in the first request
      const get = s.seen.find((x) => x.method === "GET");
      expect(get.body).toBe("");
      expect(JSON.stringify(get.headers)).not.toContain(SECRET);
      expect(get.url).not.toContain(SECRET);
      expect(post.url).not.toContain(SECRET);
    } finally {
      await close(s);
    }
  });

  test.each([
    ["ok:false (daily limit)", (res) => res.end(JSON.stringify({ ok: false, error: "Service invoked too many times for one day: email." }))],
    ["ok as the string 'true'", (res) => res.end(JSON.stringify({ ok: "true" }))],
    ["ok:1", (res) => res.end(JSON.stringify({ ok: 1 }))],
    ["empty body", (res) => res.end("")],
    ["HTML login page", (res) => res.end("<html><title>Sign in - Google Accounts</title></html>")],
    ["JSON array", (res) => res.end("[true]")],
    ["JSON null", (res) => res.end("null")],
    ["huge garbage", (res) => res.end("x".repeat(2e6))],
  ])("200 answer: %s -> {ok:false}, never throws, nothing printed", async (_name, answer) => {
    const s = await relayServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      answer(res);
    });
    try {
      useRelay(`${s.url}/exec`);
      const spies = spyConsole();
      const r = await email.sendMail(mail);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe("string");
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(JSON.stringify(r)).not.toContain(s.url);
      expect(printed(spies)).not.toContain(SECRET);
      expect(printed(spies)).not.toContain(s.url);
      expect(printed(spies)).not.toContain("127.0.0.1");
    } finally {
      await close(s);
    }
  });

  test.each([[401], [403], [404], [429], [500], [502], [503]])("HTTP %i -> {ok:false} with only the status in the message", async (code) => {
    const s = await relayServer((req, res) => {
      res.writeHead(code, { "Content-Type": "text/plain" });
      res.end(`secret echo ${SECRET}`);
    });
    try {
      useRelay(`${s.url}/exec`);
      const spies = spyConsole();
      const r = await email.sendMail(mail);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(printed(spies)).not.toContain(SECRET);
    } finally {
      await close(s);
    }
  });

  test("a redirect LOOP ends (fetch gives up after its hop limit) as {ok:false}, without leaking the URL or the secret", async () => {
    const s = await relayServer((req, res) => {
      res.writeHead(302, { Location: `${s.url}/exec?again=${Math.random()}` });
      res.end();
    });
    try {
      useRelay(`${s.url}/exec`);
      const spies = spyConsole();
      const r = await email.sendMail(mail);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/127\.0\.0\.1|relay-secret/);
      expect(printed(spies)).not.toMatch(/127\.0\.0\.1|relay-secret/);
      // the body (with the secret) was only POSTed once; the hops were body-less GETs
      expect(s.seen.filter((x) => x.method === "POST")).toHaveLength(1);
      expect(s.seen.filter((x) => x.method !== "POST").every((x) => x.body === "")).toBe(true);
    } finally {
      await close(s);
    }
  }, 30000);

  test("relay that accepts the connection and never answers: aborted by the 10 s timer; a relay that stalls after the headers too", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    useRelay("https://relay.example/exec");
    // 1) never answers; honours the abort signal like real fetch
    jest.spyOn(global, "fetch").mockImplementation((url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted https://relay.example/exec"), { name: "AbortError" })))));
    let p = email.sendMail(mail);
    await jest.advanceTimersByTimeAsync(10001);
    let r = await p;
    expect(r).toEqual({ ok: false, error: "Email service timed out" });
    // 2) headers arrive, the body never does
    global.fetch.mockImplementation(async (url, { signal }) => ({
      ok: true,
      status: 200,
      body: null,
      text: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    }));
    p = email.sendMail(mail);
    await jest.advanceTimersByTimeAsync(10001);
    r = await p;
    expect(r).toEqual({ ok: false, error: "Email service timed out" });
  });

  test("connection refused / DNS failure: generic message, no host, no secret, nothing thrown", async () => {
    useRelay("http://127.0.0.1:9/exec");
    const spies = spyConsole();
    const r = await email.sendMail(mail);
    expect(r).toEqual({ ok: false, error: "Could not reach the email service" });
    expect(printed(spies)).not.toMatch(/127\.0\.0\.1|relay-secret/);
  });

  test("not configured: refuses without touching the network", async () => {
    setEnv({ emailProvider: "apps_script", appsScriptUrl: "", appsScriptSecret: "" });
    const f = jest.spyOn(global, "fetch");
    expect(await email.sendMail(mail)).toEqual({ ok: false, error: "Email delivery is not configured" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("recipient, subject and body hygiene", () => {
  test.each([
    "a@b.com,c@d.com",
    "a@b.com;c@d.com",
    "a@b.com c@d.com",
    "a@b.com\r\nBcc: c@d.com",
    "<a@b.com>",
    "A <a@b.com>",
    '"a"@b.com',
    "a@b",
    "",
    null,
    ["a@b.com"],
    { toString: () => "a@b.com" },
    `${"x".repeat(250)}@b.com`,
  ])("recipient %j is refused before any network call", async (to) => {
    useRelay("https://relay.example/exec");
    const f = jest.spyOn(global, "fetch");
    const r = await email.sendMail({ ...mail, to });
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  test("CR/LF are stripped from the subject; an empty subject is refused", async () => {
    await email.sendMail({ ...mail, subject: "Hello\r\nBcc: evil@x.com\u0000" });
    expect(email.outbox[0].subject).not.toMatch(/[\r\n\u0000]/);
    expect((await email.sendMail({ ...mail, subject: " \r\n " })).ok).toBe(false);
  });

  test("production console provider keeps neither the body nor the one-time links anywhere", async () => {
    setEnv({ isProd: true, nodeEnv: "production", emailProvider: "console" });
    const spies = spyConsole();
    setEnv({ nodeEnv: "production" });
    const r = await email.sendMail({ ...mail, text: "link https://app/verify-email?token=abc123" });
    expect(r.ok).toBe(true);
    expect(email.outbox).toHaveLength(0);
    expect(printed(spies)).not.toContain("abc123");
  });

  test("appUrl: built only from APP_URL; params are encoded; a path that tries to escape stays on the host", () => {
    setEnv({ appUrl: "https://app.example.com" });
    expect(email.appUrl("/verify-email", { token: "a b&c=d#e" })).toBe("https://app.example.com/verify-email?token=a+b%26c%3Dd%23e");
    expect(new URL(email.appUrl("//evil.example/x")).hostname).toBe("app.example.com");
    expect(new URL(email.appUrl("@evil.example/x")).hostname).toBe("app.example.com");
    expect(email.appUrl("/p", { a: null, b: undefined })).toBe("https://app.example.com/p");
  });
});

describe("client IP behind a proxy (rate-limit keys)", () => {
  function appWith(trustProxy) {
    const a = express();
    if (trustProxy !== false) a.set("trust proxy", trustProxy);
    a.use(express.json());
    a.post("/x", rateLimit.createJoinCodeLimiter({ maxFailures: 3 }), (req, res) => res.status(403).json({ ip: req.ip }));
    return a;
  }

  test("trust proxy OFF: X-Forwarded-For is ignored entirely", async () => {
    const a = appWith(false);
    const out = [];
    for (let i = 0; i < 5; i += 1) out.push((await request(a).post("/x").set("X-Forwarded-For", `7.7.7.${i}`).send({})).status);
    expect(out).toEqual([403, 403, 403, 429, 429]);
  });

  test("trust proxy = 1 hop: only the entry the trusted proxy appended counts; prepending fake hops buys nothing", async () => {
    const a = appWith(1);
    const out = [];
    for (let i = 0; i < 5; i += 1) out.push((await request(a).post("/x").set("X-Forwarded-For", `${i}.${i}.${i}.${i}, 9.9.9.9`).send({})).status);
    expect(out).toEqual([403, 403, 403, 429, 429]);
    const ip = await request(appWith(1)).post("/x").set("X-Forwarded-For", "1.1.1.1, 9.9.9.9").send({});
    expect(ip.body.ip).toBe("9.9.9.9");
  });

  test("an IPv6 client rotating inside its /64 stays in one bucket", async () => {
    const a = express();
    a.set("trust proxy", 1);
    a.use(express.json());
    a.post("/x", rateLimit.createJoinCodeLimiter({ maxFailures: 3 }), (req, res) => res.status(403).json({}));
    const out = [];
    for (let i = 0; i < 5; i += 1) out.push((await request(a).post("/x").set("X-Forwarded-For", `2001:db8:abcd:12:${i}:${i}:${i}:${i}`).send({})).status);
    expect(out).toEqual([403, 403, 403, 429, 429]);
  });
});

describe("production configuration warnings that protect links and limiters", () => {
  const GOOD = {
    NODE_ENV: "production", JWT_SECRET: "k7Jq2mZp9XvL4sWn8RtY1uBe5CdFg3HaQ6", METRICS_SHARED_SECRET: "m", METRICS_SERVICE_URL: "https://metrics.example.com",
    MONGO_URI: "mongodb+srv://u:p@cluster.example.net/db", CLIENT_ORIGIN: "https://app.example.com", EMAIL_PROVIDER: "apps_script",
    APPS_SCRIPT_URL: "https://script.google.com/macros/s/x/exec", APPS_SCRIPT_SECRET: "s", SUPER_ADMIN_EMAIL: "root@example.com", TRUST_PROXY: "1", APP_URL: "https://app.example.com",
  };
  function warnings(vars) {
    const keys = Object.keys({ ...GOOD, ...vars });
    const saved = {};
    keys.forEach((k) => { saved[k] = process.env[k]; });
    Object.assign(process.env, GOOD, vars);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let fresh;
      jest.isolateModules(() => { fresh = require("../config/env"); });
      fresh.validateEnv();
    } finally {
      keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    }
    return warn.mock.calls.map((c) => String(c[0])).join("\n");
  }
  test("a clean production config has neither warning; http APP_URL and a missing TRUST_PROXY are called out", () => {
    const clean = warnings({});
    expect(clean).not.toMatch(/APP_URL is not https|TRUST_PROXY is not set/);
    expect(warnings({ APP_URL: "http://app.example.com" })).toMatch(/APP_URL is not https/);
    expect(warnings({ TRUST_PROXY: "" })).toMatch(/TRUST_PROXY is not set/);
  });
  test("APP_URL can never carry a path, credentials or a non-http scheme (so links cannot be redirected through it)", () => {
    for (const bad of ["https://user:pw@app.example.com", "https://app.example.com/evil?x=1", "javascript:alert(1)", "ftp://app.example.com", "//evil.example"]) {
      const saved = process.env.APP_URL;
      process.env.APP_URL = bad;
      let fresh;
      jest.isolateModules(() => { fresh = require("../config/env"); });
      process.env.APP_URL = saved;
      expect(() => fresh.validateEnv()).toThrow(/APP_URL/);
    }
  });
});
