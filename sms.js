// Guest confirmation to a mobile number (set up in /sms.html), on one channel:
// "sms" (Telnyx Messaging, from a profile's number or alphanumeric sender) or
// "whatsapp" (an approved template from a WhatsApp Business number, filled from
// TEMPLATE_FACTS). Mobile numbers only (Telnyx Number Lookup). Settings live in
// the settings table (key "sms"); every attempt is logged in sms_messages and
// its delivery status read back from Telnyx while in flight.
import crypto from "node:crypto";

const KEY = "sms";
const TTL = 5000;
const TELNYX = "https://api.telnyx.com/v2";
const E164_RE = /^\+[1-9]\d{6,14}$/;
const ALPHA_RE = /^(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}$/;
const PROFILE_RE = /^[0-9a-f-]{36}$/i;
// Telnyx message statuses that won't change any more.
const FINAL = new Set(["delivered", "sending_failed", "delivery_failed", "delivery_unconfirmed", "not_sent"]);
const REFRESH_FOR = 48 * 3600_000; // stop asking Telnyx about a message after two days
const inFlight = (e) => e.telnyxId && !FINAL.has(e.status) && Date.now() - Date.parse(e.createdAt) < REFRESH_FOR;

const CHANNELS = ["sms", "whatsapp"];
const TEMPLATE_RE = /^[a-z0-9_]{1,512}$/;
const LANG_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
// Booking facts for a template's {{1}}, {{2}}, … in this order (the account's
// appointment confirmation reads: name, title, location, date, time).
const TEMPLATE_FACTS = ["guest", "title", "hotel", "dates", "time"];

const DEFAULTS = {
  enabled: false, channel: "sms", profileId: "", from: "", overrideTo: "",
  waFrom: "", waTemplate: "", waLanguage: "en_US", waParams: 0,
};

let db, apiKey;
let cache = null;
let loadedAt = 0;

export function initSms(database, options) {
  db = database;
  apiKey = options.apiKey;
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (s, max) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

// "+44 7700 900-123" → "+447700900123"; anything else → null.
function normalizeMobile(raw) {
  const s = String(raw ?? "").replace(/[\s().-]/g, "").replace(/^00/, "+");
  return E164_RE.test(s) ? s : null;
}

export async function getSmsSettings() {
  if (cache && Date.now() - loadedAt < TTL) return cache;
  const { results } = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).all();
  cache = { ...DEFAULTS, ...(results[0] ? JSON.parse(results[0].value) : {}) };
  loadedAt = Date.now();
  return cache;
}

export async function saveSmsSettings(body = {}) {
  const out = {
    enabled: !!body.enabled,
    channel: CHANNELS.includes(body.channel) ? body.channel : "sms",
    profileId: clean(body.profileId, 64),
    from: clean(body.from, 20),
    overrideTo: clean(body.overrideTo, 20),
    waFrom: clean(body.waFrom, 20),
    waTemplate: clean(body.waTemplate, 512),
    waLanguage: clean(body.waLanguage, 10) || "en_US",
    waParams: Math.max(0, Math.min(TEMPLATE_FACTS.length, Math.round(Number(body.waParams) || 0))),
  };
  if (out.waFrom) {
    out.waFrom = normalizeMobile(out.waFrom) || "";
    if (!out.waFrom) throw bad("The WhatsApp sender must be a number in international format");
  }
  if (out.waTemplate && !TEMPLATE_RE.test(out.waTemplate)) throw bad("Choose a WhatsApp template from the list");
  if (!LANG_RE.test(out.waLanguage)) throw bad("The template language must look like en_US");
  if (out.profileId && !PROFILE_RE.test(out.profileId)) throw bad("Choose a messaging profile from the list");
  if (out.from) {
    const number = normalizeMobile(out.from);
    if (number) out.from = number;
    else if (!ALPHA_RE.test(out.from)) throw bad("The sender must be a phone number in international format (+…) or an alphanumeric sender ID of up to 11 letters and digits");
    else if (!out.profileId) throw bad("An alphanumeric sender needs a messaging profile");
  }
  if (out.overrideTo) {
    out.overrideTo = normalizeMobile(out.overrideTo) || "";
    if (!out.overrideTo) throw bad("The redirect number must be in international format, e.g. +447700900123");
  }
  if (out.enabled && out.channel === "sms" && !out.from) throw bad("Choose a sender before turning SMS on");
  if (out.enabled && out.channel === "whatsapp" && !(out.waFrom && out.waTemplate)) throw bad("Choose a WhatsApp number and template before using WhatsApp");
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(KEY, JSON.stringify(out)).run();
  cache = out;
  loadedAt = Date.now();
  return out;
}

