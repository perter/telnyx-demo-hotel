// ============================================================
// TelnyxHotel virtual reception: a realtime conversation with the Telnyx AI
// Assistant over /ws/assistant. The guest picks a language and an Ultra voice
// from the admin's shortlists (/api/concierge), saved per user in a cookie
// (/api/prefs). Booking tools (update_booking, check_availability,
// confirm_booking) run here, in the page; confirming sends the recap e-mail
// and the SMS / WhatsApp. The video avatar (beta) arrives over WebRTC,
// negotiated on the same socket (avatar.* frames). The page copy follows the
// language the guest speaks.
// ============================================================

const INPUT_RATE = 16000;

const $ = (id) => document.getElementById(id);
const t = (key, vars) => I18N.t(key, vars);
const ui = {
  voice: $("voice"), langSelect: $("langSelect"), previewBtn: $("previewBtn"), voiceInfo: $("voiceInfo"),
  langBadge: $("langBadge"),
  callBtn: $("callBtn"), callLabel: $("callBtn").querySelector(".call-label"), muteBtn: $("muteBtn"),
  callState: $("callState"), status: $("status"), chat: $("chat"),
  textForm: $("textForm"), textInput: $("textInput"),
  micLevel: $("micLevel"), agentLevel: $("agentLevel"), agentLabel: $("agentLabel"),
  bookingState: $("bookingState"), availability: $("availability"), availabilityList: $("availabilityList"),
  confirmation: $("confirmation"), confirmCode: $("confirmCode"), recapInfo: $("recapInfo"), smsInfo: $("smsInfo"),
  // Page chrome (booking page)
  header: $("siteHeader"), launcher: $("launcher"), panel: $("concierge-panel"), closePanel: $("closeConcierge"),
  avatar: $("avatar"), summaryPhoto: $("summaryPhoto"), summaryCta: $("summaryCta"),
  avatarStage: $("avatarStage"), avatarVideo: $("avatarVideo"),
  roomsEmpty: $("roomsEmpty"), bar: $("bookingBar"), barHotel: $("barHotel"), barCheckIn: $("barCheckIn"),
  barCheckOut: $("barCheckOut"), barAdults: $("barAdults"), barChildren: $("barChildren"),
};

let concierge = null; // { defaultLanguage, languages: [{ code, name, label, greeting, defaultVoice, voices }] }
let startLang = "en";

// Live events for the flow diagram page (/flow.html), if it's open.
const flowChannel = "BroadcastChannel" in window ? new BroadcastChannel("telnyxhotel-flow") : null;
function emitFlow(type, detail = {}) {
  try { flowChannel?.postMessage({ type, detail, at: Date.now() }); } catch { /* ignore */ }
}

// ============================================================
// Languages & flags
// ============================================================

// Enabled languages, filled from /api/concierge. A language without page copy
// (no i18n/<lang>.js) shows the page in English.
let LANGS = {};
const pageLang = (lang) => (I18N.has(lang) ? lang : "en");

let flagSeq = 0;
const STRIPES = {
  it: ["v", "#009246", "#fff", "#ce2b37"],
  fr: ["v", "#002395", "#fff", "#ed2939"],
  de: ["h", "#000", "#dd0000", "#ffce00"],
  es: ["h", "#aa151b", "#f1bf00", "#f1bf00", "#aa151b"],
  nl: ["h", "#ae1c28", "#fff", "#21468b"],
};
function flagSvg(lang) {
  const stripes = STRIPES[lang];
  if (stripes) {
    const [dir, ...colors] = stripes;
    const n = colors.length;
    const rects = colors.map((c, i) => (dir === "v"
      ? `<rect x="${i}" width="1" height="${n * 2 / 3}" fill="${c}"/>`
      : `<rect y="${i}" width="${n * 1.5}" height="1" fill="${c}"/>`)).join("");
    return `<svg viewBox="0 0 ${dir === "v" ? `${n} ${n * 2 / 3}` : `${n * 1.5} ${n}`}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
  }
  const id = `uk${++flagSeq}`; // clip-path ids must be unique per instance
  return `<svg viewBox="0 0 60 30" preserveAspectRatio="none" aria-hidden="true"><clipPath id="${id}s"><path d="M0,0 v30 h60 v-30 z"/></clipPath><clipPath id="${id}t"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath><g clip-path="url(#${id}s)"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#${id}t)" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></g></svg>`;
}
document.querySelectorAll(".flag[data-lang]").forEach((el) => (el.innerHTML = flagSvg(el.dataset.lang)));

// One flag and code per enabled language in the header badge.
function renderLangBadge() {
  const stack = ui.langBadge.querySelector(".flag-stack");
  const names = ui.langBadge.querySelector(".lang-names");
  stack.replaceChildren();
  names.replaceChildren();
  for (const code of Object.keys(LANGS)) {
    const flag = document.createElement("span");
    flag.className = "flag";
    flag.dataset.lang = code;
    flag.innerHTML = flagSvg(code);
    const name = document.createElement("span");
    name.dataset.lang = code;
    name.textContent = code.toUpperCase();
    stack.append(flag);
    names.append(name);
  }
}

function renderLangOptions() {
  ui.langSelect.replaceChildren(...Object.values(LANGS).map((l) => new Option(l.label, l.code)));
  ui.langSelect.value = startLang;
}

function setStartLang(lang, voice) {
  if (!LANGS[lang]) return;
  startLang = lang;
  ui.langSelect.value = lang;
  setPageLang(pageLang(lang));
  renderVoiceOptions(voice);
}

// The user's language and voice, kept by the server in a cookie.
const savePrefs = () => fetch("/api/prefs", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang: startLang, voice: ui.voice.value }),
}).then((res) => { if (!res.ok) throw new Error(`prefs ${res.status}`); });

// The whole site follows the reception's language: the one chosen here, and any
// switch the guest makes while speaking.
function setPageLang(lang) {
  if (I18N.lang === lang) return;
  I18N.set(lang);
  I18N.apply();
  renderBooking();
  if (concierge) renderLangOptions();
  showVoiceInfo();
  if (lastStatus) setStatus(lastStatus.key, lastStatus.error, lastStatus.vars);
}
ui.langSelect.addEventListener("change", () => {
  if (call) return;
  setStartLang(ui.langSelect.value);
  savePrefs().catch(() => {});
});

