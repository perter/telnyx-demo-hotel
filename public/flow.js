// "How it works" page: an architecture diagram that can be explored step by
// step, replayed as a demo, or driven live by a call running in another tab
// (BroadcastChannel "telnyxhotel-flow").

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
Account.topbar($("topbar"));
const t = (k, v) => I18N.t(k, v);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const P = (id) => $(id); // paths and nodes are addressed by id
const COLORS = {
  ws: "#64748b", audioIn: "#3b82f6", text: "#8b5cf6", audioOut: "#00a67c", avatar: "#e11d48", tools: "#f59e0b",
  ui: "#ec4899", rest: "#0ea5e9", kb: "#0891b2", mail: "#14b8a6", sms: "#16a34a", rec: "#475569", data: "#a855f7", err: "#e5484d",
};

// ---------------------------------------------------------------------------
// Steps: which nodes and links each one involves, and how a packet travels
// ---------------------------------------------------------------------------
const lbl = (color, label, speed) => ({ kind: "label", color, label, ...(speed ? { speed } : {}) });
const STEPS = {
  setup: {
    nodes: ["nWsClient", "nRelay", "nAuth", "nApi", "nRest", "nGate"],
    links: ["busCS", "busST", "sAuth", "sApi", "sApiRest"],
    demo: () => chain([[[["busCS"]], lbl(COLORS.ws, "cookies: session + prefs")],
                       [[["sAuth"]], lbl(COLORS.rest, "auth.js · /api/prefs")],
                       [[["sApi"]], lbl(COLORS.rest, "voice lock")],
                       [[["sApiRest"]], lbl(COLORS.rest, "POST /v2/ai/assistants")],
                       [[["busST"]], lbl(COLORS.ws, "WebSocket + key")]]),
  },
  listen: {
    nodes: ["nMic", "nWsClient", "nRelay", "nGate", "nStt"],
    links: ["cMic", "busCS", "busST", "tGateStt"],
    demo: () => route([["cMic", true], ["busCS"], ["busST"], ["tGateStt"]], { color: COLORS.audioIn, speed: 0.55 }),
  },
  transcribe: {
    nodes: ["nStt", "nLlm", "nGate", "nRelay", "nWsClient", "nChat"],
    links: ["tSttLlm", "busST", "busCS", "cChat"],
    demo: () => Promise.all([
      route([["tSttLlm"]], lbl(COLORS.text, "transcript")),
      route([["busST", true], ["busCS", true], ["cChat"]], lbl(COLORS.text, "transcription.completed")),
    ]),
  },
  think: {
    nodes: ["nLlm", "nKb", "nTts"],
    links: ["tSttLlm", "tLlmKb", "tLlmTts"],
    demo: () => chain([[[["tLlmKb"]], lbl(COLORS.kb, "retrieval")],
                       [[["tLlmKb", true]], lbl(COLORS.kb, t("flow.demo.kb"))],
                       [[["tLlmTts"]], lbl(COLORS.text, "response")]]),
  },
  tools: {
    nodes: ["nStt", "nLlm", "nGate", "nRelay", "nWsClient", "nTools", "nCard", "nRates", "nBooking"],
    links: ["tSttLlm", "busST", "busCS", "cTools", "cCard", "sRates", "sBooking"],
    // "Amsterdam" recognised → update_booking → through the server → card updated,
    // while the availability lookup starts in parallel.
    demo: () => {
      const main = chain([
        [[["tSttLlm"]], lbl(COLORS.text, t("flow.demo.heard"))],
        [[["busST", true], ["busCS", true], ["cTools"]], lbl(COLORS.tools, "update_booking {hotel: amsterdam_canal}")],
        [[["cCard"]], lbl(COLORS.ui, t("flow.lbl.updatesCard"), 0.1)],
        [[["cTools", true], ["busCS"], ["busST"]], lbl(COLORS.audioOut, "function_call_output")],
      ]);
      setTimeout(availability, 1800);
      return main;
    },
  },
  speak: {
    nodes: ["nLlm", "nTts", "nGate", "nRelay", "nWsClient", "nSpk"],
    links: ["tLlmTts", "tTtsGate", "busST", "busCS", "cSpk", "tAvatar"],
    demo: () => Promise.all([
      route([["tTtsGate"], ["busST", true], ["busCS", true], ["cSpk"]], { color: COLORS.audioOut, speed: 0.55 }),
      route([["tAvatar"]], lbl(COLORS.avatar, "WebRTC · avatar", 0.9)),
    ]),
  },
  email: {
    nodes: ["nCard", "nWsClient", "nRelay", "nRecap", "nMail", "nInbox"],
    links: ["busCS", "sRecap", "sRecapMail", "tMailInbox"],
    demo: () => chain([
      [[["busCS"]], lbl(COLORS.mail, "POST /api/booking-recap")],
      [[["sRecap"]], lbl(COLORS.mail, "recap.js")],
      [[["sRecapMail"], ["tMailInbox"]], lbl(COLORS.mail, "Telnyx Email")],
    ]),
  },
  sms: {
    nodes: ["nCard", "nWsClient", "nRelay", "nSms", "nLookup", "nMsg", "nPhone"],
    links: ["busCS", "sSms", "sSmsLookup", "tLookupMsg", "tMsgPhone"],
    demo: () => chain([
      [[["busCS"]], lbl(COLORS.sms, "POST /api/booking-sms")],
      [[["sSms"]], lbl(COLORS.sms, "sms.js")],
      [[["sSmsLookup"]], lbl(COLORS.sms, "Number Lookup")],
      [[["tLookupMsg"], ["tMsgPhone"]], lbl(COLORS.sms, "SMS · WhatsApp")],
    ]),
  },
  record: {
    nodes: ["nWsClient", "nRelay", "nRecorder", "nSql"],
    links: ["busCS", "busST", "sRec", "sRecDb"],
    demo: () => chain([
      [[["sRec"]], lbl(COLORS.rec, t("flow.demo.frames"))],
      [[["sRecDb"]], lbl(COLORS.rec, "INSERT calls")],
      [[["sRecDb", true], ["sRec", true], ["busCS", true]], lbl(COLORS.rec, t("flow.demo.history"))],
    ]),
  },
  data: {
    nodes: ["nTools", "nRates", "nBooking"],
    links: ["sRates", "sBooking", "cTools"],
    demo: () => availability(),
  },
};
// Where a real availability source is queried, in parallel with the conversation.
const availability = () => chain([[[["sRates"]], lbl(COLORS.data, `${t("flow.lbl.parallel")}: check_availability`)],
                                  [[["sBooking"]], lbl(COLORS.data, t("flow.n.booking"))]]).then(() => flash($("nBooking"), "hot", 1600));
