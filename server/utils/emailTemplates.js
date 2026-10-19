// Transactional email bodies. Every template takes plain data and returns { subject, html, text }.
// Interpolated values are HTML-escaped (names and organization names are user-controlled);
// the plain-text alternative carries the same content and the full link.

const escapeHtml = (v) =>
  String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Single-line text for the plain version / subject (no control characters or line breaks).
// eslint-disable-next-line no-control-regex
const oneLine = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

const isHttpUrl = (v) => /^https?:\/\/[^\s]+$/i.test(String(v == null ? "" : v));

// 168 -> "7 days", 96 -> "4 days", 72 -> "72 hours", 1 -> "1 hour"
function formatHours(hours) {
  const h = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Math.round(Number(hours)) : 1;
  if (h >= 96 && h % 24 === 0) return `${h / 24} days`;
  return `${h} hour${h === 1 ? "" : "s"}`;
}

const FONT = "font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif";

function layout(heading, paragraphs, action, footer) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.5">${p}</p>`).join("");
  const button = action
    ? isHttpUrl(action.link)
      ? `<p style="margin:22px 0"><a href="${escapeHtml(action.link)}" style="background:#1f4fd8;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">${escapeHtml(action.label)}</a></p>` +
        `<p style="margin:0 0 14px;line-height:1.5;color:#555555;font-size:13px">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(action.link)}</span></p>`
      : `<p style="margin:0 0 14px;line-height:1.5;word-break:break-all">${escapeHtml(action.link)}</p>`
    : "";
  return (
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;${FONT};color:#1a1a1a">` +
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;padding:28px;border-radius:8px">` +
    `<h1 style="margin:0 0 18px;font-size:20px">${escapeHtml(heading)}</h1>${body}${button}` +
    `<p style="margin:22px 0 0;color:#777777;font-size:12px;line-height:1.5">${escapeHtml(footer)}</p>` +
    `</div></body></html>`
  );
}

const FOOTER = "You are receiving this because someone used your email address on ModelWard. If that was not you, ignore this message.";

// { name, orgName, link, hours = 168 }
function verificationEmail({ name, orgName, link, hours = 168 } = {}) {
  const n = oneLine(name) || "there";
  const org = oneLine(orgName);
  const expiry = formatHours(hours);
  const subject = "Verify your email for ModelWard";
  const intro = org ? `Confirm your email and choose your password to finish joining ${org} on ModelWard.` : "Confirm your email and choose your password to finish creating your ModelWard account.";
  const after = "After that, your organization's admin may need to approve your account before you can sign in.";
  const html = layout(
    "Confirm your email and choose your password",
    [`Hi ${escapeHtml(n)},`, escapeHtml(intro), escapeHtml(after), `This link expires in ${escapeHtml(expiry)}.`],
    { label: "Confirm email and choose password", link },
    FOOTER
  );
  const text = [`Hi ${n},`, "", intro, after, "", `Confirm your email and choose your password: ${link}`, "", `This link expires in ${expiry}.`, "", FOOTER].join("\n");
  return { subject, html, text };
}

// { name, orgName, link, hours = 72 }
function setupEmail({ name, orgName, link, hours = 72 } = {}) {
  const n = oneLine(name) || "there";
  const org = oneLine(orgName);
  const expiry = formatHours(hours);
  const subject = org ? `Set your ModelWard password (${org})` : "Set your ModelWard password";
  const intro = org ? `An account has been created for you on ModelWard for ${org}. Choose a password to activate it.` : "An account has been created for you on ModelWard. Choose a password to activate it.";
  const html = layout(
    "Set your password",
    [`Hi ${escapeHtml(n)},`, escapeHtml(intro), `This link works once and expires in ${escapeHtml(expiry)}.`],
    { label: "Set password", link },
    FOOTER
  );
  const text = [`Hi ${n},`, "", intro, "", `Set your password: ${link}`, "", `This link works once and expires in ${expiry}.`, "", FOOTER].join("\n");
  return { subject, html, text };
}

// { name, orgName, link }  (link = the sign-in page)
function approvedEmail({ name, orgName, link } = {}) {
  const n = oneLine(name) || "there";
  const org = oneLine(orgName);
  const subject = "Your ModelWard account is approved";
  const intro = org ? `Your account for ${org} has been approved. You can sign in now.` : "Your account has been approved. You can sign in now.";
  const html = layout("Account approved", [`Hi ${escapeHtml(n)},`, escapeHtml(intro)], link ? { label: "Sign in", link } : null, FOOTER);
  const text = [`Hi ${n},`, "", intro, ...(link ? ["", `Sign in: ${link}`] : []), "", FOOTER].join("\n");
  return { subject, html, text };
}

// { name, orgName }
function rejectedEmail({ name, orgName } = {}) {
  const n = oneLine(name) || "there";
  const org = oneLine(orgName);
  const subject = "Your ModelWard request was not approved";
  const intro = org ? `Your request to join ${org} on ModelWard was not approved.` : "Your request to join ModelWard was not approved.";
  const next = "If you think this is a mistake, contact your organization's admin.";
  const html = layout("Request not approved", [`Hi ${escapeHtml(n)},`, escapeHtml(intro), escapeHtml(next)], null, FOOTER);
  const text = [`Hi ${n},`, "", intro, next, "", FOOTER].join("\n");
  return { subject, html, text };
}

module.exports = { verificationEmail, setupEmail, approvedEmail, rejectedEmail, escapeHtml, formatHours };