// Cross-fade the badge to the detected language.
let shownLang = null;
function showDetectedLang(lang, { animate = true } = {}) {
  if (!LANGS[lang] || lang === shownLang) return;
  const changed = shownLang !== null;
  shownLang = lang;
  ui.langBadge.hidden = false;
  ui.langBadge.querySelectorAll("[data-lang]").forEach((el) => el.classList.toggle("on", el.dataset.lang === lang));
  ui.langBadge.title = LANGS[lang].label;
  setPageLang(pageLang(lang));
  if (changed && animate) {
    ui.langBadge.classList.remove("changed");
    void ui.langBadge.offsetWidth; // restart the ping animation
    ui.langBadge.classList.add("changed");
    emitFlow("lang_change", { lang });
  }
}
function hideDetectedLang() {
  shownLang = null;
  ui.langBadge.hidden = true;
  ui.langBadge.classList.remove("changed");
}

// ============================================================
// Voices (Telnyx Ultra, expressive mode)
// ============================================================

async function loadConcierge() {
  try {
    const res = await fetch("/api/concierge");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    concierge = await res.json();
  } catch (err) {
    ui.voice.replaceChildren(new Option(t("voice.unavailable")));
    ui.langSelect.replaceChildren(new Option("—"));
    setStatus("status.voicesError", true, { error: err.message });
    return;
  }
  LANGS = Object.fromEntries(concierge.languages.map((l) => [l.code, l]));
  renderLangBadge();
  renderLangOptions();
  setStartLang(concierge.preferred.lang, concierge.preferred.voice);
}

const langVoices = () => LANGS[startLang]?.voices || [];

function renderVoiceOptions(preferred) {
  if (!concierge) return;
  const list = langVoices();
  ui.voice.replaceChildren(...list.map((v) => {
    const gender = v.gender.startsWith("f") ? "♀" : v.gender.startsWith("m") ? "♂" : "";
    const option = new Option(`${receptionist(v).name} ${gender}`.trim(), v.id);
    option.title = v.name;
    return option;
  }));
  const has = (id) => list.some((v) => v.id === id);
  ui.voice.value = has(preferred) ? preferred : has(LANGS[startLang].defaultVoice) ? LANGS[startLang].defaultVoice : list[0]?.id ?? "";

  const usable = list.length > 0 && !call;
  ui.voice.disabled = ui.previewBtn.disabled = !usable;
  ui.langSelect.disabled = !!call || Object.keys(LANGS).length < 2;
  ui.callBtn.disabled = !list.length || (call && !call.started);
  if (!list.length) ui.voice.replaceChildren(new Option(t("voice.none")));
  showVoiceInfo();
}

const currentVoice = () => langVoices().find((v) => v.id === ui.voice.value);

// The receptionist introduces themself with the voice's first name.
function receptionist(voice) {
  const female = voice?.gender.startsWith("f");
  const name = voice ? voice.name.split(" - ")[0].trim() : "Reception";
  return { name, gender: female ? "female" : "male" };
}

// Time-of-day salutation in the call's language.
function salutation(lang) {
  const h = new Date().getHours();
  return {
    it: h < 17 ? "Buongiorno" : "Buonasera",
    en: h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening",
    fr: h < 18 ? "Bonjour" : "Bonsoir",
    de: h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend",
    es: h < 12 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches",
    nl: h < 12 ? "Goedemorgen" : h < 18 ? "Goedemiddag" : "Goedenavond",
  }[lang] || "Hello";
}

function greetingText(name, lang = startLang) {
  const template = LANGS[lang]?.greeting || "{salutation}! I'm {name}. How may I help you?";
  return template.replaceAll("{salutation}", salutation(lang)).replaceAll("{name}", name);
}

function showVoiceInfo() {
  const v = currentVoice();
  const r = receptionist(v);
  ui.voiceInfo.textContent = v ? [v.label, t("voice.intro", { name: r.name })].filter(Boolean).join(" · ") : "";
  ui.agentLabel.textContent = v ? r.name : t("meters.agent");
  ui.avatar.textContent = v ? r.name.charAt(0) : "T";
}

ui.voice.addEventListener("change", () => {
  savePrefs().catch(() => {});
  showVoiceInfo();
});

