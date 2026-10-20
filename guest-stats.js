// Guest statistics for the admins (/guests.html). Every finished call made
// without an account is reduced to a few facts: when, how long, how far into
// the booking it got, how it ended and where it came from (the country of its
// origin IP, looked up offline in geo.js). The Telnyx
// conversation insights of each call (the assistant's insight group: Summary,
// Sentiment, Missed Opportunities…) are read back and parsed. The page does
// the counting, in the admin's own time zone.
import { unpackCall } from "./calls-codec.js";
import { countryOf, geoReady } from "./geo.js";

const TELNYX = "https://api.telnyx.com/v2";
const MAX_CALLS = 1000;
const MAX_INSIGHTS = 300;   // most recent calls whose insights are looked up
const INSIGHT_RETRY = 60_000; // insights not ready yet: ask again after a minute
const PARALLEL = 2;          // Telnyx rate-limits bursts

// How far a call got, in order. "booked" is a confirmed booking.
export const STAGES = ["failed", "silent", "talked", "hotel", "dates", "guests", "availability", "room", "details", "booked"];

let db, apiKey;
const facts = new Map();    // call id -> facts (a finished call doesn't change)
const insights = new Map(); // conversation id -> { at, value }

export function initGuestStats(database, options) {
  db = database;
  apiKey = options.apiKey;
}

// Loopback and private addresses are the platform's proxy, not the guest.
function publicIp(ip) {
  const s = String(ip || "").replace(/^::ffff:/, "");
  if (!s || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/i.test(s)) return null;
  return s;
}

function stageOf(call) {
  const s = call.summary;
  if (s.booking) return "booked";
  if (s.status === "failed" || !call.stats?.connectMs) return "failed";
  const seen = {};
  let availability = false;
  for (const t of call.tools || []) {
    if (t.name === "check_availability") availability = true;
    if (t.args && typeof t.args === "object") for (const [k, v] of Object.entries(t.args)) if (v != null && v !== "") seen[k] = true;
  }
  if (seen.guest_name || seen.email || seen.phone) return "details";
  if (seen.room_type) return "room";
  if (availability) return "availability";
  if (seen.adults) return "guests";
  if (seen.check_in && seen.check_out) return "dates";
  if (seen.hotel) return "hotel";
  return s.guestTurns > 0 ? "talked" : "silent";
}

function endedBy(call) {
  const s = call.summary;
  if (call.timeline?.some((e) => e.type === "guest.time_limit")) return "time_limit";
  if (s.status === "failed") return "error";
  if (/^Telnyx closed/.test(s.endReason || "")) return "assistant";
  if (/^browser/.test(s.endReason || "")) return "guest";
  return "other";
}

function factsOf(call) {
  const s = call.summary;
  const c = call.client || {};
  return {
    id: s.id,
    guestId: s.user.id,
    startedAt: s.startedAt,
    durationMs: s.durationMs,
    guestTurns: s.guestTurns,
    errors: s.errors,
    booked: !!s.booking,
    totalEur: s.booking?.total_eur ?? null,
    stage: stageOf(call),
    endedBy: endedBy(call),
    avatar: !!call.timeline?.some((e) => e.type === "avatar.session.ready"),
    conversationId: call.timeline?.find((e) => e.type === "session.created")?.data?.session?.conversation_id || null,
    ip: publicIp(c.ip),
    country: countryOf(publicIp(c.ip)) || c.country || null,
  };
}

// ---------------------------------------------------------------------------
// Telnyx conversation insights
// ---------------------------------------------------------------------------
async function telnyx(pathname, attempt = 0) {
  const res = await fetch(`${TELNYX}${pathname}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return telnyx(pathname, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Telnyx ${res.status}: ${body.errors?.[0]?.detail || body.errors?.[0]?.title || "request failed"}`);
  return body;
}

const groups = new Map(); // insight group id -> { at, names: Promise<Map(insight id -> name)> }
function insightNames(groupId) {
  const cached = groups.get(groupId);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.names;
  const names = telnyx(`/ai/conversations/insight-groups/${encodeURIComponent(groupId)}`)
    .then(({ data }) => new Map((data?.insights || []).map((i) => [i.id, i.name])));
  names.catch(() => groups.delete(groupId));
  groups.set(groupId, { at: Date.now(), names });
  return names;
}

