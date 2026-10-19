// Limiters added for the multi-organization flows: join code, resend verification, one-time links.
const express = require("express");
const request = require("supertest");

let rateLimit, env;

beforeAll(() => {
  env = require("../config/env");
  rateLimit = require("../middleware/rateLimit");
});
beforeEach(() => rateLimit.resetAll());

function miniApp(limiter) {
  const mini = express();
  mini.set("trust proxy", true);
  mini.use(express.json());
  mini.post("/x", limiter, (req, res) => res.status(req.body.ok ? 200 : 403).json({ error: "nope" }));
  return mini;
}
const hit = (mini, ip, body = {}) => request(mini).post("/x").set("X-Forwarded-For", ip).send(body);

test("env defaults and exports exist", () => {
  expect(env.joinCodeWindowMinutes).toBe(15);
  expect(env.joinCodeMaxFailures).toBeGreaterThan(0);
  expect(env.resendVerifyMax).toBeGreaterThan(0);
  for (const k of ["joinCodeLimiter", "resendVerifyLimiter", "tokenLimiter", "loginLimiter", "signupLimiter", "apiLimiter"]) {
    expect(rateLimit[k]).toBeDefined();
  }
  expect(Array.isArray(rateLimit.resendVerifyLimiter)).toBe(true);
  expect(Array.isArray(rateLimit.loginLimiter)).toBe(true);
});

describe("joinCodeLimiter", () => {
  test("counts only failed requests, per IP, with its own message", async () => {
    const mini = miniApp(rateLimit.createJoinCodeLimiter({ maxFailures: 3 }));
    for (let i = 0; i < 10; i += 1) expect((await hit(mini, "10.1.0.1", { ok: true })).status).toBe(200); // successes are free
    for (let i = 0; i < 3; i += 1) expect((await hit(mini, "10.1.0.1")).status).toBe(403);
    const blocked = await hit(mini, "10.1.0.1");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/Too many attempts with an invalid code/);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((await hit(mini, "10.1.0.2")).status).toBe(403); // another IP has its own budget
  });

  test("the shared instance uses the configured limit and is cleared by resetAll", async () => {
    const mini = miniApp(rateLimit.joinCodeLimiter);
    for (let i = 0; i < env.joinCodeMaxFailures; i += 1) expect((await hit(mini, "10.1.1.1")).status).toBe(403);
    expect((await hit(mini, "10.1.1.1")).status).toBe(429);
    rateLimit.resetAll();
    expect((await hit(mini, "10.1.1.1")).status).toBe(403);
  });
});

describe("resendVerifyLimiter", () => {
  test("per IP: every request counts, even successful ones", async () => {
    const mini = miniApp(rateLimit.createResendVerifyLimiter({ maxPerHour: 3 }));
    for (let i = 0; i < 3; i += 1) expect((await hit(mini, "10.2.0.1", { ok: true, email: `u${i}@x.com` })).status).toBe(200);
    const blocked = await hit(mini, "10.2.0.1", { ok: true, email: "other@x.com" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/verification email requests/);
    expect((await hit(mini, "10.2.0.2", { ok: true, email: "other@x.com" })).status).toBe(200);
  });

  test("per email: rotating IPs, casing and +tags does not buy more mails to one address", async () => {
    const mini = miniApp(rateLimit.createResendVerifyLimiter({ maxPerHour: 3 }));
    expect((await hit(mini, "10.3.0.1", { ok: true, email: "Target@x.com" })).status).toBe(200);
    expect((await hit(mini, "10.3.0.2", { ok: true, email: " target@X.com " })).status).toBe(200);
    expect((await hit(mini, "10.3.0.3", { ok: true, email: "target+spam@x.com" })).status).toBe(200);
    expect((await hit(mini, "10.3.0.4", { ok: true, email: "TARGET@x.com" })).status).toBe(429);
    expect((await hit(mini, "10.3.0.4", { ok: true, email: "someone-else@x.com" })).status).toBe(200);
  });

  test("malformed bodies fall back to the IP bucket instead of crashing", async () => {
    const mini = miniApp(rateLimit.createResendVerifyLimiter({ maxPerHour: 2 }));
    expect((await hit(mini, "10.4.0.1", { ok: true, email: { $gt: "" } })).status).toBe(200);
    expect((await hit(mini, "10.4.0.1", { ok: true })).status).toBe(200);
    expect((await hit(mini, "10.4.0.1", { ok: true, email: ["a@x.com"] })).status).toBe(429);
  });
});

describe("tokenLimiter", () => {
  test("30 attempts per IP then 429; the message names link attempts", async () => {
    const mini = miniApp(rateLimit.createTokenLimiter());
    for (let i = 0; i < 30; i += 1) expect((await hit(mini, "10.5.0.1", { ok: i % 2 === 0 })).status).not.toBe(429);
    const blocked = await hit(mini, "10.5.0.1", { ok: true });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/Too many link attempts/);
    expect((await hit(mini, "10.5.0.2")).status).toBe(403);
  });
});