let previewAudio = null;
ui.previewBtn.addEventListener("click", async () => {
  const v = currentVoice();
  if (!v) return;
  previewAudio?.pause();
  ui.previewBtn.disabled = true;
  ui.previewBtn.textContent = "…";
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: greetingText(receptionist(v).name), voice: v.id, language: startLang }),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}`);
    previewAudio = new Audio(URL.createObjectURL(await res.blob()));
    await previewAudio.play();
  } catch (err) {
    console.error("Preview failed:", err);
    setStatus("status.previewError", true);
  } finally {
    ui.previewBtn.disabled = !!call;
    ui.previewBtn.textContent = t("voice.preview");
  }
});

// ============================================================
// Call lifecycle
// ============================================================

let call = null; // see startCall()

ui.callBtn.addEventListener("click", () => (call ? endCall("status.ended") : startCall()));

async function startCall() {
  const voice = currentVoice();
  if (!voice) return;
  previewAudio?.pause();
  setCallState("busy", "pill.connecting");
  setStatus("");
  ui.callBtn.disabled = true;
  ui.voice.disabled = ui.previewBtn.disabled = ui.langSelect.disabled = true;
  emitFlow("call_start", { voice: voice.name, voiceId: voice.id, lang: startLang });

  // Create/resume the AudioContext synchronously inside the click, before any
  // await: after a slow mic-permission prompt the user activation has expired
  // and resume() would never resolve.
  const ctx = new AudioContext();
  ctx.resume().catch(() => {});
  const prefsSaved = savePrefs(); // the server takes the call's voice from the cookie

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await prefsSaved;
  } catch (err) {
    console.error("Call setup failed:", err);
    stream?.getTracks().forEach((tr) => tr.stop());
    ctx.close();
    resetCallUI();
    setStatus(stream ? "status.failed" : "status.micDenied", true);
    return;
  }

  // Playback chain: scheduled PCM buffers → gain → analyser → speakers
  const out = ctx.createGain();
  const agentAnalyser = ctx.createAnalyser();
  agentAnalyser.fftSize = 512;
  out.connect(agentAnalyser).connect(ctx.destination);

  // Capture chain: mic → analyser, mic → processor (→ muted sink so it runs)
  const source = ctx.createMediaStreamSource(stream);
  const micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 512;
  source.connect(micAnalyser);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(processor).connect(sink).connect(ctx.destination);

  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/assistant?` +
    new URLSearchParams({ input_sample_rate: String(INPUT_RATE) });
  const ws = new WebSocket(url);

  call = {
    ws, ctx, stream, processor, out, micAnalyser, agentAnalyser, voice, lang: startLang,
    started: false, muted: false, outputRate: 24000, lastMicFlow: 0, lastAudioFlow: 0,
    nextPlayTime: 0, sources: new Set(), bubbles: new Map(), raf: 0,
    avatarExpected: false, avatar: null, openedAt: performance.now(),
  };
  const me = call;

  processor.onaudioprocess = (e) => {
    if (!me.started || ws.readyState !== WebSocket.OPEN) return;
    const pcm = downsampleToInt16(e.inputBuffer.getChannelData(0), ctx.sampleRate, INPUT_RATE);
    if (me.muted) pcm.fill(0); // keep the stream flowing, but silent
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToBase64(new Uint8Array(pcm.buffer)) }));
    if (!me.muted && performance.now() - me.lastMicFlow > 400) {
      me.lastMicFlow = performance.now();
      emitFlow("mic_audio", { bytes: pcm.byteLength });
    }
  };

  ws.onopen = () => {
    const r = receptionist(voice);
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        assistant: {
          dynamic_variables: {
            receptionist_name: r.name,
            receptionist_gender: r.gender,
            today: todayForAssistant(),
            start_language: LANGS[startLang].name,
            languages: Object.values(LANGS).map((l) => l.name).join(", "),
            greeting: greetingText(r.name),
          },
        },
      },
    }));
    emitFlow("ws_open");
  };
  ws.onmessage = (e) => {
    if (me !== call) return;
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    handleEvent(event).catch((err) => console.error("Event handling failed:", err));
  };
  ws.onclose = () => { if (me === call) endCall(me.started ? "status.ended" : "status.failed"); };

  // Give up if the conversation hasn't started within 20 s (60 s with the
  // video avatar, which Telnyx gives a minute to set up).
  const giveUp = () => {
    if (me !== call || me.started) return;
    const wait = (me.avatarExpected ? 60_000 : 20_000) - (performance.now() - me.openedAt);
    if (wait > 0) return void setTimeout(giveUp, wait);
    setCallState("error", "pill.error");
    setStatus("status.noAnswer", true);
    endCall(null);
  };
  setTimeout(giveUp, 20_000);

  meterLoop(me);
}

function endCall(message) {
  const c = call;
  if (!c) return;
  call = null;
  cancelAnimationFrame(c.raf);
  stopPlayback(c);
  stopAvatar(c);
  c.processor.onaudioprocess = null;
  c.stream.getTracks().forEach((t) => t.stop());
  c.ctx.close();
  if (c.ws.readyState <= WebSocket.OPEN) c.ws.close();
  emitFlow("call_end");
  resetCallUI();
  if (message && !ui.status.classList.contains("error")) setStatus(message);
}

function resetCallUI() {
  ui.callBtn.disabled = false;
  ui.callBtn.classList.remove("active");
  setText(ui.callLabel, "call.start");
  ui.muteBtn.hidden = true;
  ui.launcher.classList.remove("live");
  ui.panel.classList.remove("in-call");
  setText(ui.launcher.querySelector(".launcher-text"), "widget.launcher");
  hideDetectedLang();
  renderVoiceOptions(ui.voice.value);
  ui.textInput.disabled = true;
  ui.textForm.querySelector("button").disabled = true;
  ui.micLevel.style.width = ui.agentLevel.style.width = "0%";
  if (!ui.callState.classList.contains("error")) setCallState("idle", "pill.ready");
}

ui.muteBtn.addEventListener("click", () => {
  if (!call) return;
  call.muted = !call.muted;
  ui.muteBtn.classList.toggle("muted", call.muted);
  setText(ui.muteBtn, call.muted ? "mic.off" : "mic.on");
});

ui.textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ui.textInput.value.trim();
  if (!text || !call?.started) return;
  call.ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  }));
  call.lastSent = { text, at: performance.now() };
  addMessage("user", text);
  emitFlow("user_text", { text });
  noteGuestLanguage(text);
  ui.textInput.value = "";
});

// ============================================================
// Realtime events
// ============================================================

// Debug: open the page with ?debug to record raw transcript frames
// (window.__transcriptFrames) and log them to the console.
const DEBUG = new URLSearchParams(location.search).has("debug");
if (DEBUG) window.__transcriptFrames = [];

// One chat bubble per assistant response. Chunks without a response_id belong
// to the response in progress, so they never open a second bubble.
function agentText(c, responseId, chunk) {
  const id = responseId || c.currentResponse || "current";
  if (responseId) c.currentResponse = responseId;
  let bubble = c.bubbles.get(id);
  if (!bubble) {
    bubble = addMessage("agent", "");
    bubble.assembler = TranscriptMerge.createAssembler();
    c.bubbles.set(id, bubble);
  }
  bubble.assembler.add(chunk);
  renderAgentBubble(bubble, true);
}

// Expressive voices get markup in the reply (<emotion value="happy" />, <break …/>):
// spoken, never shown. A tag still arriving at the end of a live chunk is held back.
const spokenOnly = (text) => text.replace(/<\/?(?:emotion|break|prosody|speak|say-as|emphasis)\b[^>]*>/gi, "").replace(/<[a-z][^>]*$/i, "").replace(/[ \t]{2,}/g, " ").trim();

function renderAgentBubble(bubble, live) {
  const text = spokenOnly(bubble.assembler.text({ live }));
  const shown = bubble.text.textContent;
  // While streaming, never jump backwards (e.g. from the early LLM text to the first spoken word).
  if (text === shown || (live && shown.startsWith(text))) return;
  bubble.text.textContent = text;
  scrollChat();
  emitFlow("agent_text", { text });
}

