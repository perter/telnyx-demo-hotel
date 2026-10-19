// Call history: recorded calls and the guest messages they sent (own ones;
// admins see everyone's) and a detail view that explains one call end to end — setup trip, conversation
// with latencies, tool calls, server requests, event counts and the raw timeline.
const $ = (id) => document.getElementById(id);
const { esc, api } = Account;

Account.topbar($("topbar"));

let calls = [];
let isAdmin = false;
let current = null;     // call detail being shown
let pollTimer = null;
let timelineLimit = 400;

// ---------- Formatting ----------
const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtT = (ms) => `+${(ms / 1000).toFixed(2)}s`;
// Assistant text can carry expressive markup (<break/>, <emotion>…) meant for the voice.
const speech = (text) => String(text || "").replace(/<break[^>]*\/?>/gi, " ⏸ ").replace(/<\/?(?:emotion|prosody|speak|say-as|emphasis)\b[^>]*>/gi, "").replace(/\s+/g, " ").trim();
const json = (v) => `<pre class="json">${esc(JSON.stringify(v, null, 2))}</pre>`;

function statusChip(s) {
  if (s.status === "live") return '<span class="chip live">● live</span>';
  if (s.status === "failed") return '<span class="chip err">failed</span>';
  if (s.errors) return `<span class="chip warn">${s.errors} error${s.errors > 1 ? "s" : ""}</span>`;
  return '<span class="chip ok">ok</span>';
}
const bookingChip = (b) => (b?.code ? `<span class="chip ok" title="Total €${esc(b.total_eur ?? "?")} · recap ${esc(b.recap || "")}">${esc(b.code)}</span>` : '<span class="muted">—</span>');
// The confirmation texted to the guest (SMS or WhatsApp) and whether it arrived.
function messageChip(m) {
  if (!m) return '<span class="muted">—</span>';
  const channel = m.channel === "whatsapp" ? "WhatsApp" : "SMS";
  const why = m.error || m.reason || "";
  const [kind, label] = /^(delivered|read)$/.test(m.status) ? ["ok", `✓ ${m.status}`]
    : m.status === "not_sent" ? ["err", "✗ not sent"]
    : /fail|unconfirmed/.test(m.status) ? ["err", `✗ ${String(m.status).replace(/_/g, " ")}`]
    : ["warn", `${String(m.status || "sent").replace(/_/g, " ")} · awaiting delivery`];
  return `<span class="chip ${kind}" title="${esc(why)}">${channel} ${esc(label)}</span>${why && kind === "err" ? `<div class="muted" style="font-size:12px">${esc(why)}</div>` : ""}`;
}
const stat = (label, value, sub = "") => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;


