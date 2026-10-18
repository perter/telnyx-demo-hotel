// Admin: the concierge widget (languages, voice shortlists, greetings) and the
// live Telnyx AI Assistant (prompt, model, voice, listening, knowledge base).
// Each card saves on its own; assistant changes create a new Telnyx version.
const $ = (id) => document.getElementById(id);
const { esc, api } = Account;

Account.topbar($("topbar"));


function note(el, text) {
  el.textContent = text;
  clearTimeout(el.timer);
  if (text) el.timer = setTimeout(() => (el.textContent = ""), 4000);
}

async function saving(button, errorEl, okEl, work) {
  button.disabled = true;
  errorEl.textContent = "";
  try {
    note(okEl, await work());
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

// ============================================================
// Languages & voices (stored by our server)
// ============================================================
let languages = []; // [{ code, name, label, defaultGreeting }]
let catalog = [];   // Telnyx Ultra voices of those languages
let cfg = null;     // { languages, defaultLanguage, voices, defaultVoice, greetings }
const PATTERNS = { en: /^en/, fr: /^fr/, de: /^de/, it: /^it/, es: /^es/, nl: /^nl/ };
const SAMPLE_SALUTATION = { en: "Good morning", fr: "Bonjour", de: "Guten Tag", it: "Buongiorno", es: "Buenos días", nl: "Goedemiddag" };
const firstName = (v) => v.name.split(" - ")[0].trim();
const voicesOf = (code) => catalog.filter((v) => PATTERNS[code]?.test(v.language));
const filters = {};

function renderLangList() {
  $("langList").innerHTML = languages.map((l) => `
    <label class="perm"><input type="checkbox" value="${l.code}"${cfg.languages.includes(l.code) ? " checked" : ""}>
      ${esc(l.label)} <span class="muted">${esc(l.name)}</span></label>`).join("") +
    `<label class="field inline">Default
      <select id="defaultLang">${cfg.languages.map((c) => {
        const l = languages.find((x) => x.code === c);
        return `<option value="${c}"${c === cfg.defaultLanguage ? " selected" : ""}>${esc(l.label)}</option>`;
      }).join("")}</select></label>`;
}

function renderPanels() {
  $("langPanels").innerHTML = cfg.languages.map((code) => {
    const l = languages.find((x) => x.code === code);
    const chosen = cfg.voices[code] || [];
    const def = catalog.find((v) => v.id === cfg.defaultVoice[code]);
    return `<details class="lang-panel" data-lang="${code}" open>
      <summary><strong>${esc(l.label)}</strong> <span class="muted">${chosen.length} of ${voicesOf(code).length} voices offered${def ? ` · default ${esc(firstName(def))}` : ""}</span></summary>
      <div class="panel-body">
        <input type="search" class="voice-filter" placeholder="Filter ${esc(l.name)} voices by name, accent or style…" value="${esc(filters[code] || "")}">
        <div class="table-wrap voice-table"><table class="data">
          <thead><tr><th title="Offered to guests">Offer</th><th>Default</th><th>Voice</th><th>Style</th><th></th></tr></thead>
          <tbody>${voiceRows(code)}</tbody>
        </table></div>
        <label class="field">Greeting <span class="muted hint">— <code>{salutation}</code> becomes Buongiorno/Good morning… by time of day, <code>{name}</code> the voice's first name</span>
          <textarea class="greeting" rows="2" maxlength="400">${esc(cfg.greetings[code] || l.defaultGreeting)}</textarea>
        </label>
      </div>
    </details>`;
  }).join("");
}

function voiceRows(code) {
  const q = (filters[code] || "").toLowerCase();
  const chosen = cfg.voices[code] || [];
  const list = voicesOf(code)
    .filter((v) => !q || `${v.name} ${v.label} ${v.accent} ${v.language}`.toLowerCase().includes(q))
    .sort((a, b) => chosen.includes(b.id) - chosen.includes(a.id) || a.name.localeCompare(b.name));
  if (!list.length) return '<tr><td colspan="5" class="empty">No voice matches.</td></tr>';
  return list.map((v) => {
    const on = chosen.includes(v.id);
    const gender = v.gender.startsWith("f") ? "♀" : v.gender.startsWith("m") ? "♂" : "";
    return `<tr data-id="${esc(v.id)}"${on ? ' class="on"' : ""}>
      <td><input type="checkbox" class="offer" aria-label="Offer ${esc(v.name)}"${on ? " checked" : ""}></td>
      <td><input type="radio" class="default" name="def_${code}" aria-label="Default voice"${cfg.defaultVoice[code] === v.id ? " checked" : ""}${on ? "" : " disabled"}></td>
      <td><strong>${esc(v.name)}</strong> ${gender}<div class="muted hint">${esc([v.accent, v.language].filter(Boolean).join(" · "))}</div></td>
      <td class="muted hint">${esc(v.label)}</td>
      <td><button type="button" class="btn ghost small preview">▶</button></td>
    </tr>`;
  }).join("");
}

function refreshPanel(code) {
  const panel = document.querySelector(`.lang-panel[data-lang="${code}"]`);
  if (!panel) return;
  panel.querySelector("tbody").innerHTML = voiceRows(code);
  const chosen = cfg.voices[code] || [];
  const def = catalog.find((v) => v.id === cfg.defaultVoice[code]);
  panel.querySelector("summary .muted").textContent =
    `${chosen.length} of ${voicesOf(code).length} voices offered${def ? ` · default ${firstName(def)}` : ""}`;
}

$("langList").addEventListener("change", (e) => {
  if (e.target.id === "defaultLang") {
    cfg.defaultLanguage = e.target.value;
    return;
  }
  const code = e.target.value;
  cfg.languages = e.target.checked ? [...cfg.languages, code] : cfg.languages.filter((c) => c !== code);
  cfg.languages.sort((a, b) => languages.findIndex((l) => l.code === a) - languages.findIndex((l) => l.code === b));
  if (!cfg.languages.includes(cfg.defaultLanguage)) cfg.defaultLanguage = cfg.languages[0];
  renderLangList();
  renderPanels();
});

$("langPanels").addEventListener("input", (e) => {
  const panel = e.target.closest(".lang-panel");
  if (!panel) return;
  const code = panel.dataset.lang;
  if (e.target.classList.contains("voice-filter")) {
    filters[code] = e.target.value;
    panel.querySelector("tbody").innerHTML = voiceRows(code);
  } else if (e.target.classList.contains("greeting")) {
    cfg.greetings[code] = e.target.value;
  }
});

$("langPanels").addEventListener("change", (e) => {
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  const code = row.closest(".lang-panel").dataset.lang;
  const id = row.dataset.id;
  const chosen = new Set(cfg.voices[code] || []);
  if (e.target.classList.contains("offer")) {
    if (e.target.checked) chosen.add(id); else chosen.delete(id);
    cfg.voices[code] = [...chosen];
    if (!chosen.has(cfg.defaultVoice[code])) cfg.defaultVoice[code] = cfg.voices[code][0] ?? null;
  } else if (e.target.classList.contains("default")) {
    cfg.defaultVoice[code] = id;
  }
  refreshPanel(code);
});

let previewAudio = null;
$("langPanels").addEventListener("click", async (e) => {
  const btn = e.target.closest("button.preview");
  if (!btn) return;
  const row = btn.closest("tr[data-id]");
  const code = row.closest(".lang-panel").dataset.lang;
  const voice = catalog.find((v) => v.id === row.dataset.id);
  const template = cfg.greetings[code] || languages.find((l) => l.code === code).defaultGreeting;
  const text = template.replaceAll("{salutation}", SAMPLE_SALUTATION[code] || "Hello").replaceAll("{name}", firstName(voice));
  previewAudio?.pause();
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: voice.id, language: code }),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}`);
    previewAudio = new Audio(URL.createObjectURL(await res.blob()));
    await previewAudio.play();
  } catch (err) {
    $("widgetError").textContent = `Preview failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "▶";
  }
});