const STEP_ORDER = Object.keys(STEPS);

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
// One small flag per language, as [direction, ...stripe colours]; English gets the Union Jack.
const STRIPES = {
  fr: ["v", "#002395", "#fff", "#ed2939"],
  de: ["h", "#000", "#dd0000", "#ffce00"],
  it: ["v", "#009246", "#fff", "#ce2b37"],
  es: ["h", "#aa151b", "#f1bf00", "#f1bf00", "#aa151b"],
  nl: ["h", "#ae1c28", "#fff", "#21468b"],
};
const UNION_JACK = `<svg width="26" height="17" viewBox="0 0 60 30" preserveAspectRatio="none"><clipPath id="fs"><path d="M0,0 v30 h60 v-30 z"/></clipPath><clipPath id="ft"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath><g clip-path="url(#fs)"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#ft)" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></g></svg>`;
function flagArt(lang) {
  if (!STRIPES[lang]) return UNION_JACK;
  const [dir, ...colors] = STRIPES[lang];
  const n = colors.length;
  const stripes = colors.map((c, i) => (dir === "v"
    ? `<rect x="${(26 / n) * i}" width="${26 / n}" height="17" fill="${c}"/>`
    : `<rect y="${(17 / n) * i}" width="26" height="${17 / n}" fill="${c}"/>`)).join("");
  return `${stripes}<rect width="26" height="17" fill="none" stroke="rgba(0,0,0,0.25)" stroke-width="0.6"/>`;
}
const LANG_NAMES = { en: "English", fr: "Français", de: "Deutsch", it: "Italiano", es: "Español", nl: "Nederlands" };
for (const lang of Object.keys(LANG_NAMES)) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "flagl");
  g.dataset.lang = lang;
  g.innerHTML = flagArt(lang);
  $("flowFlag").append(g);
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ghost-btn";
  b.dataset.lang = lang;
  b.textContent = lang.toUpperCase();
  $("langSwitch").append(b);
}
let spokenLang = null;
function setSpokenLang(lang) {
  if (!LANG_NAMES[lang] || lang === spokenLang) return;
  spokenLang = lang;
  document.querySelectorAll("#flowFlag .flagl").forEach((g) => g.classList.toggle("on", g.dataset.lang === lang));
  $("langName").textContent = lang.toUpperCase();
}

// ---------------------------------------------------------------------------
// Packets
// ---------------------------------------------------------------------------
const layer = $("packets");
const moving = new Set();
const SPEED = 0.45; // px per ms

