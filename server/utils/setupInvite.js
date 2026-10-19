// One-time "set your password" links for accounts created by an admin (org admin at org creation,
// Add user, re-issued links). Only the token HASH is stored on the user; the link itself is
// returned to the admin when the mail was not really delivered.
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { newToken } = require("./identity");
const { sendMail, emailEnabled, appUrl } = require("./email");
const { setupEmail } = require("./emailTemplates");

const SETUP_HOURS = 72;

// { token, hash, expiresAt } -- store hash + expiresAt on the user, put token in the link.
function newSetupToken() {
  const { token, hash } = newToken();
  return { token, hash, expiresAt: new Date(Date.now() + SETUP_HOURS * 60 * 60 * 1000) };
}

// bcrypt of random bytes nobody ever sees: an invited account cannot sign in until it sets
// its own password through the setup link.
const unusablePasswordHash = () => bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);

// Emails the link. emailSent = it left the server (a real provider accepted it). setupLink is
// handed back whenever it did NOT (console provider or a failure) and never when it did.
async function sendSetupInvite({ user, orgName, token }) {
  const link = appUrl("/setup-password", { token });
  const mail = setupEmail({ name: user.name, orgName, link, hours: SETUP_HOURS });
  const sent = await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
  const emailSent = Boolean(sent && sent.ok) && emailEnabled();
  return { emailSent, setupLink: emailSent ? null : link };
}

module.exports = { SETUP_HOURS, newSetupToken, unusablePasswordHash, sendSetupInvite };