$("saveWidget").addEventListener("click", () => saving($("saveWidget"), $("widgetError"), $("widgetOk"), async () => {
  const body = {
    languages: cfg.languages,
    defaultLanguage: cfg.defaultLanguage,
    voices: Object.fromEntries(cfg.languages.map((c) => [c, cfg.voices[c] || []])),
    defaultVoice: cfg.defaultVoice,
    greetings: cfg.greetings,
  };
  cfg = (await api("PUT", "/api/admin/concierge", body)).config;
  renderLangList();
  renderPanels();
  return "Saved — guests see the new choices on their next page load.";
}));

// ============================================================
// Telnyx AI Assistant (live)
// ============================================================
function fillAssistant(a) {
  $("assistantSub").innerHTML = `Live settings of <strong>${esc(a.name)}</strong> on Telnyx — version <span class="mono">${esc(a.version)}</span>${a.versionCreatedAt ? `, ${esc(new Date(a.versionCreatedAt).toLocaleString())}` : ""}. Changes apply from the next call.`;

  const models = a.models.some((m) => m.id === a.prompt.model) ? a.models : [{ id: a.prompt.model, recommended: false }, ...a.models];
  $("model").innerHTML = models.map((m) => `<option value="${esc(m.id)}"${m.id === a.prompt.model ? " selected" : ""}>${esc(m.id)}${m.recommended ? " ★ recommended" : ""}</option>`).join("");
  $("instructions").value = a.prompt.instructions;
  countPrompt();

  $("expressive").checked = a.voice.expressive_mode;
  $("background").value = a.voice.background === "office" ? "office" : "silence";
  $("volume").value = a.voice.background_volume;
  $("currentVoice").textContent = a.voice.current || "—";
  showRange("volume", "volumeOut");

  const l = a.listening;
  $("sttModel").textContent = l.transcription_model || "—";
  $("eot").value = l.eot_threshold;
  $("eotTimeout").value = l.eot_timeout_ms;
  $("interruptPrediction").value = l.interrupt_prediction_threshold;
  $("idleReply").value = l.user_idle_reply_secs ?? "";
  $("timeLimit").value = l.time_limit_secs;
  $("interruptions").checked = l.interruptions;
  $("greetingLock").checked = l.disable_greeting_interruption;
  showRange("eot", "eotOut");
  showRange("interruptPrediction", "ipOut");

  const av = a.avatar;
  const avatarList = a.avatars.some((v) => v.id === av.avatar_id) ? a.avatars : [{ id: av.avatar_id, name: av.avatar_id }, ...a.avatars];
  $("avatarEnabled").checked = av.enabled;
  $("avatarId").innerHTML = avatarList.map((v) => `<option value="${esc(v.id)}"${v.id === av.avatar_id ? " selected" : ""}>${esc(v.name)}${v.type === "custom" ? " (custom)" : ""}</option>`).join("");
  $("avatarBackground").innerHTML = a.avatarBackgrounds.map((b) => `<option value="${esc(b)}"${b === av.background_id ? " selected" : ""}>${esc(b[0].toUpperCase() + b.slice(1))}</option>`).join("");

  $("kbEnabled").checked = a.knowledge.enabled;
  $("kbResults").value = a.knowledge.max_num_results;
  $("kbBucket").value = a.knowledge.bucket;
  const files = a.knowledgeFiles;
  $("kbFiles").innerHTML = Array.isArray(files) && files.length
    ? files.map((f) => `<tr><td class="mono">${esc(f.filename)}</td>
        <td><span class="chip ${f.status === "success" ? "ok" : /fail/.test(f.status) ? "err" : "warn"}">${esc(f.status)}</span>${f.error ? ` <span class="muted hint">${esc(f.error)}</span>` : ""}</td>
        <td class="muted">${f.embeddedAt ? esc(new Date(`${f.embeddedAt}Z`).toLocaleString()) : "—"}</td></tr>`).join("")
    : `<tr><td colspan="3" class="empty">${files?.error ? esc(files.error) : "No embedded files in this bucket."}</td></tr>`;
}