async function telnyx(method, pathname, body) {
  let res;
  try {
    res = await fetch(`${TELNYX}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw bad(`Telnyx Messaging is unreachable (${err.name === "TimeoutError" ? "timed out" : err.message})`, 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.errors?.[0] || {};
    throw Object.assign(bad(e.detail || e.title || `Telnyx answered ${res.status}`, 502), { code: e.code });
  }
  return data;
}

// Messaging profiles of the account, for the setup form.
export async function listProfiles() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const { data = [], meta = {} } = await telnyx("GET", `/messaging_profiles?page%5Bsize%5D=100&page%5Bnumber%5D=${page}`);
    out.push(...data.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled !== false, alphaSender: p.alpha_sender || null, destinations: p.whitelisted_destinations || [] })));
    if (page >= (meta.total_pages || 1)) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Senders a profile offers: its alphanumeric sender ID and its numbers.
export async function profileSenders(profileId) {
  if (!PROFILE_RE.test(String(profileId))) throw bad("Unknown messaging profile");
  const [{ data: profile }, { data: numbers = [] }] = await Promise.all([
    telnyx("GET", `/messaging_profiles/${profileId}`),
    telnyx("GET", `/messaging_profiles/${profileId}/phone_numbers?page%5Bsize%5D=100`),
  ]);
  return {
    alphaSender: profile?.alpha_sender || null,
    numbers: numbers.map((n) => n.phone_number).filter(Boolean),
  };
}

// WhatsApp Business numbers and approved templates of the account. A template
// can only be used once Meta approved it; its body parameter count is what
// the booking fills in.
export async function listWhatsApp() {
  const [{ data: numbers = [] }, { data: templates = [] }] = await Promise.all([
    telnyx("GET", "/whatsapp/phone_numbers"),
    telnyx("GET", "/whatsapp/message_templates?page%5Bsize%5D=100"),
  ]);
  return {
    numbers: numbers.filter((n) => n.phone_number).map((n) => ({ number: n.phone_number, name: n.display_name || "", status: n.status, quality: n.quality_rating || "" })),
    templates: templates.filter((t) => t.status === "APPROVED" && t.category !== "AUTHENTICATION").map((t) => {
      const body = (t.components || []).find((c) => c.type === "BODY")?.text || "";
      return { name: t.name, language: t.language, category: t.category, body, params: new Set(body.match(/\{\{\d+\}\}/g) || []).size };
    }),
  };
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
async function saveEntry(entry) {
  entry.updatedAt = new Date().toISOString();
  await db.prepare("INSERT OR REPLACE INTO sms_messages (id, created_at, data) VALUES (?, ?, ?)")
    .bind(entry.id, entry.createdAt, JSON.stringify(entry)).run();
  return entry;
}

// Telnyx reports one status per recipient; this app always sends to one.
function fromTelnyx(entry, m) {
  const to = m.to?.[0] || {};
  entry.status = to.status || m.status || entry.status;
  entry.carrier = to.carrier || entry.carrier;
  entry.lineType = to.line_type || entry.lineType;
  entry.parts = m.parts ?? entry.parts;
  entry.cost = m.cost?.amount ? `${m.cost.amount} ${m.cost.currency}` : entry.cost;
  const err = (m.errors || [])[0];
  if (err) entry.error = [err.code, err.title, err.detail].filter(Boolean).join(" · ");
  if (m.completed_at) entry.completedAt = m.completed_at;
  return entry;
}

async function refreshEntry(entry) {
  if (!entry.telnyxId || FINAL.has(entry.status)) return entry;
  try {
    const { data } = await telnyx("GET", `/messages/${entry.telnyxId}`);
    const before = JSON.stringify(entry);
    fromTelnyx(entry, data);
    if (JSON.stringify(entry) !== before) await saveEntry(entry);
  } catch (err) {
    console.error(`SMS status ${entry.telnyxId}: ${err.message}`);
  }
  return entry;
}

// Follow a fresh message until it settles (best effort: the admin page also refreshes).
function followUp(entry) {
  for (const ms of [3000, 10_000, 30_000, 90_000]) {
    setTimeout(() => { if (!FINAL.has(entry.status)) refreshEntry(entry); }, ms).unref?.();
  }
}

// The latest message of each call (for the call history), refreshed from
// Telnyx when still in flight: Map of call id → { channel, status, error, user, … }.
export async function messagesByCall(limit = 1000) {
  const { results } = await db.prepare("SELECT data FROM sms_messages WHERE json_extract(data, '$.callId') IS NOT NULL ORDER BY created_at DESC LIMIT ?").bind(limit).all();
  const latest = new Map();
  for (const e of results.map((r) => JSON.parse(r.data))) if (!latest.has(e.callId)) latest.set(e.callId, e);
  const entries = [...latest.values()];
  await Promise.all(entries.filter(inFlight).map(refreshEntry));
  return new Map(entries.map((e) => [e.callId, {
    smsId: e.id, channel: e.channel || "sms", sent: !!e.telnyxId, status: e.status, reason: e.reason, error: e.error, lineType: e.lineType, user: e.user, updatedAt: e.updatedAt,
  }]));
}

// The latest messages, of every user or of one (by e-mail).
export async function recentSms({ limit = 25, user } = {}) {
  const { results } = await (user
    ? db.prepare("SELECT data FROM sms_messages WHERE json_extract(data, '$.user') = ? ORDER BY created_at DESC LIMIT ?").bind(user, limit)
    : db.prepare("SELECT data FROM sms_messages ORDER BY created_at DESC LIMIT ?").bind(limit)).all();
  const entries = results.map((r) => JSON.parse(r.data));
  await Promise.all(entries.filter(inFlight).map(refreshEntry));
  return entries;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// What kind of line a number is, from Telnyx Number Lookup. null if unknown.
async function lineType(number) {
  try {
    const { data } = await telnyx("GET", `/number_lookup/${encodeURIComponent(number)}?type=carrier`);
    return { type: data?.carrier?.type || null, carrier: data?.carrier?.name || null, valid: data?.valid_number !== false };
  } catch (err) {
    console.error(`Number lookup ${number}: ${err.message}`);
    return { type: null, carrier: null, valid: true };
  }
}
// "mobile" and the NANP "fixed line or mobile" pass; "fixed line", "voip", "toll free"… don't.
const isMobile = (type) => !type || /mobile/i.test(type);

// WhatsApp template parameters: no newlines and at most 4 spaces in a row.
const waText = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "-";

// Sends one confirmation on the configured channel and logs it. `text` is the
// SMS; `facts` fill the WhatsApp template ({ guest, title, hotel, dates, time }).
// Never throws for a guest problem (bad number, landline, Telnyx refusal): the
// result says what happened.
export async function sendSms({ to, text, facts = {}, kind, code, lang, user, callId = null }) {
  const s = await getSmsSettings();
  const whatsapp = s.channel === "whatsapp";
  if (!s.enabled || (whatsapp ? !(s.waFrom && s.waTemplate) : !s.from)) throw bad("Guest messages are not set up", 409);
  const entry = {
    id: `sms_${crypto.randomBytes(8).toString("hex")}`,
    createdAt: new Date().toISOString(),
    channel: whatsapp ? "whatsapp" : "sms",
    kind, code: code || null, lang: lang || null, user: user || null, callId,
    guestNumber: clean(to, 32), to: null, from: whatsapp ? s.waFrom : s.from, redirected: false,
    status: "not_sent", error: null, reason: null, lineType: null, carrier: null, telnyxId: null,
  };
  const number = normalizeMobile(to);
  if (!number) {
    entry.reason = "invalid_number";
    entry.error = "not a phone number in international format";
    return { ...(await saveEntry(entry)), sent: false };
  }
  const line = await lineType(number);
  entry.lineType = line.type;
  entry.carrier = line.carrier;
  if (!line.valid || !isMobile(line.type)) {
    entry.reason = line.valid ? "not_mobile" : "invalid_number";
    entry.error = line.valid ? `not a mobile number (${line.type})` : "not a valid phone number";
    return { ...(await saveEntry(entry)), sent: false };
  }
  entry.to = s.overrideTo || number;
  entry.redirected = entry.to !== number;
  try {
    const alpha = !normalizeMobile(s.from);
    const { data } = whatsapp
      ? await telnyx("POST", "/messages/whatsapp", {
        from: s.waFrom, to: entry.to,
        whatsapp_message: {
          type: "template",
          template: {
            name: s.waTemplate,
            language: { policy: "deterministic", code: s.waLanguage },
            ...(s.waParams ? { components: [{ type: "body", parameters: TEMPLATE_FACTS.slice(0, s.waParams).map((k) => ({ type: "text", text: waText(facts[k]) })) }] } : {}),
          },
        },
      })
      : await telnyx("POST", "/messages", {
        from: s.from, to: entry.to, text, type: "SMS",
        ...(alpha ? { messaging_profile_id: s.profileId } : {}), // a number sender brings its own profile
      });
    if (whatsapp) entry.template = s.waTemplate;
    entry.telnyxId = data.id;
    fromTelnyx(entry, data);
    entry.status ||= "queued";
  } catch (err) {
    entry.status = "not_sent";
    entry.reason = "refused";
    entry.error = err.message;
    return { ...(await saveEntry(entry)), sent: false };
  }
  await saveEntry(entry);
  followUp(entry);
  return { ...entry, sent: true };
}

export async function sendTestSms(to, actor) {
  const when = new Date().toISOString().replace("T", " ").slice(0, 16);
  const r = await sendSms({
    to, kind: "test", user: actor,
    text: `TelnyxHotel demo: test SMS sent with Telnyx Messaging on ${when} UTC. If you read this, booking confirmations will reach your guests.`,
    facts: { guest: "Test guest", title: "Deluxe City View · booking THTEST23", hotel: "TelnyxHotel Amsterdam Canal Ring", dates: `${when.slice(0, 10)} (test)`, time: "Check-in from 15:00" },
  });
  if (!r.sent) throw bad(`Not sent: ${r.error}`);
  return r;
}