function makePacket(kind, color, label) {
  const g = document.createElementNS(SVG_NS, "g");
  layer.append(g);
  if (kind === "dot") {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("r", "5");
    c.setAttribute("fill", color);
    c.setAttribute("class", "pk-dot");
    g.append(c);
    return g;
  }
  g.setAttribute("class", "pk-label");
  const rect = document.createElementNS(SVG_NS, "rect");
  const text = document.createElementNS(SVG_NS, "text");
  text.textContent = label;
  text.setAttribute("fill", "#fff");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("y", "4");
  rect.setAttribute("fill", color);
  rect.setAttribute("stroke", "#fff");
  rect.setAttribute("stroke-width", "1.5");
  g.append(rect, text);
  const w = Math.min(280, text.getComputedTextLength() + 16);
  Object.entries({ x: -w / 2, y: -10, width: w, height: 20, rx: 10 }).forEach(([k, v]) => rect.setAttribute(k, v));
  return g;
}

function route(segments, { kind = "dot", color, label = "", speed = SPEED } = {}) {
  if (document.hidden) return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    const segs = segments.map(([id, reverse]) => ({ path: P(id), reverse: !!reverse, len: P(id).getTotalLength() }));
    const total = segs.reduce((a, s) => a + s.len, 0);
    const g = makePacket(kind, color, label);
    moving.add({ g, segs, total, duration: reduceMotion ? 1 : total / speed, start: performance.now(), resolve, last: -1 });
  });
}

// Run routes one after another.
function chain(steps) {
  return steps.reduce((p, [segments, opts]) => p.then(() => route(segments, opts)), Promise.resolve());
}

function tick(now) {
  for (const p of moving) {
    const k = Math.min(1, (now - p.start) / p.duration);
    let dist = p.total * k, i = 0;
    while (i < p.segs.length - 1 && dist > p.segs[i].len) { dist -= p.segs[i].len; i++; }
    const s = p.segs[i];
    if (i !== p.last) { p.last = i; flash(s.path, "hot", 1400); }
    const pt = s.path.getPointAtLength(s.reverse ? s.len - dist : dist);
    p.g.setAttribute("transform", `translate(${pt.x},${pt.y})`);
    if (k >= 1) { moving.delete(p); p.g.remove(); p.resolve(); }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const timers = new WeakMap();
function flash(el, cls = "hot", ms = 900) {
  if (!el) return;
  el.classList.add(cls);
  const own = timers.get(el) || {};
  clearTimeout(own[cls]);
  own[cls] = setTimeout(() => el.classList.remove(cls), ms);
  timers.set(el, own);
}

const clip = (s, max) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const quote = (s, max = 30) => `“${clip(s, max)}”`;
const setNodeText = (id, text) => { const el = $(id); delete el.dataset.i18n; el.textContent = text; };
function hubEvent(name) { $("hubEvent").textContent = name; flash($("nWsClient"), "hot", 800); }

// ---------------------------------------------------------------------------
// Step focus: dim everything that isn't part of the selected step
// ---------------------------------------------------------------------------
const svg = $("diagram");
let focused = null;

function focusStep(step, { fromUser = false } = {}) {
  focused = step;
  document.querySelectorAll("#stepRail button").forEach((b) => b.classList.toggle("on", b.dataset.step === step));
  svg.classList.toggle("focus-mode", !!step);
  const spec = STEPS[step];
  document.querySelectorAll(".node").forEach((n) => n.classList.toggle("dim", !!spec && !spec.nodes.includes(n.id)));
  document.querySelectorAll(".link").forEach((l) => l.classList.toggle("dim", !!spec && !spec.links.includes(l.id)));
  renderStepDetail(step);
  if (fromUser && spec) {
    setMode("paused", { keepFocus: true });
    showStepTab();
    narrate(`flow.step.${step}`, stepClass(step), `flow.d.${step}.1`);
    spec.demo();
    clearInterval(loopTimer);
    loopTimer = setInterval(() => focused === step && spec.demo(), 3200);
  }
}

function clearFocus() {
  focused = null;
  svg.classList.remove("focus-mode");
  document.querySelectorAll(".node, .link").forEach((el) => el.classList.remove("dim"));
  document.querySelectorAll("#stepRail button").forEach((b) => b.classList.remove("on"));
  clearInterval(loopTimer);
  renderStepDetail(null);
}

let loopTimer = 0;
document.querySelectorAll("#stepRail button").forEach((b) =>
  b.addEventListener("click", () => (focused === b.dataset.step ? (clearFocus(), setMode("demo")) : focusStep(b.dataset.step, { fromUser: true }))));

function renderStepDetail(step) {
  const box = $("stepDetail");
  box.replaceChildren();
  if (!step) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = t("flow.narrIdle");
    box.append(p);
    return;
  }
  const h = document.createElement("h3");
  h.textContent = t(`flow.d.${step}.title`);
  const ul = document.createElement("ul");
  for (let i = 1; i <= 4; i++) {
    const key = `flow.d.${step}.${i}`;
    const val = t(key);
    if (val === key) break;
    const li = document.createElement("li");
    li.innerHTML = val; // copy from our own dictionary
    ul.append(li);
  }
  box.append(h, ul);
}

// "Who does what" cards come from the dictionary too, into the side tab.
function renderRoles() {
  const body = $("rolesBody");
  body.replaceChildren();
  for (const who of ["client", "server", "telnyx", "external"]) {
    const box = document.createElement("div");
    box.className = `role ${who}`;
    body.append(box);
    const h = document.createElement("h3");
    h.textContent = t(`flow.role.${who}.title`);
    const ul = document.createElement("ul");
    for (let i = 1; i <= 7; i++) {
      const key = `flow.role.${who}.${i}`;
      const val = t(key);
      if (val === key) break;
      const li = document.createElement("li");
      li.innerHTML = val;
      ul.append(li);
    }
    box.append(h, ul);
  }
}

// Side tabs: step explanation · who does what
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $("stepDetail").hidden = b.dataset.tab !== "step";
  $("rolesBody").hidden = b.dataset.tab !== "roles";
}));