async function handleEvent(event) {
  const c = call;
  if (DEBUG && /transcript|response\.(created|done)/.test(event.type)) {
    window.__transcriptFrames.push(event);
    console.debug("[transcript]", JSON.stringify(event));
  }
  switch (event.type) {
    // From our proxy: whether this call uses the video avatar.
    case "telnyxhotel.call":
      c.avatarExpected = !!event.avatar;
      c.callId = event.callId || null;
      if (c.avatarExpected) showAvatarStage(true);
      break;

    case "avatar.session.ready":
      await startAvatar(c, event);
      break;

    case "avatar.webrtc.answer":
      await c.avatar?.pc.setRemoteDescription(event.answer);
      break;

    case "avatar.error": {
      const fatal = !!event.error?.fatal;
      console.warn("Avatar error:", event.error?.reason, event.error?.message);
      stopAvatar(c);
      // Before the call starts it's fatal (Telnyx closes the socket); later the call goes on, voice only.
      setStatus(fatal ? "status.videoFailed" : "status.videoLost", fatal);
      break;
    }

    case "session.created":
      c.started = true;
      c.outputRate = event.session?.audio?.output?.format?.rate || c.outputRate;
      ui.callBtn.disabled = false;
      ui.callBtn.classList.add("active");
      setText(ui.callLabel, "call.end");
      ui.muteBtn.hidden = false;
      ui.textInput.disabled = false;
      ui.textForm.querySelector("button").disabled = false;
      setCallState("live", "pill.live");
      ui.launcher.classList.add("live");
      ui.panel.classList.add("in-call");
      setText(ui.launcher.querySelector(".launcher-text"), "widget.live");
      clearChatPlaceholder();
      showDetectedLang(c.lang, { animate: false });
      emitFlow("session_created", { rate: c.outputRate });
      break;

    case "input_audio_buffer.speech_started":
      if (c.sources.size) emitFlow("barge_in");
      stopPlayback(c); // barge-in: drop queued assistant audio
      setCallState("live", "pill.listening");
      emitFlow("speech_started");
      break;

    case "input_audio_buffer.speech_stopped":
      setCallState("live", "pill.live");
      emitFlow("speech_stopped");
      break;

    case "conversation.item.input_audio_transcription.completed":
      // Telnyx echoes typed text (and form notes) back as a transcription: shown already.
      if (c.lastSent && c.lastSent.text === event.transcript?.trim() && performance.now() - c.lastSent.at < 5000) {
        c.lastSent = null;
        break;
      }
      if (event.transcript?.trim()) {
        addMessage("user", event.transcript.trim());
        // Prefer a language reported by Telnyx, fall back to our detector.
        const reported = String(event.language || event.detected_language || "").slice(0, 2).toLowerCase();
        emitFlow("user_transcript", { text: event.transcript.trim() });
        noteGuestLanguage(event.transcript, LANGS[reported] ? reported : null);
      }
      break;

    case "response.output_audio.delta":
      if (!c.avatar) playPcm(c, base64ToBytes(event.delta)); // the avatar brings its own audio
      if (performance.now() - c.lastAudioFlow > 300) {
        c.lastAudioFlow = performance.now();
        emitFlow("agent_audio", { voice: c.voice.name });
      }
      break;

    case "response.created":
      c.currentResponse = event.response?.id || c.currentResponse;
      break;

    case "response.output_audio_transcript.delta":
      agentText(c, event.response_id, event.delta);
      break;

    case "response.done": {
      const bubble = c.bubbles.get(event.response?.id);
      if (bubble?.assembler) renderAgentBubble(bubble, false); // complete text, gaps filled
      if (event.response?.status === "cancelled") bubble?.el.classList.add("cancelled");
      emitFlow("response_done", { status: event.response?.status });
      break;
    }

    case "conversation.item.created":
      if (event.item?.type === "function_call") await runClientTool(event.item);
      break;

    case "response.tool_call.started":
      addToolNote(toolLabel(event.tool_call?.name));
      emitFlow("server_tool", { name: event.tool_call?.name });
      break;

    case "error": {
      const { code, message } = event.error || {};
      console.error("Assistant error:", code, message);
      if (code === "conversation_ended") break; // normal end (e.g. hangup tool)
      setCallState("error", "pill.error");
      setStatus(message || code || "error", true);
      break;
    }
  }
}

// Update the detected-language flag from something the guest said or typed:
// the language Telnyx reported, or else our own guess among the enabled ones.
function noteGuestLanguage(text, reported = null) {
  const lang = reported || LangDetect.detect(text, Object.keys(LANGS));
  if (lang && LANGS[lang] && call) {
    call.lang = lang;
    showDetectedLang(lang);
  }
}

// ============================================================
// Client-side tools
// ============================================================

const booking = {};
let lastAvailability = null;
let confirmedCode = null;

