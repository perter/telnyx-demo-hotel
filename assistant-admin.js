// AI Assistant settings for the admin panel (/assistant.html). Telnyx is the
// source of truth: every read fetches the live assistant, every save sends one
// section as a partial update (Telnyx merges it and creates a new version).
// The voice itself is not edited here: the widget's shortlist (concierge.js)
// decides which voices guests can pick, and the server sets it per call.
import { setting } from "./settings.js";

const TELNYX = "https://api.telnyx.com/v2";

const defaultBucket = () => setting("KB_BUCKET") || "telnyxhotel-kb"; // read late: .env loads after imports
// Video avatar (beta). Stock avatars, used when Telnyx can't list them.
const STOCK_AVATARS = ["elena", "ben", "jordan", "lin", "avery", "raphael"];
const AVATAR_BACKGROUNDS = ["studio", "office", "reception"];
const AVATAR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

let headers, assistantId;
let models = { at: 0, list: [] };
let avatars = { at: 0, list: [] };

export function initAssistantAdmin({ apiKey, id }) {
  headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  assistantId = id;
}

async function telnyx(method, url, body) {
  const res = await fetch(`${TELNYX}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.errors?.[0]?.detail || json.errors?.[0]?.title || json.detail || res.statusText;
    throw Object.assign(new Error(`Telnyx ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`), { status: 502 });
  }
  return json.data && !json.id ? json.data : json;
}

const live = () => telnyx("GET", `/ai/assistants/${assistantId}`);

async function modelList() {
  if (Date.now() - models.at < 3600_000 && models.list.length) return models.list;
  const list = await telnyx("GET", "/ai/models");
  models = {
    at: Date.now(),
    list: (Array.isArray(list) ? list : [])
      .filter((m) => !/embed|whisper|tts|stt|distil/i.test(m.id) && (!m.task || /generation|chat/i.test(m.task)))
      .map((m) => ({ id: m.id, recommended: !!m.recommended_for_assistants }))
      .sort((a, b) => b.recommended - a.recommended || a.id.localeCompare(b.id)),
  };
  return models.list;
}

function retrievalTool(a) {
  return (a.tools || []).find((t) => t.type === "retrieval");
}

function summary(a) {
  const vs = a.voice_settings || {};
  const bg = vs.background_audio?.type === "predefined_media" ? vs.background_audio : null;
  const ts = a.transcription?.settings || {};
  const is = a.interruption_settings || {};
  const tel = a.telephony_settings || {};
  const rt = retrievalTool(a);
  return {
    name: a.name,
    version: a.version_id,
    versionCreatedAt: a.version_created_at,
    prompt: { model: a.model, instructions: a.instructions || "" },
    voice: {
      current: vs.voice,
      expressive_mode: !!vs.expressive_mode,
      background: bg?.value || (vs.background_audio ? "custom" : "silence"),
      background_volume: bg?.volume ?? 0.5,
    },
    listening: {
      transcription_model: a.transcription?.model || "",
      eot_threshold: ts.eot_threshold ?? 0.7,
      eot_timeout_ms: ts.eot_timeout_ms ?? 5000,
      interruptions: is.enable !== false,
      disable_greeting_interruption: !!is.disable_greeting_interruption,
      interrupt_prediction_threshold: is.interrupt_prediction_threshold ?? 0,
      user_idle_reply_secs: tel.user_idle_reply_secs ?? null,
      time_limit_secs: tel.time_limit_secs ?? 1800,
    },
    avatar: {
      enabled: !!a.avatar_settings,
      avatar_id: a.avatar_settings?.avatar_id || STOCK_AVATARS[0],
      background_id: a.avatar_settings?.background_id || "studio",
    },
    knowledge: {
      enabled: !!rt,
      bucket: rt?.retrieval?.bucket_ids?.[0] || defaultBucket(),
      max_num_results: rt?.retrieval?.max_num_results ?? 3,
    },
  };
}

async function kbFiles(bucket) {
  try {
    const files = await telnyx("GET", `/ai/embeddings/buckets/${encodeURIComponent(bucket)}`);
    return (Array.isArray(files) ? files : []).map((f) => ({
      filename: f.filename, status: f.status, embeddedAt: f.last_embedded_at, error: f.error_reason || null,
    }));
  } catch (err) {
    return { error: err.message };
  }
}

// Avatars the account can use (stock and custom), cached for an hour. The
// beta list endpoint can fail; the stock names are offered then.
async function avatarList() {
  if (Date.now() - avatars.at < 3600_000 && avatars.list.length) return avatars.list;
  try {
    const list = await telnyx("GET", "/ai/avatars");
    const mapped = (Array.isArray(list) ? list : []).filter((v) => v.id)
      .map((v) => ({ id: v.id, name: v.name || v.id, type: v.avatar_type || "", image: v.image_url || null }));
    if (mapped.length) {
      avatars = { at: Date.now(), list: mapped };
      return mapped;
    }
  } catch { /* fall back to the stock names */ }
  const stock = STOCK_AVATARS.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), type: "stock", image: null }));
  avatars = { at: Date.now() - 3000_000, list: stock }; // ask Telnyx again in 10 minutes
  return stock;
}

export async function readAssistant() {
  const a = await live();
  const s = summary(a);
  const [modelsList, files, avatarsList] = await Promise.all([modelList().catch(() => []), kbFiles(s.knowledge.bucket), avatarList()]);
  return { ...s, models: modelsList, knowledgeFiles: files, avatars: avatarsList, avatarBackgrounds: AVATAR_BACKGROUNDS };
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function num(value, label, min, max, { step } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max}`);
  return step ? Math.round(n / step) * step : n;
}