// A step picked on the rail always shows its explanation.
function showStepTab() {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === "step"));
  $("stepDetail").hidden = false;
  $("rolesBody").hidden = true;
}

// ---------------------------------------------------------------------------
// Narration + log
// ---------------------------------------------------------------------------
const narration = $("narration");
let narrTimer = 0, lastNarr = null;
function narrate(tagKey, cls, key, vars) {
  lastNarr = { tagKey, cls, key, vars };
  narration.classList.add("swap");
  clearTimeout(narrTimer);
  narrTimer = setTimeout(() => {
    $("narrTag").className = `tag ${cls}`;
    $("narrTag").textContent = t(tagKey);
    $("narrText").innerHTML = t(key, vars); // copy from our own dictionary
    delete $("narrText").dataset.i18n;
    narration.classList.remove("swap");
  }, 160);
}

const logEntries = [];
function log(tagKey, cls, key, vars, { client = false, server = false } = {}) {
  const entry = { tagKey, cls, key, vars, client, server, at: new Date() };
  logEntries.unshift(entry);
  if (logEntries.length > 60) logEntries.pop();
  renderLog();
}

function renderLog() {
  const list = $("log");
  if (!logEntries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = t("flow.noEvents");
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...logEntries.map((e) => {
    const li = document.createElement("li");
    li.className = [e.client ? "client" : "", e.server ? "server" : ""].filter(Boolean).join(" ");
    const time = document.createElement("time");
    time.textContent = e.at.toLocaleTimeString(I18N.locale());
    const tag = document.createElement("span");
    tag.className = `tag ${e.cls}`;
    tag.textContent = t(e.tagKey);
    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = t(e.key, e.vars);
    li.append(time, tag, msg);
    return li;
  }));
}

document.querySelectorAll(".filters .chip").forEach((chip) => chip.addEventListener("click", () => {
  document.querySelectorAll(".filters .chip").forEach((c) => c.classList.toggle("on", c === chip));
  $("log").className = `log ${chip.dataset.filter === "all" ? "" : `only-${chip.dataset.filter}`}`;
}));

// ---------------------------------------------------------------------------
// Mini reservation card
// ---------------------------------------------------------------------------
const CARD_FIELDS = [["hotel", "flow.card.hotel"], ["dates", "flow.card.dates"], ["guests", "flow.card.guests"],
  ["room_type", "flow.card.room"], ["guest_name", "flow.card.name"], ["total", "flow.card.total"]];
const cardRows = {};
(function buildCard() {
  const root = $("cardRows");
  CARD_FIELDS.forEach(([key], i) => {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "card-row");
    g.setAttribute("transform", `translate(0,${i * 19})`);
    g.innerHTML = `<text class="k" x="0" y="10"></text><text class="v" x="78" y="10">—</text>`;
    root.append(g);
    cardRows[key] = g;
  });
})();
let cardValues = {}, cardCode = null;

function renderCard() {
  for (const [key, labelKey] of CARD_FIELDS) {
    cardRows[key].querySelector(".k").textContent = t(labelKey);
    cardRows[key].querySelector(".v").textContent = clip(cardValues[key] || "", 20) || "—";
  }
  $("cardState").textContent = cardCode
    ? t("flow.card.confirmed", { code: cardCode })
    : Object.values(cardValues).some(Boolean) ? t("flow.card.progress") : t("flow.card.waiting");
  $("cardState").classList.toggle("done", !!cardCode);
}

