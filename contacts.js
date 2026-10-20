// Contact requests: a guest (no account) can leave an e-mail address and/or a
// phone number, with their consent, to be contacted by Telnyx about the demo
// (the pop-up on the booking page). One record per guest session: leaving
// details again updates it. Admins see them in Guest stats → Contacts, can
// send them the follow-up e-mail (contact-email.js) and delete them.
import crypto from "node:crypto";

import { countryOf } from "./geo.js";
import { guestJourneys } from "./guest-stats.js";

const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,253}\.[^\s@<>()",;.]{2,}$/;
const LANGS = new Set(["en", "fr", "de", "it", "es", "nl"]);
const MAX_LIST = 1000;

let db;

export function initContacts(database) {
  db = database;
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

// "+39 347 000-0000" → "+393470000000"; null when empty, an error when not a number.
function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const phone = raw.replace(/[\s().-]/g, "");
  if (!/^\+?[0-9]{7,15}$/.test(phone)) throw bad("Enter a valid phone number");
  return phone;
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !EMAIL_RE.test(email)) throw bad("Enter a valid e-mail address");
  return email;
}

// Stable per guest session, so a second submission replaces the first.
const idFor = (guestId) => `ct_${crypto.createHash("sha256").update(guestId).digest("hex").slice(0, 16)}`;

// The details as stored, or a 400 error.
export function parseContact({ email, phone, consent }) {
  const record = { email: normalizeEmail(email), phone: normalizePhone(phone) };
  if (!record.email && !record.phone) throw bad("Enter an e-mail address or a phone number");
  if (consent !== true) throw bad("Please tick the box to agree to be contacted");
  return record;
}

// country: the platform's country header, when the IP isn't in the table.
export async function saveContact({ guestId, lang, ip, country, ...details }) {
  const record = parseContact(details);
  const id = idFor(guestId);
  const now = new Date().toISOString();
  const before = await db.prepare("SELECT created_at FROM contacts WHERE id = ?").bind(id).first("created_at");
  const data = {
    id, guestId, ...record,
    lang: LANGS.has(lang) ? lang : "en",
    country: countryOf(ip) || country || null,
    consentAt: now,
    createdAt: before || now,
    updatedAt: now,
  };
  await db.prepare("INSERT OR REPLACE INTO contacts (id, created_at, data) VALUES (?, ?, ?)").bind(id, data.createdAt, JSON.stringify(data)).run();
  return { id };
}

// Newest first, with how far each guest's calls got.
export async function listContacts() {
  const { results } = await db.prepare("SELECT data FROM contacts ORDER BY created_at DESC LIMIT ?").bind(MAX_LIST).all();
  const contacts = results.map((r) => JSON.parse(r.data));
  const journeys = await guestJourneys([...new Set(contacts.map((c) => c.guestId))]);
  return contacts.map((c) => ({ ...c, calls: journeys.get(c.guestId)?.calls ?? 0, stage: journeys.get(c.guestId)?.stage ?? null }));
}

export async function getContact(id) {
  const row = await db.prepare("SELECT data FROM contacts WHERE id = ?").bind(String(id)).first();
  return row ? JSON.parse(row.data) : null;
}

// Records a follow-up e-mail on the contact (the last one, and how many).
export async function markEmailed(id, sent) {
  const c = await getContact(id);
  if (!c) return null;
  const data = { ...c, emailed: sent, emailCount: (c.emailCount || 0) + 1 };
  await db.prepare("UPDATE contacts SET data = ? WHERE id = ?").bind(JSON.stringify(data), c.id).run();
  return data;
}

export async function deleteContact(id) {
  const r = await db.prepare("DELETE FROM contacts WHERE id = ?").bind(String(id)).run();
  return (r.meta?.changes ?? 1) > 0;
}
