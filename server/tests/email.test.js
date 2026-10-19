const http = require("http");

let env, email, templates;
const SECRET = "relay-secret-0123456789abcdef";

// Mimics a Google Apps Script web app: the POST answers 302 to a one-off result URL on another
// path, which is then fetched with GET and returns the JSON.
let server, baseUrl, mode, seen;
function startRelay() {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url.startsWith("/exec")) {
        seen.push({ method: req.method, url: req.url, body, contentType: req.headers["content-type"], custom: req.headers["x-secret"] });
        res.writeHead(302, { Location: "/echo/result?id=1" });
        return res.end("Moved");
      }
      seen.push({ method: req.method, url: req.url, body });
      if (mode === "hang") return; // never answers
      if (mode === "http500") { res.writeHead(500, { "Content-Type": "text/plain" }); return res.end("boom"); }
      if (mode === "html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>Sign in to Google</html>"); }
      if (mode === "notok") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Unauthorized " + SECRET })); }
      if (mode === "okstring") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: "true" })); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }));
}

const mail = { to: "ann@acme.com", subject: "Hello", html: "<p>Hi</p>", text: "Hi" };

beforeAll(async () => {
  env = require("../config/env");
  email = require("../utils/email");
  templates = require("../utils/emailTemplates");
  await startRelay();
});
afterAll(async () => {
  await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
});

const saved = {};
beforeEach(() => {
  ["emailProvider", "appsScriptUrl", "appsScriptSecret", "emailFromName", "isProd", "nodeEnv", "appUrl"].forEach((k) => { saved[k] = env[k]; });
  email.clearOutbox();
  seen = [];
  mode = "ok";
});
afterEach(() => {
  Object.assign(env, saved);
  jest.restoreAllMocks();
});

describe("console provider", () => {
  beforeEach(() => { env.emailProvider = "console"; });

  test("records the mail in the outbox without printing in tests", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const r = await email.sendMail(mail);
    expect(r).toEqual({ ok: true });
    expect(email.outbox).toHaveLength(1);
    expect(email.outbox[0]).toMatchObject({ to: "ann@acme.com", subject: "Hello", html: "<p>Hi</p>", text: "Hi" });
    expect(email.outbox[0].at).toBeInstanceOf(Date);
    expect(log).not.toHaveBeenCalled();
    email.clearOutbox();
    expect(email.outbox).toHaveLength(0);
  });

  test("outside tests it prints one readable block including the links", async () => {
    env.nodeEnv = "development";
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    await email.sendMail({ ...mail, text: "Open https://app.example.com/verify-email?token=abc123 now" });
    expect(log).toHaveBeenCalledTimes(1);
    const out = log.mock.calls[0][0];
    expect(out).toContain("ann@acme.com");
    expect(out).toContain("Hello");
    expect(out).toContain("https://app.example.com/verify-email?token=abc123");
  });

  test("production: nothing is recorded and the body (one-time links) is not printed", async () => {
    env.isProd = true;
    env.nodeEnv = "production";
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const r = await email.sendMail({ ...mail, text: "https://x.test/setup?token=SECRETTOKEN" });
    expect(r.ok).toBe(true);
    expect(email.outbox).toHaveLength(0);
    expect(log.mock.calls.join(" ")).not.toContain("SECRETTOKEN");
  });

  test("the outbox is capped at 200 (oldest dropped)", async () => {
    for (let i = 0; i < 205; i += 1) await email.sendMail({ ...mail, subject: `s${i}` });
    expect(email.outbox).toHaveLength(200);
    expect(email.outbox[0].subject).toBe("s5");
    expect(email.outbox[199].subject).toBe("s204");
  });

  test("text is derived from html and html from text when one is missing", async () => {
    await email.sendMail({ to: "a@b.co", subject: "x", html: '<p>Go <a href="https://a.test/x?y=1&amp;z=2">here</a></p>' });
    expect(email.outbox[0].text).toContain("https://a.test/x?y=1&z=2");
    await email.sendMail({ to: "a@b.co", subject: "x", text: "a < b" });
    expect(email.outbox[1].html).toContain("a &lt; b");
  });

  test("rejects bad recipients and subjects without throwing; strips CR/LF from the subject", async () => {
    for (const to of ["", "nope", "a@b.co, c@d.co", "a@b.co\r\nBcc: x@y.zz", undefined, null, 5, "a b@c.de"]) {
      const r = await email.sendMail({ ...mail, to });
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe("string");
    }
    expect((await email.sendMail({ ...mail, subject: "" })).ok).toBe(false);
    expect((await email.sendMail()).ok).toBe(false);
    await email.sendMail({ ...mail, subject: "Line1\r\nBcc: evil@x.com" });
    expect(email.outbox[0].subject).not.toMatch(/[\r\n]/);
  });

  test("emailEnabled is false for console", () => {
    expect(email.emailEnabled()).toBe(false);
  });
});

