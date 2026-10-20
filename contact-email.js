// The follow-up e-mail for contacts left by guests (Guest stats → Contacts):
// one template, edited by the admins as plain fields (no HTML) and rendered
// into a branded e-mail, stored in the settings table (key "contact_email").
// It is sent with the Telnyx Email setup of /email.html (email.js), and the
// contact is marked as e-mailed. {{email}} and {{country}} are filled in.
import { sendEmail } from "./email.js";
import { getContact, markEmailed } from "./contacts.js";

const KEY = "contact_email";
const LIMITS = { fromName: 80, subject: 150, preheader: 150, heading: 120, body: 4000, buttonLabel: 40, buttonUrl: 500, signature: 300 };

export const TEMPLATE_DEFAULTS = {
  fromName: "The Telnyx team",
  subject: "Your TelnyxHotel demo, and what Telnyx can build for you",
  preheader: "Thanks for trying the TelnyxHotel voice concierge.",
  heading: "Thanks for trying TelnyxHotel",
  body: [
    "Hi,",
    "Thank you for trying the TelnyxHotel voice concierge and for asking us to get in touch.",
    "Everything you saw runs on Telnyx: the **multilingual AI receptionist**, the realtime voice, and the booking confirmations by e-mail and SMS, on our own global network.",
    "We'd love to show you what it could do for your business. Just reply to this e-mail, or pick a time with our team.",
  ].join("\n\n"),
  buttonLabel: "Talk to the Telnyx team",
  buttonUrl: "https://telnyx.com/contact-us",
  signature: "Best regards,\nThe Telnyx team",
};

let db;

export function initContactEmail(database) {
  db = database;
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function getTemplate() {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first();
  return { ...TEMPLATE_DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
}

// Checks and trims a template sent by the page.
export function cleanTemplate(body = {}) {
  const out = {};
  for (const [field, max] of Object.entries(LIMITS)) {
    const v = String(body[field] ?? "").replace(/\r\n?/g, "\n").trim();
    out[field] = field === "body" || field === "signature" ? v.slice(0, max) : v.replace(/\s+/g, " ").slice(0, max);
  }
  if (!out.subject) throw bad("The subject can't be empty");
  if (!out.body) throw bad("The message can't be empty");
  if (out.buttonUrl && !/^https:\/\/[^\s"'<>]+$/i.test(out.buttonUrl)) throw bad("The button link must start with https://");
  if (out.buttonUrl && !out.buttonLabel) throw bad("Give the button a label, or clear its link");
  return out;
}

export async function saveTemplate(body) {
  const t = cleanTemplate(body);
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(KEY, JSON.stringify(t)).run();
  return t;
}

let regionName = null;
try { regionName = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* no Intl data */ }
const countryName = (code) => { try { return (code && regionName?.of(code)) || code || ""; } catch { return code || ""; } };

// {{email}} / {{country}} in a text field.
const fill = (s, contact) => String(s).replace(/\{\{\s*(email|country)\s*\}\}/gi, (_, k) =>
  (k.toLowerCase() === "email" ? contact.email || "" : countryName(contact.country)));

// Text → HTML: blank lines make paragraphs, **bold** is bold.
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");

export function renderEmail(template, contact = { email: "guest@example.com", country: "NL" }) {
  const f = (field) => fill(template[field] || "", contact);
  const paragraphs = f("body").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const button = template.buttonUrl && template.buttonLabel;
  const footer = "You are receiving this e-mail because you asked to be contacted by Telnyx on the TelnyxHotel demo.";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(f("subject"))}</title></head>
<body style="margin:0;padding:0;background:#eef1ee;font-family:Helvetica,Arial,sans-serif;color:#16211e">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(f("preheader"))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1ee"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden">
<tr><td style="background:#000000;padding:26px 36px">
  <span style="font-size:24px;font-weight:bold;color:#ffffff;letter-spacing:-.02em">telnyx</span>
  <span style="font-size:13px;color:#00E3AA;letter-spacing:.14em;text-transform:uppercase;padding-left:10px">TelnyxHotel demo</span>
</td></tr>
<tr><td style="background:#00E3AA;height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:40px 36px 8px">
  <h1 style="margin:0 0 22px;font-size:30px;line-height:1.2;font-weight:bold;color:#000000">${esc(f("heading"))}</h1>
  ${paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#2b3532">${rich(p)}</p>`).join("\n  ")}
</td></tr>
${button ? `<tr><td style="padding:12px 36px 8px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#00E3AA;border-radius:999px">
    <a href="${esc(template.buttonUrl)}" style="display:inline-block;padding:15px 30px;font-size:15px;font-weight:bold;color:#000000;text-decoration:none">${esc(f("buttonLabel"))} &rarr;</a>
  </td></tr></table>
</td></tr>` : ""}
<tr><td style="padding:24px 36px 36px;font-size:15px;line-height:1.6;color:#2b3532">${rich(f("signature"))}</td></tr>
<tr><td style="background:#f6f8f6;padding:18px 36px;font-size:12px;line-height:1.5;color:#7b8587">${esc(footer)}</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    f("heading"), "", ...paragraphs.flatMap((p) => [p.replace(/\*\*(.+?)\*\*/g, "$1"), ""]),
    ...(button ? [`${f("buttonLabel")}: ${template.buttonUrl}`, ""] : []),
    f("signature"), "", "--", footer,
  ].join("\n");
  return { subject: f("subject"), html, text };
}

// Sends the saved template to one contact and marks it as e-mailed.
export async function sendContactEmail(id, actor) {
  const contact = await getContact(id);
  if (!contact) throw bad("Contact not found", 404);
  if (!contact.email) throw bad("This contact left no e-mail address");
  const template = await getTemplate();
  const { subject, html, text } = renderEmail(template, contact);
  const r = await sendEmail({ to: contact.email, subject, html, text, tag: "contact-follow-up", userId: actor.id, fromName: template.fromName });
  return markEmailed(id, {
    at: new Date().toISOString(), by: actor.email, messageId: r.id, status: r.status, to: r.to, redirected: r.redirected, sandbox: r.sandbox,
  });
}