// section: "prompt" | "voice" | "listening" | "knowledge" | "avatar"
export async function updateAssistant(section, body = {}) {
  const a = await live();
  let patch;
  if (section === "prompt") {
    const instructions = String(body.instructions ?? "");
    if (!instructions.trim()) throw bad("The instructions can't be empty");
    if (instructions.length > 40_000) throw bad("The instructions are too long (max 40,000 characters)");
    const model = String(body.model || "");
    if (!(await modelList()).some((m) => m.id === model)) throw bad(`Unknown model: ${model}`);
    patch = { model, instructions };
  } else if (section === "voice") {
    const background = body.background === "office" ? "office" : "silence";
    patch = {
      voice_settings: {
        voice: a.voice_settings?.voice,
        expressive_mode: !!body.expressive_mode,
        background_audio: {
          type: "predefined_media",
          value: background,
          volume: Number(num(body.background_volume ?? 0.5, "Background volume", 0.1, 1, { step: 0.1 }).toFixed(1)),
        },
      },
    };
  } else if (section === "listening") {
    const eot = Number(num(body.eot_threshold, "End-of-turn confidence", 0.5, 0.9, { step: 0.05 }).toFixed(2));
    const current = a.transcription || {};
    const keep = Object.fromEntries(Object.entries(current.settings || {}).filter(([, v]) => v != null));
    const idle = body.user_idle_reply_secs === null || body.user_idle_reply_secs === "" ? null
      : Math.round(num(body.user_idle_reply_secs, "Idle check-in", 5, 120));
    patch = {
      transcription: {
        model: current.model,
        language: current.language,
        settings: {
          ...keep,
          eot_threshold: eot,
          eager_eot_threshold: eot, // equal = no eager end of turn (no speculative replies)
          eot_timeout_ms: Math.round(num(body.eot_timeout_ms, "Silence timeout", 500, 10_000)),
        },
      },
      interruption_settings: {
        enable: !!body.interruptions,
        disable_greeting_interruption: !!body.disable_greeting_interruption,
        interrupt_prediction_threshold: Number(num(body.interrupt_prediction_threshold ?? 0, "Interrupt prediction", 0, 1, { step: 0.05 }).toFixed(2)),
      },
      telephony_settings: {
        user_idle_reply_secs: idle,
        time_limit_secs: Math.round(num(body.time_limit_secs, "Call time limit", 60, 3600)),
      },
    };
  } else if (section === "knowledge") {
    const bucket = retrievalTool(a)?.retrieval?.bucket_ids?.[0] || defaultBucket();
    // Re-send the other tools as they are (without server-set fields).
    const tools = (a.tools || []).filter((t) => t.type !== "retrieval" && !t.shared)
      .map(({ tool_id, shared, ...t }) => t);
    if (body.enabled) {
      tools.unshift({
        type: "retrieval",
        retrieval: { bucket_ids: [bucket], max_num_results: Math.round(num(body.max_num_results, "Results per search", 1, 10)) },
      });
    }
    patch = { tools };
    // Tools from the shared Tools Library are kept by id, never re-sent inline.
    const shared = (a.tools || []).filter((t) => t.shared && t.tool_id).map((t) => t.tool_id);
    if (shared.length) patch.tool_ids = shared;
  } else if (section === "avatar") {
    if (!body.enabled) patch = { avatar_settings: null };
    else {
      const avatarId = String(body.avatar_id || "");
      if (!AVATAR_ID_RE.test(avatarId)) throw bad("Choose an avatar");
      const background = String(body.background_id || "");
      if (!AVATAR_BACKGROUNDS.includes(background)) throw bad(`Background must be one of: ${AVATAR_BACKGROUNDS.join(", ")}`);
      patch = { avatar_settings: { provider: "telnyx", model: "foxtrot-1", avatar_id: avatarId, background_id: background } };
    }
  } else {
    throw bad(`Unknown section: ${section}`);
  }
  // Re-send the video avatar: a tools update has been seen to come back without it.
  if (section !== "avatar" && a.avatar_settings) patch.avatar_settings = a.avatar_settings;
  await telnyx("POST", `/ai/assistants/${assistantId}`, patch);
  return readAssistant();
}
