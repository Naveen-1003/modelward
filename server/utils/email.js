// Outgoing email behind EMAIL_PROVIDER (config/env.js).
//   console     development / tests: prints the mail (not in tests) and records it in `outbox`.
//   apps_script one HTTPS POST to a Google Apps Script web app that calls MailApp.sendEmail.
//
// sendMail never throws and never puts the relay URL or secret in a log line or an error.
const env = require("../config/env");

const FETCH_TIMEOUT_MS = 10000;
const OUTBOX_CAP = 200;

// Every mail "sent" outside production (console provider). Tests read it to find links.
const outbox = [];
const clearOutbox = () => {
  outbox.length = 0;
};

// Absolute http(s) URLs in a text, without trailing sentence punctuation.
function extractLinks(text) {
  const found = String(text == null ? "" : text).match(/https?:\/\/[^\s<>"']+/g) || [];
  return found.map((l) => l.replace(/[.,;:!?)\]]+$/, ""));
}

// Build an absolute link into the web app: appUrl("/verify-email", { token }).
function appUrl(path = "/", params) {
  const p = String(path || "/");
  let out = `${env.appUrl}${p.startsWith("/") ? "" : "/"}${p}`;
  if (params && typeof params === "object") {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
    if (qs) out += `${out.includes("?") ? "&" : "?"}${qs}`;
  }
  return out;
}

// True only when mail really leaves the server. Routes use it to decide whether to also
// hand a one-time link back to the admin.
const emailEnabled = () => env.emailProvider === "apps_script";

const decodeEntities = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Minimal HTML -> text, only used when a caller sends html without a text version.
function htmlToText(html) {
  const s = String(html || "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<(br|\/p|\/h\d|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s).replace(/\n{3,}/g, "\n\n").trim();
}

const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// One recipient, no list separators / header injection.
const validRecipient = (to) => typeof to === "string" && to.length <= 254 && /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/.test(to);
const cleanSubject = (s) => String(s == null ? "" : s).replace(/[\r\n\u0000-\u001f]+/g, " ").trim().slice(0, 200);

function consoleProvider({ to, subject, html, text }) {
  if (!env.isProd) {
    outbox.push({ to, subject, html, text, at: new Date() });
    if (outbox.length > OUTBOX_CAP) outbox.splice(0, outbox.length - OUTBOX_CAP);
  }
  if (env.nodeEnv !== "test") {
    const rule = "-".repeat(60);
    // In production the body holds one-time links; logs are not a safe place for them.
    const body = env.isProd ? "(body not printed in production)" : text;
    console.log(`\n${rule}\n[email:console] To: ${to}\nSubject: ${subject}\n\n${body}\n${rule}\n`);
  }
  return { ok: true };
}

async function appsScriptProvider({ to, subject, html }) {
  const fail = (error) => {
    if (env.nodeEnv !== "test") console.warn(`[email] send failed: ${error}`);
    return { ok: false, error };
  };
  if (!env.appsScriptUrl || !env.appsScriptSecret) return fail("Email delivery is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Apps Script answers the POST with a 302 to a one-off result URL, which has to be fetched
    // with GET; fetch does exactly that when following redirects. The timer covers the body read.
    const res = await fetch(env.appsScriptUrl, {
      method: "POST",
      redirect: "follow",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.appsScriptSecret, to, subject, html, name: env.emailFromName }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return fail(`Email service returned HTTP ${res.status}`);
    }
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return fail("Email service returned an unexpected response");
    }
    if (!data || data.ok !== true) return fail("Email service rejected the message");
    return { ok: true };
  } catch (err) {
    // err.message / err.cause can name the host; report only the category.
    return fail(err && err.name === "AbortError" ? "Email service timed out" : "Could not reach the email service");
  } finally {
    clearTimeout(timer);
  }
}

// sendMail({ to, subject, html, text }) -> { ok: true } | { ok: false, error }
async function sendMail({ to, subject, html, text } = {}) {
  try {
    if (!validRecipient(to)) return { ok: false, error: "Invalid recipient address" };
    const subj = cleanSubject(subject);
    if (!subj) return { ok: false, error: "Missing subject" };
    const plain = typeof text === "string" && text ? text : htmlToText(html);
    const body = typeof html === "string" && html ? html : `<pre style="font-family:inherit;white-space:pre-wrap">${escapeText(plain)}</pre>`;
    const mail = { to, subject: subj, html: body, text: plain };
    if (env.emailProvider === "apps_script") return await appsScriptProvider(mail);
    return consoleProvider(mail);
  } catch {
    return { ok: false, error: "Email could not be sent" };
  }
}

module.exports = { sendMail, emailEnabled, appUrl, outbox, clearOutbox, extractLinks, htmlToText };