const TOOLS = {
  update_booking(args) {
    const errors = [];
    const next = { ...booking };
    const { HOTELS, ROOMS, parseISO } = Booking;

    for (const [k, raw] of Object.entries(args || {})) {
      if (raw == null || raw === "") continue;
      const val = typeof raw === "string" ? raw.trim() : raw;
      switch (k) {
        case "hotel":
          HOTELS[val] ? (next.hotel = val) : errors.push(`unknown hotel "${val}"`);
          break;
        case "room_type":
          ROOMS[val] ? (next.room_type = val) : errors.push(`unknown room_type "${val}"`);
          break;
        case "check_in":
        case "check_out":
          parseISO(val) ? (next[k] = val) : errors.push(`${k} must be YYYY-MM-DD`);
          break;
        case "adults":
        case "children": {
          const n = Number(val);
          Number.isInteger(n) && n >= (k === "adults" ? 1 : 0) ? (next[k] = n) : errors.push(`invalid ${k}`);
          break;
        }
        case "guest_name":
        case "phone":
        case "email":
        case "special_requests":
          next[k] = String(val).slice(0, 200);
          break;
      }
    }

    // Once hotel, dates and party are known, the stay must be valid and the room must fit.
    if (next.hotel && next.check_in && next.check_out && next.adults) {
      const avail = Booking.checkAvailability(next);
      if (!avail.ok) errors.push(...avail.errors);
      else {
        lastAvailability = avail;
        const room = next.room_type && avail.rooms.find((r) => r.room_type === next.room_type);
        if (room && !room.available) {
          errors.push(`${room.name} is not available: ${room.reason}`);
          delete next.room_type;
        }
      }
    }

    const changedKeys = Object.keys(next).filter((k) => next[k] !== booking[k]);
    const changed = changedKeys.length > 0;
    Object.keys(booking).forEach((k) => delete booking[k]);
    Object.assign(booking, next);
    // Changing the stay after confirmation reopens the booking; contact details
    // (e.g. adding an e-mail for the recap) keep the same confirmation code.
    const CONTACT = ["guest_name", "phone", "email", "special_requests"];
    if (confirmedCode && changedKeys.some((k) => !CONTACT.includes(k))) setConfirmed(null);
    renderBooking(changed ? Object.keys(args || {}) : []);

    return {
      ok: errors.length === 0,
      errors,
      booking: bookingSummary(),
      missing: Booking.missingFields(booking),
    };
  },

  check_availability(args) {
    const stay = {
      hotel: args.hotel ?? booking.hotel,
      check_in: args.check_in ?? booking.check_in,
      check_out: args.check_out ?? booking.check_out,
      adults: args.adults ?? booking.adults,
      children: args.children ?? booking.children ?? 0,
    };
    const result = Booking.checkAvailability(stay);
    if (result.ok) {
      lastAvailability = result;
      TOOLS.update_booking(stay); // reflect what was checked in the form
      renderAvailability();
    }
    return result;
  },

  async confirm_booking() {
    const missing = Booking.missingFields(booking);
    if (missing.length) return { confirmed: false, missing };
    const avail = Booking.checkAvailability(booking);
    if (!avail.ok) return { confirmed: false, errors: avail.errors };
    const room = avail.rooms.find((r) => r.room_type === booking.room_type);
    if (!room?.available) return { confirmed: false, errors: [`${room?.name ?? booking.room_type} is not available`] };

    const code = confirmedCode || Booking.confirmationCode();
    setConfirmed(code);
    // The tool has a short budget: wait up to 3 s for the recap e-mail and the
    // SMS, then let the assistant continue (the page still updates when they complete).
    const within3s = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ status: "sending" }), 3000))]);
    const [recapResult, smsResult] = await Promise.all([within3s(sendRecapEmail(code)), within3s(sendConfirmationSms(code))]);
    return {
      confirmed: true,
      confirmation_code: code,
      confirmation_code_spelled: code.split("").join(" "),
      total_eur: room.total_eur,
      booking: bookingSummary(),
      recap_email: recapResult,
      sms_confirmation: smsResult,
    };
  },
};

async function runClientTool(item) {
  let args = item.arguments;
  if (typeof args === "string") {
    try { args = args.trim() ? JSON.parse(args) : {}; } catch { args = {}; }
  }
  emitFlow("tool_start", { name: item.name, args });
  let output;
  try {
    const fn = TOOLS[item.name];
    output = fn ? await fn(args || {}) : { error: `unknown tool ${item.name}` };
  } catch (err) {
    console.error(`Tool ${item.name} failed:`, err);
    output = { error: String(err.message || err) };
  }
  const failed = output.error || output.ok === false || output.confirmed === false;
  addToolNote(toolLabel(item.name), failed);
  emitFlow("tool_call", { name: item.name, args, ok: !failed, output });
  if (DEBUG) console.debug("tool", item.name, args, output);

  if (call?.ws.readyState === WebSocket.OPEN) {
    call.ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output) },
    }));
  }
}

function toolLabel(name) {
  const key = `tool.${name}`;
  return t(key) === key ? `⚙️ ${name}` : t(key);
}

function bookingSummary() {
  const b = booking;
  const room = lastAvailability?.rooms.find((r) => r.room_type === b.room_type);
  return {
    ...b,
    hotel_name: Booking.HOTELS[b.hotel]?.name,
    room_name: Booking.ROOMS[b.room_type]?.name,
    nights: b.check_in && b.check_out ? Booking.nightsBetween(Booking.parseISO(b.check_in), Booking.parseISO(b.check_out)) : undefined,
    price_per_night_eur: room?.price_per_night_eur,
    total_eur: room?.total_eur,
  };
}

// ============================================================
// Booking card rendering
// ============================================================

function renderBooking(changedKeys = []) {
  const s = bookingSummary();
  const guests = s.adults
    ? [t("guests.adults", { n: s.adults }), s.children ? t("guests.children", { n: s.children }) : ""].filter(Boolean).join(", ")
    : null;
  const values = {
    hotel: s.hotel_name,
    check_in: s.check_in && formatDate(s.check_in),
    check_out: s.check_out && formatDate(s.check_out),
    nights: s.nights > 0 ? String(s.nights) : null,
    guests,
    room_type: s.room_name && (s.price_per_night_eur ? `${s.room_name} · ${eur(s.price_per_night_eur)} ${t("room.perNight")}` : s.room_name),
    guest_name: s.guest_name,
    contact: [s.phone, s.email].filter(Boolean).join(" · ") || null,
    special_requests: s.special_requests,
    total: s.total_eur ? eur(s.total_eur) : null,
  };
  const touched = new Set(changedKeys.flatMap((k) =>
    k === "adults" || k === "children" ? ["guests", "total"]
    : k === "phone" || k === "email" ? ["contact"]
    : k === "check_in" || k === "check_out" ? [k, "nights", "total"]
    : k === "room_type" ? ["room_type", "total"] : [k]));

  for (const [field, value] of Object.entries(values)) {
    const row = document.querySelector(`[data-field="${field}"]`);
    row.querySelector("dd").textContent = value || "—";
    if (touched.has(field) && value) flashEl(row);
  }
  if (!confirmedCode) {
    const started = Object.keys(booking).length > 0;
    setPill(ui.bookingState, started ? "busy" : "idle", started ? "pill.progress" : "pill.waiting");
  }
  syncPage(changedKeys);
  renderSteps();
  renderAvailability();
  emitFlow("booking_render", { values, changed: [...touched].filter((f) => values[f]), code: confirmedCode });
}

// The step tracker mirrors the booking flow: each step ticks as soon as the
// assistant (or the guest) fills it in, and the next one becomes active.
const STEPS = [
  ["hotel", () => !!booking.hotel],
  ["dates", () => !!(booking.check_in && booking.check_out)],
  ["guests", () => !!booking.adults],
  ["room", () => !!booking.room_type],
  ["contact", () => !!(booking.guest_name && (booking.email || booking.phone))],
  ["confirm", () => !!confirmedCode],
];

function renderSteps() {
  let activeSet = false;
  for (const [name, done] of STEPS) {
    const li = document.querySelector(`.steps [data-step="${name}"]`);
    const isDone = done();
    const wasDone = li.classList.contains("done");
    li.classList.toggle("done", isDone);
    li.classList.toggle("active", !isDone && !activeSet);
    if (!isDone && !activeSet) activeSet = true;
    if (isDone && !wasDone) flashEl(li, 1600);
  }
}