// ============================================================
// List
// ============================================================
async function loadList() {
  const data = await api("GET", "/api/calls");
  calls = data.calls;
  isAdmin = data.isAdmin;
  $("listSub").textContent = isAdmin
    ? "Every test call made with the voice concierge, by all users. Click a call to see its full trip."
    : "Your test calls with the voice concierge. Click a call to see its full trip.";
  const uf = $("userFilter");
  uf.hidden = !isAdmin;
  if (isAdmin) {
    const keep = uf.value;
    const byId = new Map(calls.map((c) => [c.user.id, c.user]));
    uf.innerHTML = '<option value="">All users</option>' +
      [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)).map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(u.email)})</option>`).join("");
    uf.value = keep;
  }
  renderList();
}

function filtered() {
  const q = $("search").value.trim().toLowerCase();
  const user = $("userFilter").value;
  const st = $("statusFilter").value;
  return calls.filter((c) => {
    if (user && c.user.id !== user) return false;
    if (st === "booked" && !c.booking?.code) return false;
    if (st === "errors" && !c.errors) return false;
    if (st === "failed" && c.status !== "failed") return false;
    if (st === "live" && c.status !== "live") return false;
    if (!q) return true;
    return [c.voice?.name, c.voice?.id, c.receptionist, c.booking?.code, c.user.name, c.user.email, c.startLanguage, c.id]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });
}

function renderList() {
  const list = filtered();
  const done = list.filter((c) => c.status !== "failed");
  const lat = list.map((c) => c.avgLatencyMs).filter((v) => v != null);
  $("totals").innerHTML = [
    stat("Calls", list.length, `${list.filter((c) => c.status === "failed").length} failed to connect`),
    stat("Talk time", fmtDur(done.reduce((a, c) => a + c.durationMs, 0)), `avg ${fmtDur(done.length ? done.reduce((a, c) => a + c.durationMs, 0) / done.length : null)} per call`),
    stat("Avg response latency", fmtMs(lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null), "guest stops → assistant speaks"),
    stat("Bookings confirmed", list.filter((c) => c.booking?.code).length),
    stat("Guest messages delivered", `${list.filter((c) => /^(delivered|read)$/.test(c.message?.status)).length} / ${list.filter((c) => c.message).length}`, "SMS or WhatsApp confirmations"),
    stat("Tool calls", list.reduce((a, c) => a + (c.toolCalls || 0), 0)),
  ].join("");

  $("listHead").innerHTML = `<th>When</th>${isAdmin ? "<th>User</th>" : ""}<th>Voice</th><th>Language</th>
    <th class="num">Duration</th><th class="num">Guest turns</th><th class="num">Tools</th><th class="num">Avg latency</th><th>Booking</th><th>Guest message</th><th>Status</th>`;
  const cols = isAdmin ? 11 : 10;
  if (!list.length) {
    $("calls").innerHTML = `<tr><td colspan="${cols}" class="empty">${calls.length ? "No calls match the filters." : 'No calls yet. Start one from the <a href="/">booking page</a>.'}</td></tr>`;
    return;
  }
  $("calls").innerHTML = list.map((c) => `
    <tr class="clickable" data-id="${c.id}" tabindex="0">
      <td style="white-space:nowrap">${fmtWhen(c.startedAt)}</td>
      ${isAdmin ? `<td>${esc(c.user.name)}<div class="muted" style="font-size:12px">${esc(c.user.email)}</div></td>` : ""}
      <td>${esc(c.voice?.name || c.voice?.id || "—")}${c.receptionist ? `<div class="muted" style="font-size:12px">as ${esc(c.receptionist)}</div>` : ""}</td>
      <td>${esc(c.startLanguage || "—")}</td>
      <td class="num">${fmtDur(c.durationMs)}</td>
      <td class="num">${c.guestTurns}</td>
      <td class="num">${c.toolCalls}</td>
      <td class="num">${fmtMs(c.avgLatencyMs)}</td>
      <td>${bookingChip(c.booking)}</td>
      <td>${messageChip(c.message)}</td>
      <td>${statusChip(c)}</td>
    </tr>`).join("");
}

$("calls").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-id]");
  if (row) location.hash = `#/call/${row.dataset.id}`;
});
$("calls").addEventListener("keydown", (e) => {
  const row = e.target.closest("tr[data-id]");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); location.hash = `#/call/${row.dataset.id}`; }
});
["search", "userFilter", "statusFilter"].forEach((id) => $(id).addEventListener("input", renderList));
$("refreshBtn").onclick = () => { loadList().catch(showListError); loadMessages(); };

