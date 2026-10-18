// Guest e-mail through the Telnyx Email API (POST /v2/email_messages), set up
// from the admin area (/email.html): on/off, the sender, a reply-to address,
// sandbox mode and an optional "send everything here" address for demos.
// Stored as one JSON document in the settings table (key "email"), cached for
// a few seconds so changes made on another instance show up.
// Every message is tagged with the app and the user who sent it, so a page
// lists only what this app (or this user) sent.
import crypto from "node:crypto";

const KEY = "email";
const TTL = 5000;
const TELNYX = "https://api.telnyx.com/v2";
const TAG = "telnyxhotel";
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;

const DEFAULTS = { enabled: false, from: "", fromName: "TelnyxHotel front desk", replyTo: "", sandbox: false, overrideTo: "" };

let db, apiKey;
let cache = null;
let loadedAt = 0;

export function initEmail(database, options) {
  db = database;
  apiKey = options.apiKey;
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (s, max) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

export async function getEmailSettings() {
  if (cache && Date.now() - loadedAt < TTL) return cache;
  const { results } = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).all();
  cache = { ...DEFAULTS, ...(results[0] ? JSON.parse(results[0].value) : {}) };
  loadedAt = Date.now();
  return cache;
}

export async function saveEmailSettings(body = {}) {
  const out = {
    enabled: !!body.enabled,
    from: clean(body.from, 254).toLowerCase(),
    fromName: clean(body.fromName, 80),
    replyTo: clean(body.replyTo, 254).toLowerCase(),
    sandbox: !!body.sandbox,
    overrideTo: clean(body.overrideTo, 254).toLowerCase(),
  };
  for (const [field, label] of [["from", "sender address"], ["replyTo", "reply-to address"], ["overrideTo", "redirect address"]]) {
    if (out[field] && !EMAIL_RE.test(out[field])) throw bad(`The ${label} is not a valid e-mail address`);
  }
  if (out.enabled && !out.from) throw bad("Choose a sender address before turning e-mail on");
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(KEY, JSON.stringify(out)).run();
  cache = out;
  loadedAt = Date.now();
  return out;
}

// Telnyx answers errors as { errors: [{ code, title, detail }] }.
async function telnyx(method, pathname, { body, headers } = {}) {
  let res;
  try {
    res = await fetch(`${TELNYX}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw bad(`Telnyx Email is unreachable (${err.name === "TimeoutError" ? "timed out" : err.message})`, 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.errors?.[0] || {};
    throw Object.assign(bad(e.detail || e.title || `Telnyx Email answered ${res.status}`, 502), { telnyxStatus: res.status, code: e.code });
  }
  return data;
}

// Sending domains of the account: verified custom domains can send from any
// address; a shared domain only from onboarding@<domain>, and only to the
// account owner's own address.
export async function listDomains() {
  const { data = [] } = await telnyx("GET", "/email_domains");
  return data.map((d) => ({
    id: d.id, domain: d.domain, type: d.type || "custom", status: d.status,
    sender: d.type === "shared" ? `onboarding@${d.domain}` : null,
  }));
}

const userTag = (id) => `user-${id}`;

// What this app (or one user) sent recently, newest first (bodies are never listed).
export async function recentMessages({ limit = 15, userId } = {}) {
  const tag = userId ? userTag(userId) : TAG;
  const { data = [] } = await telnyx("GET", `/email_messages?filter[tags]=${encodeURIComponent(tag)}&page[size]=${limit}`);
  return data.slice(0, limit).map((m) => ({
    id: m.id, status: m.status, subject: m.subject, createdAt: m.created_at, sandbox: !!m.sandbox,
    from: m.from?.email, to: (m.to || []).map((r) => r.email),
    delivery: Object.entries(m.recipient_statuses || {}).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ""}`).join(", "),
    tags: (m.tags || []).filter((t) => t !== TAG && !t.startsWith("user-")),
    userId: (m.tags || []).find((t) => t.startsWith("user-"))?.slice(5) || null,
  }));
}

// Sends one message with the saved settings. `to` is the guest's address; with
// a redirect address set, it goes there instead. Returns what happened.
export async function sendEmail({ to, subject, html, text, tag, userId, idempotencyKey }) {
  const s = await getEmailSettings();
  if (!s.enabled || !s.from) throw bad("Telnyx Email is not set up", 409);
  const recipient = s.overrideTo || to;
  const { data } = await telnyx("POST", "/email_messages", {
    headers: { "Idempotency-Key": idempotencyKey || crypto.randomUUID() },
    body: {
      from: s.fromName ? { email: s.from, name: s.fromName } : s.from,
      to: [recipient],
      ...(s.replyTo ? { reply_to: s.replyTo } : {}),
      subject,
      html_body: html,
      text_body: text,
      tags: [TAG, ...(tag ? [tag] : []), ...(userId ? [userTag(userId)] : [])],
      ...(s.sandbox ? { sandbox_mode: true } : {}),
    },
  });
  return { id: data.id, status: data.status, to: recipient, redirected: recipient !== to, sandbox: s.sandbox };
}

export async function sendTestEmail(to, actor) {
  const address = clean(to, 254).toLowerCase();
  if (!EMAIL_RE.test(address)) throw bad("Enter a valid e-mail address for the test");
  const when = new Date().toISOString().replace("T", " ").slice(0, 16);
  return sendEmail({
    to: address,
    subject: "TelnyxHotel: Telnyx Email test",
    text: `This is a test message from the TelnyxHotel demo, sent through the Telnyx Email API on ${when} UTC by ${actor.email}.\n\nIf you can read it, booking recaps will reach your guests.`,
    html: `<p>This is a test message from the <b>TelnyxHotel</b> demo, sent through the Telnyx Email API on ${when} UTC by ${actor.email.replace(/[&<>"']/g, "")}.</p><p>If you can read it, booking recaps will reach your guests.</p>`,
    tag: "test",
    userId: actor.id,
  });
}