describe("apps_script provider", () => {
  beforeEach(() => {
    env.emailProvider = "apps_script";
    env.appsScriptUrl = `${baseUrl}/exec`;
    env.appsScriptSecret = SECRET;
    env.emailFromName = "ModelWard Test";
  });

  test("emailEnabled is true", () => {
    expect(email.emailEnabled()).toBe(true);
  });

  test("success: POSTs JSON with the secret in the body, follows the 302 with a GET", async () => {
    const r = await email.sendMail(mail);
    expect(r).toEqual({ ok: true });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].contentType).toMatch(/application\/json/);
    expect(seen[0].custom).toBeUndefined();
    expect(JSON.parse(seen[0].body)).toEqual({ secret: SECRET, to: "ann@acme.com", subject: "Hello", html: "<p>Hi</p>", name: "ModelWard Test" });
    expect(seen[1].method).toBe("GET");
    expect(seen[1].url).toBe("/echo/result?id=1");
    expect(email.outbox).toHaveLength(0); // real provider: no outbox
  });

  test.each([
    ["non-2xx", "http500", /HTTP 500/],
    ["non-JSON answer", "html", /unexpected response/],
    ["ok: false", "notok", /rejected/],
    ["ok that is not boolean true", "okstring", /rejected/],
  ])("%s -> {ok:false, error} with no secret or URL", async (_name, m, pattern) => {
    mode = m;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const r = await email.sendMail(mail);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(pattern);
    const blob = JSON.stringify(r) + warn.mock.calls.join(" ");
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain(baseUrl);
    expect(blob).not.toContain("127.0.0.1");
  });

  test("timeout aborts the request and reports a short error", async () => {
    mode = "hang";
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, "setTimeout").mockImplementation((fn, ms, ...a) => realSetTimeout(fn, ms === 10000 ? 150 : ms, ...a));
    const r = await email.sendMail(mail);
    expect(r).toEqual({ ok: false, error: "Email service timed out" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test("uses a 10 second timeout", async () => {
    const spy = jest.spyOn(global, "setTimeout");
    await email.sendMail(mail);
    expect(spy.mock.calls.some((c) => c[1] === 10000)).toBe(true);
  });

  test("connection refused -> generic error, no URL or secret", async () => {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    env.appsScriptUrl = `http://127.0.0.1:${port}/exec`;
    const r = await email.sendMail(mail);
    expect(r).toEqual({ ok: false, error: "Could not reach the email service" });
  });

  test("an invalid URL or a missing url/secret fails cleanly instead of throwing", async () => {
    env.appsScriptUrl = "not a url";
    expect((await email.sendMail(mail)).ok).toBe(false);
    env.appsScriptUrl = "";
    expect(await email.sendMail(mail)).toEqual({ ok: false, error: "Email delivery is not configured" });
    env.appsScriptUrl = `${baseUrl}/exec`;
    env.appsScriptSecret = "";
    expect((await email.sendMail(mail)).ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("never throws, even with hostile input", async () => {
    await expect(email.sendMail({ to: { toString() { throw new Error("x"); } }, subject: "s" })).resolves.toMatchObject({ ok: false });
    await expect(email.sendMail({ to: mail.to, subject: "s", html: { toString() { throw new Error("boom"); } } })).resolves.toMatchObject({ ok: false });
  });
});

describe("helpers", () => {
  test("extractLinks finds urls and drops trailing punctuation", () => {
    const t = "Open https://a.test/verify-email?token=abc123. Or (http://b.test/x?y=1&z=2), thanks!";
    expect(email.extractLinks(t)).toEqual(["https://a.test/verify-email?token=abc123", "http://b.test/x?y=1&z=2"]);
    expect(email.extractLinks("no links here")).toEqual([]);
    expect(email.extractLinks(null)).toEqual([]);
  });

  test("appUrl builds absolute links from APP_URL", () => {
    env.appUrl = "https://app.example.com";
    expect(email.appUrl("/verify-email")).toBe("https://app.example.com/verify-email");
    expect(email.appUrl("login")).toBe("https://app.example.com/login");
    expect(email.appUrl()).toBe("https://app.example.com/");
    expect(email.appUrl("/setup-password", { token: "a b&c", skip: null })).toBe("https://app.example.com/setup-password?token=a+b%26c");
  });
});

describe("templates", () => {
  const link = "https://app.example.com/verify-email?token=abc&x=1";
  const evil = { name: '<script>alert("x")</script>', orgName: `Acme "&" <b>Co</b> '` };

  test("verification mentions 7 days, includes link in both parts", () => {
    const m = templates.verificationEmail({ name: "Ann", orgName: "Acme", link });
    expect(m.subject).toBeTruthy();
    expect(m.html).toContain("7 days");
    expect(m.text).toContain("7 days");
    expect(m.text).toContain(link);
    expect(m.html).toContain('href="https://app.example.com/verify-email?token=abc&amp;x=1"');
    expect(m.text).toContain("Ann");
    expect(m.text.length).toBeLessThan(900); // short
  });

  test("setup mentions 72 hours; hours can be overridden", () => {
    const m = templates.setupEmail({ name: "Ann", orgName: "Acme", link: "https://app.example.com/setup-password?token=t" });
    expect(m.html).toContain("72 hours");
    expect(m.text).toContain("72 hours");
    expect(templates.setupEmail({ name: "A", link, hours: 96 }).text).toContain("4 days");
    expect(templates.setupEmail({ name: "A", link, hours: 1 }).text).toContain("1 hour.");
  });

  test.each(["verificationEmail", "setupEmail", "approvedEmail", "rejectedEmail"])("%s escapes every interpolated value in html", (fn) => {
    const m = templates[fn]({ ...evil, link: 'https://app.example.com/x?a="><img src=x onerror=alert(1)>&b=1' });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain("<b>Co</b>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("Acme &quot;&amp;&quot; &lt;b&gt;Co&lt;/b&gt; &#39;");
    expect(typeof m.text).toBe("string");
    expect(m.text.length).toBeGreaterThan(20);
  });

  test("non-http links are never put in an href", () => {
    const m = templates.verificationEmail({ name: "A", orgName: "O", link: "javascript:alert(1)" });
    expect(m.html).not.toMatch(/href="javascript/i);
    expect(m.html).not.toMatch(/<a /);
  });

  test("approved and rejected are short and name the organization; missing data does not throw", () => {
    const a = templates.approvedEmail({ name: "Ann", orgName: "Acme", link: "https://app.example.com/login" });
    expect(a.text).toContain("Acme");
    expect(a.text).toContain("https://app.example.com/login");
    const r = templates.rejectedEmail({ name: "Ann", orgName: "Acme" });
    expect(r.text).toContain("Acme");
    expect(r.html).not.toMatch(/<a /);
    for (const fn of ["verificationEmail", "setupEmail", "approvedEmail", "rejectedEmail"]) {
      expect(() => templates[fn]()).not.toThrow();
    }
  });

  test("line breaks in names cannot forge text lines", () => {
    const m = templates.setupEmail({ name: "Ann\nVerify: https://evil.test", orgName: "Acme\r\nX", link: "https://app.example.com/s?token=t" });
    expect(m.text.split("\n")[0]).toBe("Hi Ann Verify: https://evil.test,");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  test("a template can be sent through the console provider and its link extracted", async () => {
    env.emailProvider = "console";
    email.clearOutbox();
    await email.sendMail({ to: "ann@acme.com", ...templates.verificationEmail({ name: "Ann", orgName: "Acme", link }) });
    expect(email.extractLinks(email.outbox[0].text)).toEqual([link]);
  });
});