function showRange(input, output) {
  $(output).textContent = Number($(input).value).toFixed(input === "volume" ? 1 : 2);
}
[["volume", "volumeOut"], ["eot", "eotOut"], ["interruptPrediction", "ipOut"]].forEach(([i, o]) =>
  $(i).addEventListener("input", () => showRange(i, o)));

function countPrompt() {
  $("promptCount").textContent = `— ${$("instructions").value.length.toLocaleString()} characters`;
}
$("instructions").addEventListener("input", countPrompt);

const SECTIONS = {
  prompt: () => ({ model: $("model").value, instructions: $("instructions").value }),
  voice: () => ({ expressive_mode: $("expressive").checked, background: $("background").value, background_volume: Number($("volume").value) }),
  listening: () => ({
    eot_threshold: Number($("eot").value),
    eot_timeout_ms: Number($("eotTimeout").value),
    interrupt_prediction_threshold: Number($("interruptPrediction").value),
    user_idle_reply_secs: $("idleReply").value === "" ? null : Number($("idleReply").value),
    time_limit_secs: Number($("timeLimit").value),
    interruptions: $("interruptions").checked,
    disable_greeting_interruption: $("greetingLock").checked,
  }),
  knowledge: () => ({ enabled: $("kbEnabled").checked, max_num_results: Number($("kbResults").value) }),
  avatar: () => ({ enabled: $("avatarEnabled").checked, avatar_id: $("avatarId").value, background_id: $("avatarBackground").value }),
};

document.querySelectorAll("[data-save]").forEach((button) => {
  const section = button.dataset.save;
  const errorEl = document.querySelector(`[data-error="${section}"]`);
  const okEl = document.querySelector(`[data-ok="${section}"]`);
  button.addEventListener("click", () => saving(button, errorEl, okEl, async () => {
    if (section === "prompt" && !confirm("Replace the assistant's live prompt and model?")) return "";
    const a = await api("PATCH", `/api/admin/assistant/${section}`, SECTIONS[section]());
    fillAssistant(a);
    return `Saved — Telnyx version ${a.version}`;
  }));
});

// ============================================================
// Load
// ============================================================
async function load() {
  $("loadError").textContent = "";
  const [widget, assistant] = await Promise.allSettled([api("GET", "/api/admin/concierge"), api("GET", "/api/admin/assistant")]);
  if (widget.status === "fulfilled") {
    ({ languages, voices: catalog, config: cfg } = widget.value);
    renderLangList();
    renderPanels();
  } else {
    $("loadError").textContent = `Languages & voices: ${widget.reason.message}`;
  }
  if (assistant.status === "fulfilled") fillAssistant(assistant.value);
  else $("loadError").textContent += ` Assistant: ${assistant.reason.message}`;
}
$("reloadBtn").addEventListener("click", () => load());
load();