function renderAvailability() {
  const a = lastAvailability;
  const matches = a && a.hotel === booking.hotel && a.check_in === booking.check_in && a.check_out === booking.check_out;
  ui.availability.hidden = !matches;
  ui.roomsEmpty.hidden = !!matches;
  if (!matches) return;
  ui.availabilityList.replaceChildren(...a.rooms.map((r) => {
    const li = document.createElement("li");
    li.className = "room";
    li.classList.toggle("soldout", !r.available);
    li.classList.toggle("selected", r.room_type === booking.room_type);

    const img = document.createElement("img");
    img.src = `assets/${a.hotel}.jpg`;
    img.alt = "";
    img.loading = "lazy";
    // One photo per hotel: show a different crop for each room type.
    img.style.objectPosition = { essential: "15% 70%", deluxe: "45% 45%", family_studio: "75% 35%", skyline_suite: "50% 10%" }[r.room_type] || "center";

    const info = document.createElement("div");
    const h = document.createElement("h4");
    h.textContent = r.name;
    const meta = document.createElement("p");
    meta.className = "room-meta";
    meta.textContent = `${t(`room.${r.room_type}`)} · ${t("room.upTo", { n: r.max_guests })}`;
    info.append(h, meta);

    const price = document.createElement("div");
    price.className = "room-price";
    const per = document.createElement("div");
    per.className = "per-night";
    per.innerHTML = `${eur(r.price_per_night_eur)} <small>${t("room.perNight")}</small>`;
    const total = document.createElement("div");
    total.className = "room-total";
    total.textContent = r.available
      ? t("room.forNights", { price: eur(r.total_eur), n: a.nights, nights: t("nights", { n: a.nights }) })
      : t("room.unavailable");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = r.room_type === booking.room_type ? "btn btn-primary btn-small" : "btn btn-outline btn-small";
    btn.textContent = t(r.room_type === booking.room_type ? "room.selected" : "room.select");
    btn.disabled = !r.available;
    btn.addEventListener("click", () => manualEdit({ room_type: r.room_type }, t("edit.room", { name: r.name })));
    price.append(per, total, btn);

    li.append(img, info, price);
    return li;
  }));
}

function setConfirmed(code) {
  confirmedCode = code;
  ui.confirmation.hidden = !code;
  ui.confirmCode.textContent = code || "";
  if (code) setPill(ui.bookingState, "done", "pill.confirmed");
  else setPill(ui.bookingState, "busy", "pill.progress");
  renderSteps();
  emitFlow("booking_confirmed", { code });
  if (!code) ui.recapInfo.hidden = ui.smsInfo.hidden = true;
  ui.summaryCta.hidden = !!code;
}

// Ask the server to e-mail the booking recap in the language the guest is using.
async function sendRecapEmail(code) {
  const lang = pageLang(call?.lang || startLang);
  if (!booking.email) {
    showRecap(t("recap.none"));
    return { sent: false, reason: "no e-mail address on the booking — offer to add one" };
  }
  showRecap(t("recap.sending"));
  emitFlow("recap_start", { to: booking.email, lang });
  try {
    const res = await fetch("/api/booking-recap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking, code, lang }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showRecap(data.sent ? t("recap.sent", { to: data.to }) : t("recap.preview"), data.preview_url);
    emitFlow("recap_done", { ok: true, sent: data.sent, to: data.to, mode: data.mode, lang });
    return data.sent
      ? { sent: true, to: data.guest_email, language: lang }
      : { sent: false, preview_only: true, reason: "demo mode: the e-mail was generated but not delivered; say a confirmation e-mail will follow" };
  } catch (err) {
    console.error("Recap e-mail failed:", err);
    showRecap(t("recap.error", { error: err.message }));
    emitFlow("recap_done", { ok: false, error: err.message });
    return { sent: false, reason: err.message };
  }
}

// Text the booking confirmation to the guest's mobile, once per code and number
// (confirming again to add an e-mail doesn't send a second SMS).
let smsSentFor = null;
async function sendConfirmationSms(code) {
  const phone = booking.phone;
  if (!phone) {
    ui.smsInfo.hidden = true;
    return { sent: false, reason: "no mobile number on the booking (optional)" };
  }
  const key = `${code}|${phone}`;
  if (smsSentFor === key) return { sent: true, already_sent: true, to: phone };
  const lang = pageLang(call?.lang || startLang);
  const show = (text) => { ui.smsInfo.hidden = false; ui.smsInfo.textContent = text; };
  show(t("sms.sending"));
  emitFlow("sms_start", { to: phone, lang });
  try {
    const res = await fetch("/api/booking-sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking, code, lang, callId: call?.callId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    emitFlow("sms_done", { ok: data.sent, reason: data.reason_code, channel: data.channel });
    if (data.sent) {
      smsSentFor = key;
      show(t(data.channel === "whatsapp" ? "sms.sentWhatsApp" : "sms.sent", { to: data.to }));
      return { sent: true, channel: data.channel, to: data.to };
    }
    if (data.reason_code === "off") {
      ui.smsInfo.hidden = true;
      return { sent: false, reason: "mobile confirmations are not enabled; don't mention an SMS or WhatsApp message" };
    }
    show(data.reason_code === "not_mobile" ? t("sms.notMobile", { number: phone }) : t("sms.error", { error: data.reason }));
    return {
      sent: false,
      reason: data.reason_code === "not_mobile"
        ? "this is not a mobile number: ask for a mobile number, or continue without SMS"
        : data.reason_code === "invalid_number"
          ? "the number is not valid: ask the guest to repeat it with the country code"
          : data.reason,
    };
  } catch (err) {
    console.error("Confirmation SMS failed:", err);
    show(t("sms.error", { error: err.message }));
    emitFlow("sms_done", { ok: false, error: err.message });
    return { sent: false, reason: err.message };
  }
}

function showRecap(text, previewUrl) {
  ui.recapInfo.hidden = false;
  ui.recapInfo.replaceChildren(text);
  if (previewUrl) {
    const a = document.createElement("a");
    a.href = previewUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = t("recap.open");
    ui.recapInfo.append(" · ", a);
  }
}

// ============================================================
// Booking page: bar, hotel cards, summary photo, manual edits
// ============================================================

function flashEl(el, ms = 1200) {
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), ms);
}