// "No, the caller did not…" → false; "Yes, …" → true; anything else → null.
// Answers that start otherwise are read from their first sentence.
function yesNo(text) {
  const head = String(text).replace(/[#*_>\s]+/g, " ").trim();
  if (/^(no|none|nothing)\b/i.test(head)) return false;
  if (/^yes\b/i.test(head)) return true;
  const first = head.split(/(?<=[.!?])\s/)[0];
  if (/\b(did not|didn't|does not|doesn't|never)\b[^.]*\b(ask|request|need)|\bno (caller |user |guest )?(request|question)s?\b|\bnot ask|\bno indication\b|^there (is|was) no\b/i.test(first)) return false;
  if (/\b(did|does) ask\b|\b(couldn't|could not|unable to|wasn't able to) (help|assist)/i.test(first)) return true;
  return null;
}

// A sentiment label and a 0–1 score from the insight's free text. The
// overall score wins over partial ones; without a clear label, the score gives it.
function sentiment(text) {
  const t = String(text);
  const LABEL = "(very positive|positive|neutral|negative|very negative|mixed)";
  let label = (t.match(new RegExp(`\\*\\*\\s*${LABEL}\\s*\\*\\*`, "i"))
    || t.match(new RegExp(`(?:overall|sentiment)[^.\\n]*?\\b(?:is|:)\\s*\\**\\s*${LABEL}\\b`, "i")))?.[1]?.toLowerCase() || null;
  const overall = t.search(/overall[^\n]*score\b/i);
  const area = overall >= 0 ? t.slice(overall, overall + 300) : "";
  const m = area.match(/\*\*\s*(\d+(?:\.\d+)?)(\s*\/\s*10)?\s*\*\*/) || area.match(/score[^0-9\n]*\n?[^0-9\n]{0,40}(\d+(?:\.\d+)?)(\s*\/\s*10)?/i)
    || t.match(/score[^0-9\n]{0,40}(\d+(?:\.\d+)?)(\s*\/\s*10)?/i);
  let score = m ? Number(m[1]) : null;
  if (score != null && (m[2] || score > 1)) score = score <= 10 ? score / 10 : null;
  if (score != null) score = Math.round(score * 100) / 100;
  label ??= score != null ? (score >= 0.6 ? "positive" : score <= 0.4 ? "negative" : "neutral") : t.match(new RegExp(`\\b${LABEL}\\b`, "i"))?.[1]?.toLowerCase() || null;
  return { label, score };
}

function parseInsights(record, names) {
  const out = { items: [], summary: null, missed: null, missedText: null, sentiment: null, sentimentScore: null };
  for (const i of record.conversation_insights || []) {
    const name = names.get(i.insight_id) || "Insight";
    const text = String(i.result ?? "").trim();
    out.items.push({ name, text });
    if (/missed/i.test(name)) { out.missed = yesNo(text); out.missedText = text; }
    else if (/sentiment/i.test(name)) ({ label: out.sentiment, score: out.sentimentScore } = sentiment(text));
    else if (/summary/i.test(name)) out.summary = text;
  }
  return out;
}

async function insightsFor(conversationId) {
  const cached = insights.get(conversationId);
  if (cached && (cached.value?.status === "completed" || Date.now() - cached.at < INSIGHT_RETRY)) return cached.value;
  const { data } = await telnyx(`/ai/conversations/${encodeURIComponent(conversationId)}/conversations-insights`);
  const record = (data || []).find((r) => r.status === "completed") || data?.[0];
  let value = { status: record?.status || "none" };
  if (record?.status === "completed") value = { status: "completed", ...parseInsights(record, await insightNames(record.insight_group_id)) };
  insights.set(conversationId, { at: Date.now(), value });
  return value;
}

// Run fn over items, a few at a time.
async function pool(items, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// The facts of these calls, in the same order (unreadable ones left out).
async function factsFor(ids) {
  const missing = ids.filter((id) => !facts.has(id));
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const rows = (await db.prepare(`SELECT data FROM calls WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all()).results;
    for (const r of rows) {
      try { const f = factsOf(unpackCall(r.data)); facts.set(f.id, f); } catch (err) { console.error("guest stats: unreadable call:", err.message); }
    }
  }
  return ids.map((id) => facts.get(id)).filter(Boolean);
}

// For the Contacts tab: each guest's calls, and the furthest any of them got.
export async function guestJourneys(guestIds) {
  const out = new Map();
  const ids = [];
  for (let i = 0; i < guestIds.length; i += 50) {
    const chunk = guestIds.slice(i, i + 50);
    const { results } = await db.prepare(`SELECT id FROM calls WHERE user_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    ids.push(...results.map((r) => r.id));
  }
  for (const c of await factsFor(ids)) {
    const j = out.get(c.guestId) || { calls: 0, stage: null };
    j.calls++;
    if (STAGES.indexOf(c.stage) > STAGES.indexOf(j.stage)) j.stage = c.stage;
    out.set(c.guestId, j);
  }
  return out;
}

// ---------------------------------------------------------------------------
// days: 0 for everything kept, otherwise the last N days.
export async function guestStats({ days = 30 } = {}) {
  const since = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : "";
  const { results } = await db.prepare(
    "SELECT id FROM calls WHERE user_id LIKE 'g\\_%' ESCAPE '\\' AND started_at >= ? ORDER BY started_at DESC LIMIT ?",
  ).bind(since, MAX_CALLS).all();
  const ids = results.map((r) => r.id);
  const calls = await factsFor(ids);

  let insightsError = null;
  const withInsights = new Map();
  await pool(calls.filter((c) => c.conversationId).slice(0, MAX_INSIGHTS), async (c) => {
    try { withInsights.set(c.id, await insightsFor(c.conversationId)); } catch (err) { insightsError ??= err.message; }
  });
  return {
    stages: STAGES,
    calls: calls.map((c) => ({ ...c, insights: withInsights.get(c.id) || null })),
    insightsError,
    geo: geoReady(),
    limited: ids.length >= MAX_CALLS,
  };
}