function applyCard({ values = {}, changed = [] }) {
  const labels = { hotel: "flow.card.hotel", check_in: "flow.card.dates", room_type: "flow.card.room",
    guests: "flow.card.guests", guest_name: "flow.card.name", total: "flow.card.total" };
  const next = {
    hotel: values.hotel, guests: values.guests, room_type: values.room_type,
    guest_name: values.guest_name, total: values.total,
    dates: [values.check_in, values.check_out].filter(Boolean).join(" → "),
  };
  const touched = changed.map((c) => (c === "check_in" || c === "check_out" ? "dates" : c)).filter((c) => cardRows[c]);
  const changedNow = touched.filter((k) => next[k] && next[k] !== cardValues[k]);
  cardValues = next;
  renderCard();
  for (const k of changedNow) flash(cardRows[k], "flash", 1500);
  if (changedNow.length) {
    flash($("nCard"), "hot", 1400);
    const names = changedNow.map((k) => t(labels[k] || `flow.card.${k}`)).join(" · ");
    log("flow.tag.ui", "ui", "flow.ev.ui", { fields: names }, { client: true });
    narrate("flow.tag.ui", "ui", "flow.ev.uiNarr", { fields: names });
    route([["cCard"]], lbl(COLORS.ui, "UI", 0.12));
  }
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------
let agentBuffer = "", lastAgentPacket = 0, toolFlight = null, recapFlight = null, smsFlight = null;

function liveStep(step) {
  if (mode === "live") {
    document.querySelectorAll("#stepRail button").forEach((b) => b.classList.toggle("on", b.dataset.step === step));
  }
}

const handlers = {
  call_start({ voice = "", lang }) {
    setSpokenLang(lang);
    const engine = "Telnyx Ultra";
    const short = voice.split(" - ")[0];
    setNodeText("ttsSub", engine);
    setNodeText("ttsText", `voice: ${short}`);
    setNodeText("apiText", `voice → ${clip(short, 16)}`);
    setNodeText("sttText", t("flow.waitingVoice"));
    setNodeText("llmText", "…");
    setNodeText("toolText", t("flow.waitingTool"));
    cardValues = {}; cardCode = null; renderCard();
    liveStep("setup");
    narrate("flow.tag.setup", "setup", "flow.ev.voiceNarr", { voice, engine });
    log("flow.tag.setup", "setup", "flow.ev.prefs", { voice }, { server: true });
    log("flow.tag.setup", "setup", "flow.ev.voice", { voice, engine }, { server: true });
    flash($("nAuth"), "hot", 1200);
    chain([[[["sAuth"]], lbl(COLORS.rest, "prefs cookie")],
           [[["sApi"]], lbl(COLORS.rest, `voice → ${clip(short, 14)}`)],
           [[["sApiRest"]], lbl(COLORS.rest, "POST")]]).then(() => flash($("nRest"), "hot", 1200));
  },
  ws_open() {
    liveStep("setup");
    hubEvent("session.update");
    narrate("flow.tag.ws", "setup", "flow.ev.wsOpenNarr");
    log("flow.tag.ws", "setup", "flow.ev.wsOpen", null, { client: true, server: true });
    route([["busCS"], ["busST"]], lbl(COLORS.ws, "session.update")).then(() => flash($("nGate"), "hot", 1200));
    route([["sRec"]], lbl(COLORS.rec, t("flow.demo.frames"))).then(() => flash($("nRecorder"), "hot", 1200));
  },
  session_created() {
    ["nGate", "nStt", "nLlm", "nTts"].forEach((id) => flash($(id), "hot", 1200));
    log("flow.tag.ws", "setup", "flow.ev.session", null, { server: true });
  },
  mic_audio() {
    liveStep("listen");
    flash($("nMic"), "hot", 700);
    route([["cMic", true], ["busCS"], ["busST"], ["tGateStt"]], { color: COLORS.audioIn, speed: 0.7 });
  },
  speech_started() {
    liveStep("listen");
    flash($("nStt"), "hot", 2200); flash($("nGate"), "hot", 900);
    setNodeText("sttText", "…");
    narrate("flow.tag.vad", "audio-in", "flow.ev.listenNarr");
    log("flow.tag.vad", "audio-in", "flow.ev.vad");
  },
  speech_stopped() { log("flow.tag.vad", "audio-in", "flow.ev.vadEnd"); },
  user_transcript({ text }) {
    liveStep("transcribe");
    setNodeText("sttText", quote(text, 18));
    flash($("nStt"), "hot", 1200);
    narrate("flow.tag.stt", "text", "flow.ev.transcriptNarr", { text: quote(text, 60) });
    log("flow.tag.stt", "text", "flow.ev.transcript", { text: quote(text, 80) });
    route([["tSttLlm"]], lbl(COLORS.text, quote(text, 22))).then(() => flash($("nLlm"), "hot", 1400));
    route([["busST", true], ["busCS", true], ["cChat"]], lbl(COLORS.text, "transcription.completed"))
      .then(() => { hubEvent("transcription"); flash($("nChat"), "hot", 1200); setNodeText("chatText", quote(text, 14));
        log("flow.tag.chat", "text", "flow.ev.chat", { text: quote(text, 70) }, { client: true }); });
  },
  user_text({ text }) {
    route([["cChat", true], ["busCS"], ["busST"]], lbl(COLORS.text, `⌨ ${quote(text, 18)}`))
      .then(() => flash($("nLlm"), "hot", 1200));
    log("flow.tag.chat", "text", "flow.ev.typed", { text: quote(text, 70) }, { client: true });
  },
  lang_change({ lang }) {
    setSpokenLang(lang);
    flash($("nChat"), "hot", 1500);
    const name = LANG_NAMES[lang] || lang;
    narrate("flow.tag.lang", "lang", "flow.ev.langNarr", { lang: name });
    log("flow.tag.lang", "lang", "flow.ev.lang", { lang: name }, { client: true });
    if (followSpoken) setPageLang(lang);
  },
  agent_text({ text }) {
    liveStep("think");
    agentBuffer = text;
    setNodeText("llmText", quote(text.split(/(?<=[.!?])\s/).pop() || text, 18));
    flash($("nLlm"), "hot", 900);
    if (performance.now() - lastAgentPacket > 1200) {
      lastAgentPacket = performance.now();
      route([["tLlmTts"]], lbl(COLORS.text, quote(text.slice(-22), 22))).then(() => flash($("nTts"), "hot", 1200));
    }
  },
  agent_audio({ voice }) {
    liveStep("speak");
    flash($("nTts"), "hot", 900);
    route([["tTtsGate"], ["busST", true], ["busCS", true], ["cSpk"]], { color: COLORS.audioOut, speed: 0.7 })
      .then(() => { flash($("nSpk"), "hot", 700); hubEvent("audio.delta"); });
    if (voice) setNodeText("ttsText", `voice: ${clip(voice.split(" - ")[0], 14)}`);
    narrate("flow.tag.reply", "audio-out", "flow.ev.speakNarr");
  },
  response_done({ status }) {
    if (agentBuffer) log("flow.tag.reply", "text", "flow.ev.reply",
      { cancelled: status === "cancelled" ? t("flow.ev.cancelled") : "", text: quote(agentBuffer, 70) });
    agentBuffer = "";
  },
  barge_in() {
    flash(P("busCS"), "barge", 900); flash(P("cSpk"), "barge", 900);
    narrate("flow.tag.barge", "audio-out", "flow.ev.bargeNarr");
    log("flow.tag.barge", "audio-out", "flow.ev.barge", null, { client: true });
  },
  tool_start({ name, args }) { toolFlight = startTool(name, args); },
  booking_render(detail) {
    if (!detail.changed?.length) return;
    const run = () => applyCard(detail);
    if (toolFlight) toolFlight.done = toolFlight.done.then(run); else run();
  },
  booking_confirmed({ code }) {
    const run = () => { cardCode = code; renderCard(); };
    if (toolFlight) toolFlight.done = toolFlight.done.then(run); else run();
  },
  tool_call({ name, ok, output }) { finishTool(name, ok, output); },
  server_tool({ name }) {
    log("flow.tag.tool", "tools", "flow.ev.serverTool", { name });
    if (name === "hangup") return;
    liveStep("think");
    narrate("flow.tag.kb", "kb", "flow.ev.kbNarr");
    chain([[[["tLlmKb"]], lbl(COLORS.kb, name || "retrieval")], [[["tLlmKb", true]], lbl(COLORS.kb, t("flow.demo.kb"))]])
      .then(() => flash($("nLlm"), "hot", 900));
    flash($("nKb"), "hot", 1600);
  },
  recap_start({ to, lang }) {
    liveStep("email");
    const go = () => {
      setNodeText("mailText", t("flow.mail.checking"));
      narrate("flow.tag.mail", "mail", "flow.ev.recapNarr", { to });
      log("flow.tag.post", "mail", "flow.ev.recapPost", { to, lang }, { client: true });
      return chain([[[["busCS"]], lbl(COLORS.mail, "POST /api/booking-recap")],
                    [[["sRecap"]], lbl(COLORS.mail, "recap.js")]])
        .then(() => flash($("nRecap"), "hot", 1600));
    };
    recapFlight = (toolFlight ? toolFlight.done : Promise.resolve()).then(go);
    if (toolFlight) toolFlight.done = recapFlight;
  },
  recap_done({ ok, sent, to, error }) {
    const go = () => {
      if (!ok) {
        setNodeText("mailText", t("flow.mail.failed"));
        log("flow.tag.mail", "mail", "flow.ev.recapError", { error }, { server: true });
        return;
      }
      setNodeText("mailText", sent ? t("flow.mail.sent") : t("flow.mail.preview"));
      setNodeText("inboxText", sent ? clip(to, 22) : t("flow.mail.previewBox"));
      narrate("flow.tag.mail", "mail", sent ? "flow.ev.recapSentNarr" : "flow.ev.recapPreviewNarr", { to });
      log("flow.tag.mail", "mail", sent ? "flow.ev.recapSent" : "flow.ev.recapPreview", { to }, { server: true });
      if (!sent) return;
      return route([["sRecapMail"], ["tMailInbox"]], lbl(COLORS.mail, "Telnyx Email")).then(() => flash($("nInbox"), "hot", 1800));
    };
    const p = (recapFlight || Promise.resolve()).then(go);
    recapFlight = null;
    if (toolFlight) toolFlight.done = p;
  },
  sms_start({ to }) {
    liveStep("sms");
    const go = () => {
      setNodeText("smsText", t("flow.sms.checking"));
      narrate("flow.tag.sms", "sms", "flow.ev.smsNarr", { to });
      log("flow.tag.post", "sms", "flow.ev.smsPost", { to }, { client: true });
      return chain([[[["busCS"]], lbl(COLORS.sms, "POST /api/booking-sms")], [[["sSms"]], lbl(COLORS.sms, "sms.js")],
                    [[["sSmsLookup"]], lbl(COLORS.sms, "Number Lookup")]]).then(() => flash($("nLookup"), "hot", 1400));
    };
    smsFlight = (toolFlight ? toolFlight.done : Promise.resolve()).then(go);
  },
  sms_done({ ok, reason, channel, error }) {
    const name = channel === "whatsapp" ? "WhatsApp" : "SMS";
    (smsFlight || Promise.resolve()).then(() => {
      if (!ok) {
        setNodeText("smsText", t("flow.sms.notSent"));
        log("flow.tag.sms", "sms", "flow.ev.smsNotSent", { channel: name, reason: error || reason || "" }, { server: true });
        return;
      }
      setNodeText("smsText", t("flow.sms.sent", { channel: name }));
      setNodeText("phoneText", name);
      narrate("flow.tag.sms", "sms", "flow.ev.smsSentNarr", { channel: name });
      log("flow.tag.sms", "sms", "flow.ev.smsSent", { channel: name }, { server: true });
      return route([["tLookupMsg"], ["tMsgPhone"]], lbl(COLORS.sms, name)).then(() => flash($("nPhone"), "hot", 1800));
    });
    smsFlight = null;
  },
  call_end() {
    setNodeText("sttText", t("flow.waitingVoice"));
    setNodeText("llmText", "…");
    narrate("flow.tag.end", "setup", "flow.ev.endNarr");
    log("flow.tag.end", "setup", "flow.ev.end");
    log("flow.tag.rec", "rec", "flow.ev.recorded", null, { server: true });
    route([["sRecDb"]], lbl(COLORS.rec, "INSERT calls")).then(() => flash($("nSql"), "hot", 1600));
  },
};

const TOOL_ICON = { update_booking: "📝", check_availability: "🔎", confirm_booking: "✅" };

function startTool(name, args = {}) {
  liveStep("tools");
  flash($("nLlm"), "hot", 1500);
  const argText = Object.entries(args).map(([k, v]) => `${k}: ${v}`).join(", ");
  if (argText) log("flow.tag.stt", "text", "flow.ev.recognised", { what: clip(argText, 60) });
  narrate("flow.tag.tool", "tools", "flow.ev.toolNarr", { name });
  if (name === "check_availability") {
    setTimeout(availability, 600);
    log("flow.tag.data", "data", "flow.ev.parallel", null, { server: true });
  }
  log("flow.tag.tool", "tools", "flow.ev.toolCall", { name, args: clip(argText, 70) });
  hubEvent("function_call");
  const done = route([["busST", true], ["busCS", true], ["cTools"]], lbl(COLORS.tools, `${TOOL_ICON[name] || "⚙️"} ${name}`))
    .then(() => {
      flash($("nTools"), "hot", 1600);
      setNodeText("toolText", `▶ ${name}()`);
      narrate("flow.tag.run", "tools", "flow.ev.toolRunNarr", { name });
      log("flow.tag.run", "tools", "flow.ev.toolRun", { name }, { client: true });
    });
  return { name, done };
}

function finishTool(name, ok, output = {}) {
  const flight = toolFlight && toolFlight.name === name ? toolFlight : startTool(name);
  toolFlight = null;
  flight.done
    .then(() => new Promise((r) => setTimeout(r, 300)))
    .then(() => {
      setNodeText("toolText", `${ok ? "✓" : "✗"} ${name}`);
      narrate("flow.tag.tool", "tools", "flow.ev.toolOutNarr", { name });
      log("flow.tag.tool", "tools", "flow.ev.toolOut",
        { name, result: ok ? t("flow.ev.ok") : `${t("flow.ev.err")}: ${output.errors?.[0] || output.error || ""}` }, { client: true });
      return route([["cTools", true], ["busCS"], ["busST"]], lbl(ok ? COLORS.audioOut : COLORS.err, "function_call_output"));
    })
    .then(() => flash($("nLlm"), "hot", 900));
}

function handle(evt) { handlers[evt.type]?.(evt.detail || {}); }

// ---------------------------------------------------------------------------
// Modes: demo · live · paused
// ---------------------------------------------------------------------------
const modePill = $("modePill"), modeBtn = $("modeBtn"), modeHint = $("modeHint");
let mode = "demo", lastLive = 0;

const channel = "BroadcastChannel" in window ? new BroadcastChannel("telnyxhotel-flow") : null;
if (channel) {
  channel.onmessage = (m) => {
    lastLive = Date.now();
    if (mode !== "live") setMode("live");
    handle(m.data);
    if (m.data.type === "call_end") setTimeout(() => { if (Date.now() - lastLive > 2500 && mode === "live") setMode("demo"); }, 4000);
  };
}

function setMode(next, { keepFocus = false } = {}) {
  if (next === "live" && mode !== "live") {
    logEntries.length = 0; renderLog();
    for (const p of moving) p.g.remove();
    moving.clear();
    toolFlight = recapFlight = smsFlight = null;
    if (!keepFocus) clearFocus();
  }
  mode = next;
  stopDemo();
  modePill.className = `mode ${next === "paused" ? "idle" : next}`;
  modePill.textContent = t(next === "live" ? "flow.live" : next === "demo" ? "flow.demo" : "flow.paused");
  modePill.dataset.i18n = next === "live" ? "flow.live" : next === "demo" ? "flow.demo" : "flow.paused";
  modeBtn.hidden = next === "live";
  modeBtn.dataset.i18n = next === "demo" ? "flow.pause" : "flow.play";
  modeBtn.textContent = t(modeBtn.dataset.i18n);
  modeHint.hidden = next === "live";
  if (next === "demo") { if (!keepFocus) clearFocus(); runDemo(); }
}
modeBtn.addEventListener("click", () => setMode(mode === "demo" ? "paused" : "demo"));

// Demo: walk the steps, one every few seconds, highlighting each in turn.
let demoTimer = 0, demoIndex = 0;
function runDemo() {
  stopDemo();
  const tickStep = () => {
    if (mode !== "demo") return;
    const step = STEP_ORDER[demoIndex % STEP_ORDER.length];
    demoIndex++;
    focusStep(step);
    narrate(`flow.step.${step}`, stepClass(step), `flow.d.${step}.1`);
    STEPS[step].demo();
  };
  tickStep();
  demoTimer = setInterval(tickStep, 5200);
}
function stopDemo() { clearInterval(demoTimer); }
const stepClass = (step) => ({ setup: "setup", listen: "audio-in", transcribe: "text", think: "kb", tools: "tools",
  speak: "audio-out", email: "mail", sms: "sms", record: "rec", data: "data" }[step] || "setup");

// ---------------------------------------------------------------------------
// Language: follows the reception's choice, and the guest's spoken language
// ---------------------------------------------------------------------------
let followSpoken = true;
function setPageLang(lang) {
  if (I18N.lang === lang) return;
  I18N.set(lang);
  I18N.apply();
  document.querySelectorAll(".lang-switch button").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
  renderRoles();
  renderStepDetail(focused);
  renderCard();
  renderLog();
  if (lastNarr) narrate(lastNarr.tagKey, lastNarr.cls, lastNarr.key, lastNarr.vars);
  else $("narrText").textContent = t("flow.narrIdle");
  modePill.textContent = t(modePill.dataset.i18n);
  modeBtn.textContent = t(modeBtn.dataset.i18n);
}
document.querySelectorAll(".lang-switch button").forEach((b) => b.addEventListener("click", () => {
  followSpoken = false;
  setPageLang(b.dataset.lang);
  savePrefs(b.dataset.lang);
}));

// The page language follows the user's call language (cookie, /api/prefs).
const savePrefs = (lang) => fetch("/api/prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang }) }).catch(() => {});
fetch("/api/prefs").then((r) => (r.ok ? r.json() : null)).then((p) => {
  if (!I18N.has(p?.lang)) return;
  setPageLang(p.lang);
  setSpokenLang(p.lang);
}, () => {});
document.documentElement.dataset.titleKey = "flow.pageTitle";
I18N.set("en");
I18N.apply();
document.querySelectorAll(".lang-switch button").forEach((b) => b.classList.toggle("on", b.dataset.lang === I18N.lang));
renderRoles();
renderCard();
renderLog();
renderStepDetail(null);
setSpokenLang(I18N.lang);
setMode("demo");