// Mirror the booking into the hero booking bar, hotel cards and summary photo.
function syncPage(changedKeys = []) {
  const set = (el, v) => { if (el.value !== v) el.value = v; };
  set(ui.barHotel, booking.hotel || "");
  set(ui.barCheckIn, booking.check_in || "");
  set(ui.barCheckOut, booking.check_out || "");
  set(ui.barAdults, String(booking.adults || 2));
  set(ui.barChildren, String(booking.children || 0));
  const cellOf = { hotel: ui.barHotel, check_in: ui.barCheckIn, check_out: ui.barCheckOut, adults: ui.barAdults, children: ui.barChildren };
  for (const k of changedKeys) if (cellOf[k]) flashEl(cellOf[k].closest(".bar-cell"));

  document.querySelectorAll(".hotel-card").forEach((c) => c.classList.toggle("selected", c.dataset.hotel === booking.hotel));
  if (booking.hotel) ui.summaryPhoto.style.backgroundImage = `url("assets/${booking.hotel}.jpg")`;
  else ui.summaryPhoto.removeAttribute("style");
}

// Edits made by hand on the page go through the same tool logic as the
// assistant's, and — during a call — the assistant is told about them.
function manualEdit(args, description) {
  const result = TOOLS.update_booking(args);
  if (!result.ok) showToast(translateErrors(result.errors), true);
  if (call?.started && description) {
    call.ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: t("edit.prefix", { what: description }) }] },
    }));
    call.lastSent = { text: t("edit.prefix", { what: description }).trim(), at: performance.now() };
    addToolNote(t("tool.form", { what: description }));
  }
  return result;
}

// The hotel list (booking bar) and the hotel cards come from Booking.HOTELS.
for (const [id, h] of Object.entries(Booking.HOTELS)) {
  ui.barHotel.add(new Option(h.name, id));
  const card = document.createElement("article");
  card.className = "hotel-card";
  card.dataset.hotel = id;
  const img = document.createElement("img");
  img.src = `assets/${id}.jpg`;
  img.alt = h.name;
  img.loading = "lazy";
  const info = document.createElement("div");
  info.className = "hotel-info";
  const loc = document.createElement("p");
  loc.className = "hotel-loc";
  loc.dataset.i18n = `loc.${h.city}`;
  const name = document.createElement("h3");
  name.textContent = h.name;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hotel-btn";
  btn.dataset.i18n = "hotel.book";
  info.append(loc, name, btn);
  card.append(img, info);
  $("hotelGrid").append(card);
}

for (let i = 1; i <= Booking.MAX_GUESTS; i++) ui.barAdults.add(new Option(String(i), String(i), false, i === 2));
for (let i = 0; i < Booking.MAX_GUESTS; i++) ui.barChildren.add(new Option(String(i), String(i), false, i === 0));
ui.barCheckIn.min = ui.barCheckOut.min = Booking.toISO(new Date());

ui.barHotel.addEventListener("change", () => ui.barHotel.value && manualEdit({ hotel: ui.barHotel.value }, t("edit.hotel", { name: Booking.HOTELS[ui.barHotel.value].short })));
ui.barCheckIn.addEventListener("change", () => ui.barCheckIn.value && manualEdit({ check_in: ui.barCheckIn.value }, t("edit.checkIn", { date: ui.barCheckIn.value })));
ui.barCheckOut.addEventListener("change", () => ui.barCheckOut.value && manualEdit({ check_out: ui.barCheckOut.value }, t("edit.checkOut", { date: ui.barCheckOut.value })));
ui.barAdults.addEventListener("change", () => manualEdit({ adults: Number(ui.barAdults.value) }, t("edit.adults", { n: ui.barAdults.value })));
ui.barChildren.addEventListener("change", () => manualEdit({ children: Number(ui.barChildren.value) }, t("edit.children", { n: ui.barChildren.value })));

ui.bar.addEventListener("submit", (e) => {
  e.preventDefault();
  const stay = {
    hotel: ui.barHotel.value, check_in: ui.barCheckIn.value, check_out: ui.barCheckOut.value,
    adults: Number(ui.barAdults.value), children: Number(ui.barChildren.value),
  };
  if (!stay.hotel || !stay.check_in || !stay.check_out) {
    showToast(t("toast.selectStay"), true);
    ui.bar.querySelector(stay.hotel ? (stay.check_in ? "#barCheckOut" : "#barCheckIn") : "#barHotel").focus();
    return;
  }
  const result = TOOLS.check_availability(stay);
  if (!result.ok) { showToast(translateErrors(result.errors), true); return; }
  document.getElementById("book").scrollIntoView({ behavior: "smooth" });
});

document.querySelectorAll(".hotel-card").forEach((card) => card.querySelector(".hotel-btn").addEventListener("click", () => {
  manualEdit({ hotel: card.dataset.hotel }, t("edit.hotel", { name: Booking.HOTELS[card.dataset.hotel].short }));
  ui.bar.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => (booking.check_in ? ui.barCheckOut : ui.barCheckIn).focus({ preventScroll: true }), 500);
}));

// Past the hero, the header turns solid and the floating concierge button
// appears (always shown while a call is live).
const onScroll = () => {
  ui.header.classList.toggle("solid", window.scrollY > 40);
  const barBottom = ui.bar.getBoundingClientRect().bottom;
  ui.launcher.classList.toggle("away", barBottom > 0 && !call?.started);
};
addEventListener("scroll", onScroll, { passive: true });
onScroll();

