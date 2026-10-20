// Call recorder: the server sees every frame of /ws/assistant both ways, and
// keeps per call the setup trip with timings, an event timeline (audio and
// transcript deltas counted, not stored), the conversation, tool calls,
// per-turn latency, errors and traffic counters. Stored compressed (db.js).
import crypto from "node:crypto";
import { packCall, unpackCall } from "./calls-codec.js";
import "./public/transcript.js"; // defines globalThis.TranscriptMerge

const { TranscriptMerge } = globalThis;
const MAX_TIMELINE = 5000;
const MAX_STRING = 4000;

const LIST_LIMIT = 500;
let db;
const live = new Map(); // id -> recorder (calls in progress on this instance)

export function initCalls(database) {
  db = database;
}

export async function listCalls({ userId } = {}) {
  const { results } = userId
    ? await db.prepare("SELECT summary FROM calls WHERE user_id = ? ORDER BY started_at DESC LIMIT ?").bind(userId, LIST_LIMIT).all()
    : await db.prepare("SELECT summary FROM calls ORDER BY started_at DESC LIMIT ?").bind(LIST_LIMIT).all();
  const stored = results.map((r) => JSON.parse(r.summary));
  const running = [...live.values()].map((r) => r.summary()).filter((s) => !userId || s.user.id === userId);
  const byId = new Map([...stored, ...running].map((s) => [s.id, s])); // a just-ended call can be in both
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getCall(id) {
  if (live.has(id)) return live.get(id).snapshot();
  const data = await db.prepare("SELECT data FROM calls WHERE id = ?").bind(id).first("data");
  return data ? unpackCall(data) : null;
}

export async function deleteCall(id) {
  if (live.has(id)) return false;
  const r = await db.prepare("DELETE FROM calls WHERE id = ?").bind(id).run();
  return (r.meta?.changes ?? 1) > 0;
}

// Latest call in progress for a user — lets other requests (e.g. the recap
// e-mail) be attached to the call that triggered them.
export function activeCallFor(userId) {
  let found = null;
  for (const r of live.values()) if (r.user.id === userId && (!found || r.startedAt > found.startedAt)) found = r;
  return found;
}

// Replace long base64 audio and huge strings so stored events stay readable.
function sanitize(value, depth = 0) {
  if (typeof value === "string") {
    if (value.length > 200 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200))) return `[${Math.round(value.length * 0.75)} bytes base64]`;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length} chars]` : value;
  }
  if (!value || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, depth + 1);
  return out;
}

const b64Bytes = (s) => (typeof s === "string" ? Math.floor(s.length * 0.75) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0) : 0);

function parseArgs(args) {
  if (typeof args !== "string") return args ?? {};
  try { return args.trim() ? JSON.parse(args) : {}; } catch { return args; }
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function createCallRecorder({ user, voice, inputRate, ip, userAgent, where = {} }) {
  const id = `c_${Date.now().toString(16)}${crypto.randomBytes(4).toString("hex")}`;
  const t0 = Date.now();
  const now = () => Date.now() - t0;

  const rec = {
    id,
    user: { id: user.id, name: user.name, email: user.email },
    startedAt: new Date(t0).toISOString(),
  };

  let endedAt = null;
  let endReason = null;
  let status = "connecting";
  let voiceInfo = null;
  let dynamicVariables = null;
  let outputRate = 24000;
  let droppedEvents = 0;

  const setup = [];      // { name, start, ms, ok, detail }
  const timeline = [];   // { t, dir: "up" | "down" | "server", type, data }
  const conversation = []; // { t, role: "guest" | "assistant" | "tool", ... }
  const tools = new Map(); // tool call id -> { t, kind: "client" | "server", name, args, output, ms, ok, status, totalMs }
  const errors = [];
  const httpRequests = [];
  const responses = new Map(); // response_id -> { createdAt, firstAudioAt, doneAt, status, assembler, turnStart }
  const turns = [];        // { t, source, responseId, latencyMs }
  const counts = { up: {}, down: {} };
  const traffic = { up: { frames: 0, bytes: 0 }, down: { frames: 0, bytes: 0 } };
  const audio = { inBytes: 0, outBytes: 0, inFrames: 0, outFrames: 0 };
  const marks = {};      // sessionCreated, firstAudio
  let pendingTurn = null; // when the guest finished speaking/typing, waiting for the reply's first audio
  let lastSentText = null; // typed text / form note: Telnyx echoes it back as a "transcription"
  let currentResponse = null;
  let speechStarts = 0;
  let bargeIns = 0;
  let booking = null;
  let message = null; // the guest's confirmation SMS / WhatsApp: { smsId, channel, sent, status, reason, error }

  function push(dir, type, data) {
    if (timeline.length >= MAX_TIMELINE) { droppedEvents++; return; }
    timeline.push({ t: now(), dir, type, data: data === undefined ? undefined : sanitize(data) });
  }

  rec.step = (name, start, { ok = true, detail } = {}) => {
    const entry = { name, start, ms: now() - start, ok, detail };
    setup.push(entry);
    push("server", `setup.${name}`, { ms: entry.ms, ok, ...detail });
  };
  rec.now = now;
  rec.setVoice = (v) => { voiceInfo = v; };

  // Outgoing HTTP calls made on behalf of this call (Telnyx REST, SMTP recap).
  rec.http = ({ label, method, url, status: code, ms, ok, detail }) => {
    const entry = { t: now(), label, method, url, status: code, ms, ok, detail: sanitize(detail) };
    httpRequests.push(entry);
    push("server", "http", entry);
  };

  rec.note = (type, detail) => push("server", type, detail);

  // The confirmation sent to the guest's mobile. Its delivery status keeps
  // changing after the call; the history API reads it from the SMS log (smsId).
  rec.setMessage = (m) => {
    message = sanitize(m);
    push("server", "guest_message", message);
  };

  // Telnyx announces every tool with response.tool_call.started; client-side
  // tools also arrive as a function_call item that the browser answers.
  function toolFor(id, name, args) {
    let tool = tools.get(id);
    if (!tool) {
      tool = { t: now(), kind: "server", callId: id, name, args: sanitize(parseArgs(args)), output: null, ms: null, ok: null, status: null, totalMs: null };
      tools.set(id, tool);
      conversation.push({ t: tool.t, role: "tool", callId: id });
    }
    return tool;
  }

  function responseFor(rid) {
    const key = rid || currentResponse || "unknown";
    let r = responses.get(key);
    if (!r) {
      r = { id: key, createdAt: now(), firstAudioAt: null, doneAt: null, status: null, assembler: TranscriptMerge.createAssembler(), deltas: 0 };
      responses.set(key, r);
    }
    return r;
  }

  // Browser → Telnyx
  rec.clientFrame = (data, isBinary) => {
    traffic.up.frames++;
    traffic.up.bytes += data.length ?? data.byteLength ?? 0;
    if (isBinary) { counts.up["(binary)"] = (counts.up["(binary)"] || 0) + 1; return; }
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    const type = ev.type || "(untyped)";
    counts.up[type] = (counts.up[type] || 0) + 1;

    if (type === "input_audio_buffer.append") {
      audio.inBytes += b64Bytes(ev.audio);
      audio.inFrames++;
      return;
    }
    if (type === "session.update") dynamicVariables = ev.session?.assistant?.dynamic_variables || dynamicVariables;
    if (type === "conversation.item.create") {
      const item = ev.item || {};
      if (item.type === "message" && item.role === "user") {
        const text = (item.content || []).map((c) => c.text).filter(Boolean).join(" ");
        const manual = /^\[/.test(text); // manual form edits are sent as bracketed notes
        conversation.push({ t: now(), role: "guest", source: manual ? "form" : "typed", text });
        lastSentText = { text: text.trim(), t: now() };
        if (!manual) pendingTurn = { t: now(), source: "typed" };
      }
      if (item.type === "function_call_output") {
        const tool = tools.get(item.call_id);
        const output = parseArgs(item.output);
        if (tool) {
          tool.output = sanitize(output);
          tool.ms = now() - tool.t;
          tool.ok = !(output?.error || output?.ok === false || output?.confirmed === false);
          if (tool.name === "confirm_booking" && output?.confirmed) {
            const r = output.recap_email || {};
            const recap = r.sent ? "sent" : r.preview_only ? "preview" : r.status === "sending" ? "sending" : "not sent";
            booking = { code: output.confirmation_code, total_eur: output.total_eur, recap };
          }
        }
      }
    }
    push("up", type, ev);
  };

  // Telnyx → browser
  rec.upstreamFrame = (data, isBinary) => {
    traffic.down.frames++;
    traffic.down.bytes += data.length ?? data.byteLength ?? 0;
    if (isBinary) { counts.down["(binary)"] = (counts.down["(binary)"] || 0) + 1; return; }
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    const type = ev.type || "(untyped)";
    counts.down[type] = (counts.down[type] || 0) + 1;

    switch (type) {
      case "session.created":
        status = "live";
        marks.sessionCreated = now();
        outputRate = ev.session?.audio?.output?.format?.rate || outputRate;
        break;
      case "response.created": {
        currentResponse = ev.response?.id || currentResponse;
        const r = responseFor(currentResponse);
        r.createdAt = now();
        break;
      }
      case "response.output_audio.delta": {
        audio.outBytes += b64Bytes(ev.delta);
        audio.outFrames++;
        const r = responseFor(ev.response_id);
        if (r.firstAudioAt == null) {
          r.firstAudioAt = now();
          if (marks.firstAudio == null) marks.firstAudio = r.firstAudioAt;
          if (pendingTurn) {
            turns.push({ t: pendingTurn.t, source: pendingTurn.source, responseId: r.id, latencyMs: r.firstAudioAt - pendingTurn.t });
            pendingTurn = null;
          }
          push("down", "response.output_audio.delta (first chunk)", { response_id: r.id });
        }
        return;
      }
      case "response.output_audio_transcript.delta": {
        const r = responseFor(ev.response_id);
        r.assembler.add(ev.delta || "");
        r.deltas++;
        return;
      }
      case "response.done": {
        const r = responseFor(ev.response?.id);
        r.doneAt = now();
        r.status = ev.response?.status || null;
        const text = r.assembler.text({ live: false });
        if (text) conversation.push({ t: r.createdAt, role: "assistant", text, responseId: r.id, status: r.status, firstAudioMs: r.firstAudioAt != null ? r.firstAudioAt - r.createdAt : null });
        push("down", type, { ...ev, _assembled_text: text, _transcript_deltas: r.deltas });
        return;
      }
      case "input_audio_buffer.speech_started":
        speechStarts++;
        if (currentResponse && responses.get(currentResponse) && !responses.get(currentResponse).doneAt) bargeIns++;
        break;
      case "input_audio_buffer.speech_stopped":
        pendingTurn = { t: now(), source: "voice" };
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = ev.transcript?.trim();
        const echo = lastSentText && lastSentText.text === text && now() - lastSentText.t < 5000;
        if (text && !echo) conversation.push({ t: now(), role: "guest", source: "voice", text });
        if (echo) lastSentText = null;
        break;
      }
      case "conversation.item.created":
        if (ev.item?.type === "function_call") toolFor(ev.item.call_id, ev.item.name, ev.item.arguments).kind = "client";
        break;
      case "response.tool_call.started": {
        const tc = ev.tool_call || {};
        toolFor(tc.id || `${tc.name}:${now()}`, tc.name, tc.arguments);
        break;
      }
      case "response.tool_call.completed": {
        const tool = tools.get(ev.tool_call?.id);
        if (tool) {
          tool.status = ev.status || null;
          tool.totalMs = now() - tool.t;
          if (tool.kind === "server") { tool.ms = tool.totalMs; tool.ok = ev.status === "success"; }
        }
        break;
      }
      case "error":
        errors.push({ t: now(), code: ev.error?.code, message: ev.error?.message });
        break;
    }
    push("down", type, ev);
  };

  rec.fail = (message) => {
    errors.push({ t: now(), code: "proxy_error", message });
    push("server", "error", { message });
    rec.end(`failed: ${message}`);
  };

  rec.end = (reason) => {
    if (endedAt) return;
    endedAt = Date.now();
    endReason = reason;
    if (status === "connecting") status = "failed";
    else status = "ended";
    push("server", "call.end", { reason });
    const full = rec.snapshot();
    db.prepare("INSERT OR REPLACE INTO calls (id, user_id, started_at, summary, data) VALUES (?, ?, ?, ?, ?)")
      .bind(id, rec.user.id, rec.startedAt, JSON.stringify(full.summary), packCall(full)).run()
      .catch((err) => console.error(`Could not save call ${id}:`, err.message))
      .finally(() => live.delete(id)); // stays listed (from memory) until it's in the table
  };

  function stats() {
    const latencies = turns.map((t) => t.latencyMs);
    const toolList = [...tools.values()];
    const inSec = audio.inBytes / 2 / inputRate;
    const outSec = audio.outBytes / 2 / outputRate;
    return {
      durationMs: (endedAt || Date.now()) - t0,
      connectMs: marks.sessionCreated ?? null,
      firstAudioMs: marks.firstAudio ?? null,
      guestTurns: conversation.filter((c) => c.role === "guest" && c.source !== "form").length,
      formEdits: conversation.filter((c) => c.role === "guest" && c.source === "form").length,
      assistantResponses: [...responses.values()].filter((r) => r.doneAt != null).length,
      cancelledResponses: [...responses.values()].filter((r) => r.status === "cancelled").length,
      speechStarts,
      bargeIns,
      toolCalls: toolList.length,
      toolFailures: toolList.filter((t) => t.ok === false).length,
      errors: errors.filter((e) => e.code !== "conversation_ended").length,
      latency: {
        avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
        p50Ms: percentile(latencies, 50),
        p90Ms: percentile(latencies, 90),
        maxMs: latencies.length ? Math.max(...latencies) : null,
        minMs: latencies.length ? Math.min(...latencies) : null,
      },
      audio: {
        inSeconds: Math.round(inSec * 10) / 10,
        outSeconds: Math.round(outSec * 10) / 10,
        inFrames: audio.inFrames,
        outFrames: audio.outFrames,
        inputRate,
        outputRate,
      },
      traffic,
      timelineEvents: timeline.length,
      droppedEvents,
    };
  }

  rec.summary = () => {
    const s = stats();
    return {
      id,
      user: rec.user,
      startedAt: rec.startedAt,
      endedAt: endedAt ? new Date(endedAt).toISOString() : null,
      status,
      endReason,
      voice: voiceInfo ? { id: voiceInfo.id, name: voiceInfo.name, provider: voiceInfo.provider, lang: voiceInfo.lang } : { id: voice },
      startLanguage: dynamicVariables?.start_language || null,
      receptionist: dynamicVariables?.receptionist_name || null,
      durationMs: s.durationMs,
      guestTurns: s.guestTurns,
      toolCalls: s.toolCalls,
      avgLatencyMs: s.latency.avgMs,
      errors: s.errors,
      booking,
      message,
    };
  };

  rec.snapshot = () => ({
    id,
    summary: rec.summary(),
    client: { ip, userAgent, ...where },
    voice: voiceInfo,
    dynamicVariables,
    stats: stats(),
    setup,
    turns,
    conversation: [
      ...conversation.map((c) => (c.role === "tool" ? { ...tools.get(c.callId), role: "tool" } : c)),
      // replies still being spoken (live call) or cut by the hang-up
      ...[...responses.values()].filter((r) => r.doneAt == null && r.deltas).map((r) => ({
        t: r.createdAt, role: "assistant", text: r.assembler.text({ live: false }), responseId: r.id,
        status: endedAt ? "unfinished" : "in_progress", firstAudioMs: r.firstAudioAt != null ? r.firstAudioAt - r.createdAt : null,
      })),
    ].sort((a, b) => a.t - b.t),
    tools: [...tools.values()].sort((a, b) => a.t - b.t),
    http: httpRequests,
    errors,
    counts,
    timeline,
  });

  live.set(id, rec);
  return rec;
}