// ---------- Guest messages (booking e-mails, SMS / WhatsApp) ----------
async function loadMessages() {
  const cols = 5;
  try {
    const data = await api("GET", "/api/messages");
    const rows = [
      ...data.email.map((m) => ({ at: m.createdAt, channel: "E-mail", to: m.to.join(", "), what: m.subject, status: m.sandbox ? "sandbox" : m.delivery || m.status, ok: /delivered/.test(m.delivery), user: m.user })),
      ...data.sms.map((m) => ({ at: m.createdAt, channel: m.channel === "whatsapp" ? "WhatsApp" : "SMS", to: m.to || m.guestNumber, what: m.code || m.kind, status: String(m.status).replace(/_/g, " "), ok: /^(delivered|read)$/.test(m.status), err: m.error, user: m.user })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    $("msgSub").textContent = (data.isAdmin ? "All users" : "Sent from your calls") + (data.emailError ? ` · e-mail list unavailable: ${data.emailError}` : "");
    $("msgHead").innerHTML = `<th>When</th><th>Channel</th>${data.isAdmin ? "<th>User</th>" : ""}<th>To</th><th>Booking / subject</th><th>Status</th>`;
    $("messages").innerHTML = rows.length ? rows.map((m) => `<tr>
      <td style="white-space:nowrap">${fmtWhen(m.at)}</td><td>${m.channel}</td>
      ${data.isAdmin ? `<td>${esc(m.user || "—")}</td>` : ""}
      <td class="mono">${esc(m.to || "—")}</td><td>${esc(m.what || "—")}</td>
      <td><span class="chip ${m.ok ? "ok" : m.err ? "err" : "warn"}" title="${esc(m.err || "")}">${esc(m.status || "—")}</span></td>
    </tr>`).join("") : `<tr><td colspan="${cols + (data.isAdmin ? 1 : 0)}" class="empty">No guest messages yet.</td></tr>`;
  } catch (err) {
    $("messages").innerHTML = `<tr><td colspan="${cols}" class="empty">${esc(err.message)}</td></tr>`;
  }
}
const showListError = (err) => ($("calls").innerHTML = `<tr><td class="empty">${esc(err.message)}</td></tr>`);

// ============================================================
// Detail
// ============================================================
const STEP_INFO = {
  voices: { label: "Check voice", color: "server", help: "Server verifies the chosen voice (Telnyx voice list, cached 10 min)." },
  voice_lock: { label: "Wait for voice lock", color: "server", help: "Waits if another call is switching the assistant's voice at the same moment." },
  assistant_voice: { label: "Set assistant voice", color: "down", help: "POST /v2/ai/assistants/{id} — the realtime API takes the voice from the assistant." },
  voice_settle: { label: "Let the voice change settle", color: "server", help: "After a voice change, waits for Telnyx to apply the new assistant version: a conversation opened too soon can start without its tools." },
  upstream_ws: { label: "Open Telnyx WebSocket", color: "down", help: "Server opens the conversation socket to Telnyx with the API key." },
  session_created: { label: "Session created", color: "down", help: "Telnyx starts the conversation (session.created)." },
};

async function showDetail(id) {
  clearTimeout(pollTimer);
  $("listView").hidden = true;
  $("detailView").hidden = false;
  timelineLimit = 400;
  try {
    current = await api("GET", `/api/calls/${encodeURIComponent(id)}`);
  } catch (err) {
    $("dTitle").textContent = "Call not found";
    $("dSub").textContent = err.message;
    return;
  }
  renderDetail();
  window.scrollTo(0, 0);
  if (current.summary.status === "live") pollTimer = setTimeout(() => refreshLive(id), 2000);
}

async function refreshLive(id) {
  if (location.hash !== `#/call/${id}`) return;
  try {
    current = await api("GET", `/api/calls/${encodeURIComponent(id)}`);
    renderDetail();
  } catch { /* keep the last snapshot */ }
  if (current.summary.status === "live") pollTimer = setTimeout(() => refreshLive(id), 2000);
}

function renderDetail() {
  const c = current;
  const s = c.summary;
  const st = c.stats;
  $("dTitle").textContent = fmtWhen(s.startedAt);
  $("dChips").innerHTML = `${statusChip(s)} ${s.booking?.code ? bookingChip(s.booking) : ""} ${s.message ? messageChip(s.message) : ""}`;
  $("dSub").textContent = `${s.user.name} · ${s.voice?.name || s.voice?.id || "?"}${s.receptionist ? ` as ${s.receptionist}` : ""} · ${fmtDur(st.durationMs)}`;
  $("deleteBtn").hidden = s.status === "live";

  $("dStats").innerHTML = [
    stat("Duration", fmtDur(st.durationMs)),
    stat("Connect time", fmtMs(st.connectMs), "click → session created"),
    stat("First audio", fmtMs(st.firstAudioMs), "click → greeting heard"),
    stat("Avg latency", fmtMs(st.latency.avgMs), `p90 ${fmtMs(st.latency.p90Ms)} · max ${fmtMs(st.latency.maxMs)}`),
    stat("Guest turns", st.guestTurns, st.formEdits ? `+ ${st.formEdits} form edits` : ""),
    stat("Assistant replies", st.assistantResponses, st.cancelledResponses ? `${st.cancelledResponses} cut off` : ""),
    stat("Barge-ins", st.bargeIns, "guest spoke over the assistant"),
    stat("Tool calls", st.toolCalls, st.toolFailures ? `${st.toolFailures} failed` : ""),
    stat("Errors", st.errors),
  ].join("");

  renderTrip(c);
  renderInfo(c);
  renderConvo(c);
  renderLatency(c);
  renderTraffic(c);
  renderTools(c);
  renderHttp(c);
  renderCounts(c);
  renderErrors(c);
  renderTimeline();
}

function renderTrip(c) {
  const rows = c.setup.map((step) => ({
    label: STEP_INFO[step.name]?.label || step.name,
    help: STEP_INFO[step.name]?.help || "",
    start: step.start, ms: step.ms,
    color: step.ok ? STEP_INFO[step.name]?.color || "server" : "fail",
    note: step.detail?.skipped || step.detail?.source || step.detail?.error || "",
  }));
  const created = c.stats.connectMs;
  if (c.stats.firstAudioMs != null && created != null) {
    rows.push({ label: "Greeting — first audio", help: "The assistant's first audio chunk reaches the server, on its way to the browser.", start: created, ms: c.stats.firstAudioMs - created, color: "up", note: "" });
  }
  if (!rows.length) {
    $("dTrip").innerHTML = '<p class="muted">No setup steps were recorded.</p>';
    return;
  }
  const total = Math.max(...rows.map((r) => r.start + r.ms), 1);
  $("dTrip").innerHTML = rows.map((r) => `
    <div class="trip-row" title="${esc(r.help)}${r.note ? ` — ${esc(r.note)}` : ""}">
      <span class="name">${esc(r.label)}${r.note ? ` <span class="muted">· ${esc(String(r.note).slice(0, 40))}</span>` : ""}</span>
      <span class="trip-track"><span class="trip-bar ${r.color}" style="left:${(r.start / total) * 100}%;width:${Math.max((r.ms / total) * 100, 0.4)}%"></span></span>
      <span class="ms">${fmtMs(r.ms)}</span>
    </div>`).join("") +
    `<p class="muted" style="font-size:12px;margin:8px 0 0">Total ${fmtMs(total)} · hover a row for what it does.</p>`;
}

function renderInfo(c) {
  const s = c.summary;
  const v = c.voice || {};
  const dv = c.dynamicVariables || {};
  const rows = [
    ["User", `${esc(s.user.name)} <span class="muted">${esc(s.user.email)}</span>`],
    ["Voice", `${esc(v.name || s.voice?.id || "?")} <span class="muted">${esc([v.provider, v.model !== v.provider ? v.model : "", v.accent].filter(Boolean).join(" · "))}</span>`],
    ["Voice id", `<span class="mono">${esc(v.id || s.voice?.id || "")}</span>`],
    ["Receptionist", esc(dv.receptionist_name || "—") + (dv.receptionist_gender ? ` <span class="muted">(${esc(dv.receptionist_gender)})</span>` : "")],
    ["Start language", esc(dv.start_language || "—")],
    ["Greeting", esc(dv.greeting || "—")],
    ["Started", new Date(s.startedAt).toLocaleString()],
    ["Ended", s.endedAt ? new Date(s.endedAt).toLocaleString() : "in progress"],
    ["End reason", esc(s.endReason || "—")],
    ["Browser", `<span class="muted" style="font-size:12px">${esc(c.client?.userAgent || "—")}</span>`],
    ["Call id", `<span class="mono">${esc(c.id)}</span>`],
  ];
  $("dInfo").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

function renderConvo(c) {
  const latencyByResponse = new Map(c.turns.map((t) => [t.responseId, t.latencyMs]));
  if (!c.conversation.length) {
    $("dConvo").innerHTML = '<p class="muted">Nothing was said in this call.</p>';
    return;
  }
  $("dConvo").innerHTML = c.conversation.map((m) => {
    if (m.role === "tool") {
      const result = toolResult(m);
      const where = m.kind === "server" ? '<span class="chip down">runs on Telnyx</span>' : '<span class="chip up">runs in browser</span>';
      return `<details class="msg tool"><summary>⚙️ <strong>${esc(m.name)}</strong> ${where} ${result}
          <span class="muted">${fmtT(m.t)}${m.ms != null ? ` · ${fmtMs(m.ms)}` : ""}</span></summary>
        <div class="tool-body">${m.args ? `<div class="muted" style="font-size:12px">Arguments</div>${json(m.args)}` : ""}
          ${m.output ? `<div class="muted" style="font-size:12px">Output</div>${json(m.output)}` : ""}</div></details>`;
    }
    if (m.role === "guest") {
      const cls = m.source === "form" ? "form" : "guest";
      const src = m.source === "voice" ? "🎙 guest" : m.source === "typed" ? "⌨️ guest (typed)" : "📝 form edit";
      return `<div class="msg ${cls}"><div class="meta"><span>${src}</span><span>${fmtT(m.t)}</span></div>${esc(m.text)}</div>`;
    }
    const lat = latencyByResponse.get(m.responseId);
    return `<div class="msg assistant${m.status === "cancelled" ? " cancelled" : ""}">
      <div class="meta"><span>🛎 assistant</span><span>${fmtT(m.t)}</span>
        ${lat != null ? `<span class="latency-badge" title="Guest stopped → first audio">⏱ ${fmtMs(lat)}</span>` : ""}
        ${m.status === "cancelled" ? '<span class="chip warn">interrupted</span>' : ""}
        ${m.status === "unfinished" ? '<span class="chip warn">cut by hang-up</span>' : ""}
        ${m.status === "in_progress" ? '<span class="chip live">speaking</span>' : ""}</div>${esc(speech(m.text))}</div>`;
  }).join("");
}

function renderLatency(c) {
  const turns = c.turns;
  if (!turns.length) {
    $("dLatency").innerHTML = '<p class="muted">No measured turns (the guest never finished a sentence that got a spoken reply).</p>';
    return;
  }
  const max = Math.max(...turns.map((t) => t.latencyMs), 1);
  const slow = Math.max(c.stats.latency.p90Ms || 0, 1500);
  $("dLatency").innerHTML = turns.map((t, i) => `
    <div class="bar-row" title="${t.source === "typed" ? "Typed message" : "Spoken"} at ${fmtT(t.t)}">
      <span class="muted">#${i + 1}${t.source === "typed" ? " ⌨️" : ""}</span>
      <span class="track"><span class="fill${t.latencyMs >= slow ? " slow" : ""}" style="width:${(t.latencyMs / max) * 100}%"></span></span>
      <span class="v">${fmtMs(t.latencyMs)}</span>
    </div>`).join("") +
    `<p class="muted" style="font-size:12px;margin:8px 0 0">min ${fmtMs(c.stats.latency.minMs)} · median ${fmtMs(c.stats.latency.p50Ms)} · p90 ${fmtMs(c.stats.latency.p90Ms)} · max ${fmtMs(c.stats.latency.maxMs)}</p>`;
}

function renderTraffic(c) {
  const { audio, traffic } = c.stats;
  const rows = [
    ["Guest audio sent", `${audio.inSeconds} s <span class="muted">· ${audio.inFrames} chunks · PCM16 ${audio.inputRate / 1000} kHz</span>`],
    ["Assistant audio received", `${audio.outSeconds} s <span class="muted">· ${audio.outFrames} chunks · ${audio.outputRate / 1000} kHz</span>`],
    ["Browser → Telnyx", `${traffic.up.frames} frames <span class="muted">· ${fmtBytes(traffic.up.bytes)}</span>`],
    ["Telnyx → Browser", `${traffic.down.frames} frames <span class="muted">· ${fmtBytes(traffic.down.bytes)}</span>`],
    ["Timeline events", `${c.stats.timelineEvents}${c.stats.droppedEvents ? ` <span class="chip warn">${c.stats.droppedEvents} not stored</span>` : ""}`],
  ];
  $("dTraffic").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

function toolResult(t) {
  if (t.ok == null) return t.status ? `<span class="chip">${esc(t.status)}</span>` : '<span class="chip warn">no result</span>';
  return t.ok ? '<span class="chip ok">ok</span>' : '<span class="chip err">failed</span>';
}

function renderTools(c) {
  if (!c.tools.length) {
    $("dTools").innerHTML = '<tr><td colspan="7" class="empty">No tools were called.</td></tr>';
    return;
  }
  $("dTools").innerHTML = c.tools.map((t) => `
    <tr>
      <td class="mono">${fmtT(t.t)}</td>
      <td><strong>${esc(t.name)}</strong></td>
      <td>${t.kind === "server" ? '<span class="chip down">Telnyx</span>' : '<span class="chip up">Browser</span>'}</td>
      <td class="num" title="Time until the output was sent back">${fmtMs(t.ms)}</td>
      <td class="num" title="From Telnyx starting the tool to Telnyx marking it complete">${fmtMs(t.totalMs)}</td>
      <td>${toolResult(t)}</td>
      <td style="min-width:280px"><details><summary class="muted" style="cursor:pointer">show</summary>
        <div style="display:grid;gap:6px;margin-top:6px">${json(t.args ?? {})}${t.output ? json(t.output) : ""}</div></details></td>
    </tr>`).join("");
}

function renderHttp(c) {
  const rows = c.http || [];
  $("dHttp").innerHTML = rows.length ? rows.map((h) => `
    <tr>
      <td class="mono">${fmtT(h.t)}</td>
      <td><strong>${esc(h.label)}</strong><div class="mono muted">${esc(h.method)} ${esc(h.url)}</div>
        ${h.detail ? `<details><summary class="muted" style="cursor:pointer;font-size:12px">details</summary>${json(h.detail)}</details>` : ""}</td>
      <td class="num">${h.ok ? `<span class="chip ok">${h.status ?? "ok"}</span>` : `<span class="chip err">${h.status ?? "error"}</span>`}</td>
      <td class="num">${fmtMs(h.ms)}</td>
    </tr>`).join("") : '<tr><td colspan="4" class="empty">No extra requests (voice already set, no recap e-mail).</td></tr>';
}

function renderCounts(c) {
  const rows = [
    ...Object.entries(c.counts.up).map(([type, n]) => ({ type, n, dir: "up" })),
    ...Object.entries(c.counts.down).map(([type, n]) => ({ type, n, dir: "down" })),
  ].sort((a, b) => b.n - a.n);
  $("dCounts").innerHTML = rows.length ? rows.map((r) => `
    <tr><td class="mono">${esc(r.type)}</td>
      <td>${DIR_CHIP[r.dir]}</td>
      <td class="num">${r.n}</td></tr>`).join("") : '<tr><td colspan="3" class="empty">No events.</td></tr>';
}

function renderErrors(c) {
  const errs = c.errors || [];
  $("dErrorsCard").hidden = !errs.length;
  $("dErrors").innerHTML = errs.map((e) => `
    <p style="margin:0 0 8px"><span class="mono muted">${fmtT(e.t)}</span> <span class="chip ${e.code === "conversation_ended" ? "" : "err"}">${esc(e.code || "error")}</span> ${esc(e.message || "")}</p>`).join("");
}

// ---------- Timeline ----------
function hint(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "conversation.item.input_audio_transcription.completed": return d.transcript;
    case "response.done": return d._assembled_text ? `“${d._assembled_text.slice(0, 90)}${d._assembled_text.length > 90 ? "…" : ""}” · ${d.response?.status || ""}` : d.response?.status;
    case "conversation.item.created": return d.item?.type === "function_call" ? `call ${d.item.name}` : d.item?.type;
    case "conversation.item.create":
      return d.item?.type === "function_call_output" ? `output for ${d.item.call_id}` : (d.item?.content || []).map((x) => x.text).join(" ");
    case "response.tool_call.started": return d.tool_call?.name;
    case "error": return d.error?.message || d.message;
    case "http": return `${d.label} → ${d.status ?? ""} in ${fmtMs(d.ms)}`;
    case "call.end": return d.reason;
    default:
      if (ev.type.startsWith("setup.")) return `${fmtMs(d.ms)}${d.ok === false ? " · failed" : ""}`;
      return "";
  }
}

const DIR_CHIP = { up: '<span class="chip up">→ Telnyx</span>', down: '<span class="chip down">← Telnyx</span>', server: '<span class="chip server">server</span>' };

function renderTimeline() {
  if (!current) return;
  const dirs = new Set([...document.querySelectorAll("[data-dir]")].filter((b) => b.checked).map((b) => b.dataset.dir));
  const q = $("tlSearch").value.trim().toLowerCase();
  const events = current.timeline
    .map((ev, i) => ({ ...ev, i }))
    .filter((ev) => dirs.has(ev.dir) && (!q || ev.type.toLowerCase().includes(q) || JSON.stringify(ev.data || "").toLowerCase().includes(q)));
  const shown = events.slice(0, timelineLimit);
  $("dTimeline").innerHTML = (shown.length ? shown.map((ev) => {
    const h = hint(ev);
    return `<div class="tl-row" data-i="${ev.i}" tabindex="0">
      <span class="t">${fmtT(ev.t)}</span>
      <span class="dir">${DIR_CHIP[ev.dir] || ""}</span>
      <span class="type">${esc(ev.type)}${h ? `<span class="hint">${esc(String(h).slice(0, 140))}</span>` : ""}</span>
    </div>`;
  }).join("") : '<p class="empty">No events match.</p>') +
    (events.length > shown.length ? `<p style="padding:12px;text-align:center"><button class="btn ghost small" id="moreEvents">Show ${Math.min(400, events.length - shown.length)} more (${events.length - shown.length} hidden)</button></p>` : "");
  $("moreEvents")?.addEventListener("click", () => { timelineLimit += 400; renderTimeline(); });
}

function toggleEvent(row) {
  const open = row.querySelector(".tl-detail");
  if (open) return open.remove();
  const ev = current.timeline[Number(row.dataset.i)];
  const div = document.createElement("div");
  div.className = "tl-detail";
  div.innerHTML = json(ev.data ?? {});
  div.addEventListener("click", (e) => e.stopPropagation());
  row.append(div);
}
$("dTimeline").addEventListener("click", (e) => { const row = e.target.closest(".tl-row"); if (row) toggleEvent(row); });
$("dTimeline").addEventListener("keydown", (e) => {
  const row = e.target.closest(".tl-row");
  if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleEvent(row); }
});
document.querySelectorAll("[data-dir]").forEach((b) => b.addEventListener("change", () => { timelineLimit = 400; renderTimeline(); }));
$("tlSearch").addEventListener("input", () => { timelineLimit = 400; renderTimeline(); });

$("downloadBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `call-${current.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("deleteBtn").onclick = async () => {
  if (!confirm("Delete this call from the history?")) return;
  try {
    await api("DELETE", `/api/calls/${current.id}`);
    location.hash = "";
  } catch (err) { alert(err.message); }
};
$("backBtn").onclick = () => (location.hash = "");

// ============================================================
// Routing: #/call/<id> shows a call, anything else the list
// ============================================================
function route() {
  const m = location.hash.match(/^#\/call\/([\w-]+)$/);
  if (m) return showDetail(m[1]);
  clearTimeout(pollTimer);
  current = null;
  $("detailView").hidden = true;
  $("listView").hidden = false;
  loadList().catch(showListError);
  loadMessages();
}
addEventListener("hashchange", route);
Account.ready.then(route);