let toastTimer = 0;
function showToast(text, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

// Tool errors are written for the assistant (English); show guests their language.
function translateErrors(errors) {
  const map = [
    [/check_in is in the past/, "err.past"],
    [/check_out must be after check_in/, "err.order"],
    [/stays are limited/, "err.maxNights"],
    [/maximum \d+ guests/, "err.maxGuests"],
    [/is not available/, "err.roomUnavailable"],
  ];
  return errors.map((e) => { const hit = map.find(([re]) => re.test(e)); return hit ? t(hit[1]) : e; }).join(" ");
}

// ---- Concierge widget ----
function openConcierge() {
  ui.panel.hidden = false;
  ui.launcher.hidden = true;
  document.body.classList.add("concierge-open");
  ui.launcher.setAttribute("aria-expanded", "true");
  (call?.started ? ui.textInput : ui.callBtn).focus({ preventScroll: true });
}
function closeConcierge() {
  ui.panel.hidden = true;
  ui.launcher.hidden = false;
  document.body.classList.remove("concierge-open");
  ui.launcher.setAttribute("aria-expanded", "false");
  ui.launcher.focus({ preventScroll: true });
}
document.querySelectorAll("[data-open-concierge]").forEach((b) => b.addEventListener("click", () => openConcierge()));
ui.closePanel.addEventListener("click", closeConcierge);
addEventListener("keydown", (e) => { if (e.key === "Escape" && !ui.panel.hidden) closeConcierge(); });

// ============================================================
// Audio helpers
// ============================================================

function playPcm(c, bytes) {
  if (!c || c.ctx.state === "closed" || bytes.length < 2) return;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const buf = c.ctx.createBuffer(1, samples.length, c.outputRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 0x8000;
  const src = c.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(c.out);
  const startAt = Math.max(c.ctx.currentTime + 0.03, c.nextPlayTime);
  src.start(startAt);
  c.nextPlayTime = startAt + buf.duration;
  c.sources.add(src);
  src.onended = () => c.sources.delete(src);
}

// ============================================================
// Video avatar (WebRTC, receive only)
// ============================================================

function showAvatarStage(on) {
  ui.avatarStage.hidden = !on;
  if (!on) ui.avatarStage.classList.remove("playing");
}

// After avatar.session.ready: one offer with receive-only audio and video,
// trickled ICE candidates, then avatar.media.ready once the peer connection is
// up and both tracks arrived (that releases the greeting).
async function startAvatar(c, event) {
  const send = (frame) => c.ws.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify(frame));
  const pc = new RTCPeerConnection(event.ice_configuration || {});
  const stream = new MediaStream();
  const av = { pc, stream, audioNode: null, offerSent: false, candidates: [], mediaReady: false };
  c.avatar = av;
  showAvatarStage(true);

  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.addTransceiver("video", { direction: "recvonly" });

  const maybeReady = () => {
    if (av.mediaReady || c.avatar !== av || pc.connectionState !== "connected") return;
    if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) return;
    av.mediaReady = true;
    send({ type: "avatar.media.ready" });
  };
  pc.ontrack = (e) => {
    stream.addTrack(e.track);
    if (e.track.kind === "audio" && !av.audioNode) {
      // Play the avatar's voice through the call's audio graph (the agent meter
      // follows it); the <video> stays muted so it isn't heard twice.
      av.audioNode = c.ctx.createMediaStreamSource(new MediaStream([e.track]));
      av.audioNode.connect(c.out);
    }
    ui.avatarVideo.srcObject = stream;
    ui.avatarVideo.play().catch(() => {});
    maybeReady();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" && c.avatar === av) {
      stopAvatar(c);
      setStatus("status.videoLost");
    }
    maybeReady();
  };
  pc.onicecandidate = (e) => {
    const frame = { type: "avatar.ice_candidate", candidate: e.candidate ? e.candidate.toJSON() : null };
    if (av.offerSent) send(frame);
    else av.candidates.push(frame);
  };

  await pc.setLocalDescription(await pc.createOffer());
  send({ type: "avatar.webrtc.offer", offer: { type: "offer", sdp: pc.localDescription.sdp } });
  av.offerSent = true;
  av.candidates.splice(0).forEach(send);
}

function stopAvatar(c) {
  const av = c?.avatar;
  showAvatarStage(false);
  ui.avatarVideo.srcObject = null;
  if (!av) return;
  c.avatar = null;
  try { av.audioNode?.disconnect(); } catch { /* already gone */ }
  av.pc.close();
}

ui.avatarVideo.addEventListener("playing", () => ui.avatarStage.classList.add("playing"));

function stopPlayback(c) {
  if (!c) return;
  for (const s of c.sources) { try { s.stop(); } catch { /* already stopped */ } }
  c.sources.clear();
  c.nextPlayTime = 0;
}

function meterLoop(c) {
  const data = new Float32Array(512);
  const level = (analyser) => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.min(100, Math.sqrt(sum / data.length) * 400);
  };
  const tick = () => {
    if (call !== c) return;
    ui.micLevel.style.width = `${c.muted ? 0 : level(c.micAnalyser)}%`;
    ui.agentLevel.style.width = `${level(c.agentAnalyser)}%`;
    c.raf = requestAnimationFrame(tick);
  };
  tick();
}

// Float32 [-1,1] at inRate → Int16 PCM at outRate (box-filter decimation).
function downsampleToInt16(input, inRate, outRate) {
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio)) || start + 1;
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const s = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ============================================================
// UI helpers
// ============================================================

function clearChatPlaceholder() {
  ui.chat.querySelector(".chat-empty")?.remove();
}

function addMessage(role, text) {
  clearChatPlaceholder();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? t("chat.you") : receptionist(currentVoice()).name;
  const body = document.createElement("span");
  body.textContent = text;
  el.append(who, body);
  ui.chat.append(el);
  scrollChat();
  return { el, text: body };
}

function addToolNote(text, failed = false) {
  clearChatPlaceholder();
  const el = document.createElement("div");
  el.className = `tool${failed ? " err" : ""}`;
  el.textContent = text;
  ui.chat.append(el);
  scrollChat();
}

function scrollChat() {
  ui.chat.scrollTop = ui.chat.scrollHeight;
}

// Labels are stored as translation keys (data-i18n), so switching language
// re-translates whatever is on screen, mid-call included.
function setText(el, key) {
  el.dataset.i18n = key;
  el.textContent = t(key);
}

let lastStatus = null;
function setStatus(key, isError = false, vars) {
  const known = key.includes(".") && t(key) !== key;
  lastStatus = known ? { key, vars, error: isError } : null;
  ui.status.textContent = known ? t(key, vars) : key;
  ui.status.classList.toggle("error", isError);
}

function setCallState(kind, key) {
  setPill(ui.callState, kind, key);
}

function setPill(el, kind, key) {
  el.className = `pill ${kind}`;
  setText(el, key);
}

function formatDate(iso) {
  const d = Booking.parseISO(iso);
  return d ? I18N.date(d) : iso;
}

function todayForAssistant() {
  const d = new Date();
  return `${I18N.date(d)} (${Booking.toISO(d)})`;
}

const eur = (n) => I18N.eur(n);

// ---- Init ----
I18N.set("en");
I18N.apply();
renderBooking();
loadConcierge();
