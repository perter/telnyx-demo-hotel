// Guest stats (admins): calls made without an account, counted in the
// browser from /api/admin/guests (one row per call, with its Telnyx insights
// and the country of its origin IP). Days and hours are in the admin's own
// time zone. One tab at a time, remembered in the URL (#where…).
const $ = (id) => document.getElementById(id);
const { esc, api } = Account;

Account.topbar($("topbar"));

const STAGE_LABEL = {
  failed: "Didn't connect", silent: "Never spoke", talked: "Talked only", hotel: "Chose a hotel", dates: "Gave dates",
  guests: "Gave guests", availability: "Checked availability", room: "Picked a room", details: "Gave name / contact", booked: "Booked",
};
// The funnel: calls that got at least this far.
const FUNNEL = [
  ["silent", "Connected"], ["talked", "Spoke"], ["hotel", "Chose a hotel"], ["dates", "Gave dates"], ["guests", "Gave guests"],
  ["availability", "Checked availability"], ["room", "Picked a room"], ["details", "Gave name / contact"], ["booked", "Booked"],
];
const ENDED = { guest: "Guest hung up", assistant: "Receptionist", time_limit: "5-min limit", error: "Error", other: "Other" };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const regionName = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const dur = (ms) => (ms == null ? "—" : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);
const score = (x) => (x == null ? "—" : x.toFixed(2));
const plain = (s) => String(s ?? "").replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").replace(/:[a-z_]+:/g, "").trim();
const stat = (label, value, sub) => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;

const countryName = (code) => { try { return regionName?.of(code) || code; } catch { return code; } };
const where = (c) => (c.country ? countryName(c.country) : null);

// Horizontal bars: [label, count, extra?] rows against a total.
function bars(rows, total, { cls = "" } = {}) {
  if (!rows.length) return '<p class="muted">No data yet.</p>';
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return rows.map(([label, n, extra]) => `
    <div class="bar-row ${cls}">
      <span class="bar-label">${esc(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(n / max) * 100}%"></span></span>
      <span class="bar-num">${n} <span class="muted">${pct(n, total)}</span>${extra ? ` <span class="muted">${esc(extra)}</span>` : ""}</span>
    </div>`).join("");
}

const countBy = (calls, key) => {
  const m = new Map();
  for (const c of calls) { const k = key(c); if (k != null) m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

function kpis(calls) {
  const booked = calls.filter((c) => c.booked);
  const analysed = calls.filter((c) => c.insights?.status === "completed");
  const scores = analysed.map((c) => c.insights.sentimentScore).filter((x) => x != null);
  const missed = analysed.filter((c) => c.insights.missed === true);
  const silent = calls.filter((c) => c.stage === "silent" || c.stage === "failed");
  const durations = calls.map((c) => c.durationMs);
  const value = booked.reduce((a, c) => a + (c.totalEur || 0), 0);
  $("kpis").innerHTML = [
    stat("Guest calls", calls.length, `${new Set(calls.map((c) => c.guestId)).size} guest sessions`),
    stat("Booked", pct(booked.length, calls.length), `${booked.length} of ${calls.length} calls`),
    stat("Avg duration", dur(avg(durations)), `median ${dur(median(durations))}`),
    stat("Avg sentiment", score(avg(scores)), `0–1 · ${analysed.length} calls analysed`),
    stat("Missed opportunities", pct(missed.length, analysed.length), `${missed.length} of ${analysed.length} analysed`),
    stat("Left without speaking", pct(silent.length, calls.length), `${silent.length} calls`),
    stat("Booked value (demo)", `€${value.toLocaleString("en")}`, booked.length ? `avg €${Math.round(value / booked.length)}` : ""),
  ].join("");
}

function heatmap(calls) {
  const grid = DAYS.map(() => Array(24).fill(0));
  for (const c of calls) {
    const d = new Date(c.startedAt);
    grid[(d.getDay() + 6) % 7][d.getHours()]++;
  }
  const max = Math.max(1, ...grid.flat());
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const cell = (n, title) => `<span class="hm-cell${n / max > 0.55 ? " hot" : ""}" style="--v:${n / max}" title="${esc(title)}">${n || ""}</span>`;
  let html = `<span></span>${hours.map((h) => `<span class="hm-h">${h}</span>`).join("")}<span class="hm-h">Σ</span>`;
  grid.forEach((row, d) => {
    html += `<span class="hm-d">${DAYS[d]}</span>${row.map((n, h) => cell(n, `${DAYS[d]} ${h}:00–${h + 1}:00 · ${n} call${n === 1 ? "" : "s"}`)).join("")}<span class="hm-t">${row.reduce((a, b) => a + b, 0) || ""}</span>`;
  });
  html += `<span class="hm-d">Σ</span>${hours.map((h) => `<span class="hm-t">${grid.reduce((a, r) => a + r[h], 0) || ""}</span>`).join("")}<span></span>`;
  $("heatmap").innerHTML = html;
  $("tzNote").textContent = `Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

function funnel(calls) {
  const idx = Object.fromEntries(STAGES.map((s, i) => [s, i]));
  $("funnel").innerHTML = bars(FUNNEL.map(([s, label]) => [label, calls.filter((c) => idx[c.stage] >= idx[s]).length]), calls.length, { cls: "funnel" });
}

function group(calls) {
  const analysed = calls.filter((c) => c.insights?.status === "completed");
  const scores = analysed.map((c) => c.insights.sentimentScore).filter((x) => x != null);
  return {
    n: calls.length,
    duration: avg(calls.map((c) => c.durationMs)),
    turns: avg(calls.map((c) => c.guestTurns)),
    sentiment: avg(scores),
    positive: [analysed.filter((c) => c.insights.sentiment?.includes("positive")).length, analysed.length],
    missed: [analysed.filter((c) => c.insights.missed === true).length, analysed.length],
    guestEnded: calls.filter((c) => c.endedBy === "guest").length,
    assistantEnded: calls.filter((c) => c.endedBy === "assistant").length,
    limit: calls.filter((c) => c.endedBy === "time_limit").length,
    avatar: calls.filter((c) => c.avatar).length,
  };
}

function compare(calls) {
  const talked = calls.filter((c) => c.stage !== "failed" && c.stage !== "silent");
  const b = group(talked.filter((c) => c.booked));
  const n = group(talked.filter((c) => !c.booked));
  const row = (label, f) => `<tr><td>${esc(label)}</td><td class="num">${esc(f(b))}</td><td class="num">${esc(f(n))}</td></tr>`;
  $("compare").innerHTML = `
    <thead><tr><th>Calls where the guest spoke</th><th class="num">Booked</th><th class="num">Not booked</th></tr></thead>
    <tbody>
      ${row("Calls", (g) => g.n)}
      ${row("Avg duration", (g) => dur(g.duration))}
      ${row("Avg guest turns", (g) => (g.turns == null ? "—" : g.turns.toFixed(1)))}
      ${row("Avg sentiment (0–1)", (g) => score(g.sentiment))}
      ${row("Positive sentiment", (g) => pct(...g.positive))}
      ${row("Missed opportunity", (g) => pct(...g.missed))}
      ${row("Guest hung up", (g) => pct(g.guestEnded, g.n))}
      ${row("Receptionist ended it", (g) => pct(g.assistantEnded, g.n))}
      ${row("Hit the 5-minute limit", (g) => pct(g.limit, g.n))}
      ${row("Video avatar on", (g) => pct(g.avatar, g.n))}
    </tbody>`;
  return { b, n };
}

// Plain-language reasons, from the counts.
function findings(calls, { b, n }) {
  const out = [];
  const booked = calls.filter((c) => c.booked);
  const open = calls.filter((c) => !c.booked);
  if (!calls.length) { $("findings").innerHTML = "<li>No guest calls in this period.</li>"; return; }
  out.push(`<strong>${pct(booked.length, calls.length)}</strong> of guest calls ended with a booking (${booked.length} of ${calls.length}).`);

  const failed = open.filter((c) => c.stage === "failed");
  const silent = open.filter((c) => c.stage === "silent");
  if (silent.length) out.push(`<strong>${silent.length}</strong> of ${open.length} unbooked calls (${pct(silent.length, open.length)}) ended before the guest said a word, after ${dur(avg(silent.map((c) => c.durationMs)))} on average: a look around, a microphone that wasn't allowed, or a guest who expected to type.`);
  if (failed.length) out.push(`<strong>${failed.length}</strong> call${failed.length === 1 ? "" : "s"} never connected to the assistant (see Call history for the error).`);

  const engaged = open.filter((c) => !["failed", "silent"].includes(c.stage));
  if (engaged.length) {
    const [top, count] = countBy(engaged, (c) => c.stage)[0];
    const why = {
      talked: "they talked but never named a hotel: browsing, or asking questions rather than booking",
      hotel: "they picked a hotel but never gave dates",
      dates: "they gave dates but not the number of guests",
      guests: "the stay was complete but availability was never checked",
      availability: "they heard the rooms and prices but didn't pick a room",
      room: "they chose a room but stopped before giving a name",
      details: "they stopped at the very last step (name, e-mail or phone), often a misheard e-mail address or no wish to share contact details",
    }[top];
    out.push(`Of the <strong>${engaged.length}</strong> unbooked calls where the guest spoke, the most common stopping point is <strong>${esc(STAGE_LABEL[top])}</strong> (${count}): ${why}.`);
    const late = engaged.filter((c) => ["availability", "room", "details"].includes(c.stage)).length;
    if (late) out.push(`<strong>${late}</strong> unbooked call${late === 1 ? "" : "s"} got as far as availability or later: these guests were close to booking.`);
  }
  if (b.n && n.n && b.duration && n.duration) {
    out.push(`Booked calls last <strong>${dur(b.duration)}</strong> on average with ${b.turns.toFixed(1)} guest turns; unbooked calls where the guest spoke last ${dur(n.duration)} with ${n.turns.toFixed(1)} turns.`);
  }
  if (b.sentiment != null && n.sentiment != null) {
    out.push(`Sentiment: <strong>${score(b.sentiment)}</strong> on booked calls vs <strong>${score(n.sentiment)}</strong> on unbooked ones${Math.abs(b.sentiment - n.sentiment) < 0.05 ? " — about the same, so the drop-offs aren't about the guest's mood" : ""}.`);
  }
  const limit = calls.filter((c) => c.endedBy === "time_limit");
  if (limit.length) out.push(`<strong>${limit.length}</strong> call${limit.length === 1 ? "" : "s"} hit the 5-minute guest limit (${limit.filter((c) => c.booked).length} booked anyway).`);
  const missed = calls.filter((c) => c.insights?.missed === true);
  if (missed.length) out.push(`<strong>${missed.length}</strong> call${missed.length === 1 ? "" : "s"} had a missed opportunity (${missed.filter((c) => !c.booked).length} of them unbooked): see <a href="#insights">Insights</a>.`);
  $("findings").innerHTML = out.map((s) => `<li>${s}</li>`).join("");
}

function sentiment(calls) {
  const analysed = calls.filter((c) => c.insights?.status === "completed");
  const label = (c) => (c.insights.sentiment ? c.insights.sentiment[0].toUpperCase() + c.insights.sentiment.slice(1) : "Not stated");
  const rows = countBy(analysed, label).map(([l, k]) => {
    const s = avg(analysed.filter((c) => label(c) === l).map((c) => c.insights.sentimentScore).filter((x) => x != null));
    return [l, k, s == null ? "" : `· avg ${score(s)}`];
  });
  const pending = calls.length - analysed.length;
  $("sentiment").innerHTML = bars(rows, analysed.length, { cls: "sent" }) +
    (pending ? `<p class="muted hint" style="margin:10px 0 0">${pending} call${pending === 1 ? "" : "s"} without insights (no conversation, or Telnyx hasn't analysed it yet).</p>` : "");
}

function missed(calls) {
  const analysed = calls.filter((c) => c.insights?.status === "completed");
  const list = analysed.filter((c) => c.insights.missed === true);
  const unclear = analysed.filter((c) => c.insights.missed == null && c.insights.missedText);
  const item = (c) => `<li><a href="/history.html#/call/${esc(c.id)}">${esc(new Date(c.startedAt).toLocaleString())}</a>
      ${c.booked ? '<span class="chip ok">booked</span>' : `<span class="chip">${esc(STAGE_LABEL[c.stage])}</span>`}
      <p>${esc(plain(c.insights.missedText))}</p></li>`;
  $("missed").innerHTML = (list.length
    ? `<ul class="insight-list">${list.map(item).join("")}</ul>`
    : `<p class="muted">None flagged in ${analysed.length} analysed call${analysed.length === 1 ? "" : "s"}.</p>`) +
    (unclear.length ? `<details style="margin-top:10px"><summary class="muted">${unclear.length} unclear answer${unclear.length === 1 ? "" : "s"}</summary><ul class="insight-list">${unclear.map(item).join("")}</ul></details>` : "");
}

// World map: each country shaded by its share of the calls (outlines in assets/world-map.json).
let worldMap = null;
const mapReady = fetch("/assets/world-map.json").then((r) => r.json()).then((m) => (worldMap = m), () => null);

function whereFrom(calls, geo) {
  const located = calls.filter((c) => c.country);
  const byCountry = countBy(located, (c) => c.country);
  const rows = byCountry.map(([code, k]) => [countryName(code), k, `· ${located.filter((c) => c.country === code && c.booked).length} booked`]);
  $("where").innerHTML = located.length ? bars(rows, located.length) : '<p class="muted">No call with a known country in this period.</p>';

  const unknown = calls.length - located.length;
  const noIp = calls.filter((c) => !c.ip).length;
  $("whereNote").textContent = [
    unknown ? `${unknown} of ${calls.length} calls have no known country${noIp ? ` (${noIp} made before this was available, or from a private network)` : ""}.` : "",
    geo ? "" : "Country data is missing on this server: run npm run geo:update.",
  ].filter(Boolean).join(" ");

  mapReady.then(() => {
    if (!worldMap) { $("map").outerHTML = '<p class="muted">The map could not be loaded.</p>'; return; }
    const count = new Map(byCountry);
    const max = Math.max(1, ...count.values());
    const svg = $("map");
    svg.setAttribute("viewBox", `0 0 ${worldMap.width} ${worldMap.height}`);
    svg.innerHTML = Object.entries(worldMap.countries).map(([code, d]) => {
      const n = count.get(code) || 0;
      const title = `${countryName(code)}: ${n} call${n === 1 ? "" : "s"}${n ? ` (${pct(n, located.length)})` : ""}`;
      return `<path d="${d}" class="${n ? "on" : ""}" style="--v:${n ? 0.25 + 0.75 * (n / max) : 0}"><title>${esc(title)}</title></path>`;
    }).join("");
    $("mapLegend").innerHTML = located.length
      ? `<span>1</span><span class="map-scale"></span><span>${max} call${max === 1 ? "" : "s"}</span>` : "";
  });
}

function table(calls) {
  if (!calls.length) { $("calls").innerHTML = '<tr><td colspan="7" class="empty">No guest calls in this period.</td></tr>'; return; }
  $("calls").innerHTML = calls.map((c) => {
    const ins = c.insights?.status === "completed" ? c.insights : null;
    const stage = c.booked ? `<span class="chip ok">Booked${c.totalEur ? ` · €${esc(c.totalEur)}` : ""}</span>` : `<span class="chip${c.stage === "failed" ? " err" : ""}">${esc(STAGE_LABEL[c.stage])}</span>`;
    const summary = ins?.summary ? plain(ins.summary) : "";
    return `<tr>
      <td style="white-space:nowrap"><a href="/history.html#/call/${esc(c.id)}">${esc(new Date(c.startedAt).toLocaleString())}</a></td>
      <td class="num">${esc(dur(c.durationMs))}</td>
      <td>${stage}</td>
      <td>${esc(ENDED[c.endedBy] || c.endedBy)}</td>
      <td>${c.country ? esc(where(c)) : '<span class="muted">—</span>'}</td>
      <td>${ins?.sentiment ? `${esc(ins.sentiment)} <span class="muted">${esc(score(ins.sentimentScore))}</span>` : '<span class="muted">—</span>'}</td>
      <td class="summary-cell">${ins ? `<details><summary>${esc(summary.length > 110 ? `${summary.slice(0, 110)}…` : summary || "Insights")}</summary>
        ${ins.items.map((i) => `<h4>${esc(i.name)}</h4><p>${esc(plain(i.text))}</p>`).join("")}</details>` : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join("");
}

// Traffic tab: requests to the Edge function (not calls), from /api/admin/traffic.
const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const fmtMb = (b) => (b == null ? "—" : `${Math.round(b / 1048576)} MB`);

function trafficChart(t) {
  const W = 960, H = 220, L = 44, B = 22, T = 8;
  const n = t.series.length;
  const max = Math.max(1, ...t.series.map((b) => b.requests));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const bw = (W - L) / n;
  const label = (iso) => {
    const d = new Date(iso);
    return t.bucketHours >= 24 ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" }) : `${d.getHours()}:00`;
  };
  let svg = "";
  for (const v of [0, top / 2, top]) svg += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v.toLocaleString()}</text>`;
  t.series.forEach((b, i) => {
    const other = Math.max(0, b.requests - b.success - b.clientErrors - b.errors);
    const x = L + i * bw + bw * 0.12, w = bw * 0.76;
    let base = 0;
    const tip = `${label(b.t)}${t.bucketHours >= 24 ? "" : `–${(new Date(b.t).getHours() + 1) % 24}:00`} · ${b.requests.toLocaleString()} requests: ${b.success} 2xx, ${other} redirects/upgrades, ${b.clientErrors} 4xx, ${b.errors} 5xx · p95 ${fmtMs(b.p95Ms)}`;
    svg += `<g><title>${esc(tip)}</title>`;
    for (const [v, cls] of [[b.success, "ok"], [other, "other"], [b.clientErrors, "warn"], [b.errors, "err"]]) {
      if (v) svg += `<rect class="${cls}" x="${x}" y="${y(base + v)}" width="${w}" height="${y(base) - y(base + v)}"/>`;
      base += v;
    }
    svg += `<rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent"/></g>`;
    const every = n > 12 ? 3 : 1;
    if (i % every === 0) svg += `<text class="axis" x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(label(b.t))}</text>`;
  });
  $("trafficChart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Requests per ${t.bucketHours >= 24 ? "day" : "hour"}">${svg}</svg>`;
}

async function loadTraffic() {
  $("trafficKpis").innerHTML = "";
  $("trafficChart").innerHTML = '<p class="muted">Loading…</p>';
  try {
    const t = await api("GET", `/api/admin/traffic?days=${encodeURIComponent($("days").value)}`);
    const s = t.totals;
    const other = Math.max(0, s.requests - s.success - s.clientErrors - s.errors);
    $("trafficNote").textContent = t.hours <= 24 ? "Last 24 hours, per hour (your time)" : `Last 7 days, per day (UTC)${t.capped ? " · Telnyx keeps 7 days of metrics" : ""}`;
    $("trafficKpis").innerHTML = [
      stat("Requests", s.requests.toLocaleString(), `function ${t.function}`),
      stat("Success (2xx)", pct(s.success, s.requests), `${s.success.toLocaleString()} requests`),
      stat("Redirects & upgrades", pct(other, s.requests), "login redirects, call WebSockets"),
      stat("Client errors (4xx)", pct(s.clientErrors, s.requests), `${s.clientErrors.toLocaleString()} · mostly signed-out requests`),
      stat("Server errors (5xx)", pct(s.errors, s.requests), `${s.errors.toLocaleString()} requests`),
      stat("Latency (median)", fmtMs(s.latencyP50Ms), `p95 ${fmtMs(s.latencyP95Ms)} · p99 ${fmtMs(s.latencyP99Ms)}`),
      stat("Memory", fmtMb(s.memoryAvgBytes), `peak ${fmtMb(s.memoryMaxBytes)}`),
    ].join("");
    trafficChart(t);
  } catch (err) {
    $("trafficChart").innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}
let trafficShown = null; // the period the Traffic tab was loaded for

// Contacts tab: guests who left an e-mail or phone number (all kept, not per
// period), and the follow-up e-mail sent to them (template edited here).
const LANG_NAME = { en: "English", fr: "French", de: "German", it: "Italian", es: "Spanish", nl: "Dutch" };
let contacts = [];
let emailSetup = null; // { enabled, from, sandbox, overrideTo } of /email.html
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function followUp(c) {
  const e = c.emailed;
  if (!e) return '<span class="muted">Not sent</span>';
  const title = `Sent ${new Date(e.at).toLocaleString()} by ${e.by}${e.redirected ? ` (redirected to ${e.to})` : ""}${c.emailCount > 1 ? ` · ${c.emailCount} e-mails in all` : ""}`;
  return `<span class="chip${e.sandbox ? " warn" : " ok"}" title="${esc(title)}">${e.sandbox ? "Sandbox" : "Sent"} ${esc(day(e.at))}${c.emailCount > 1 ? ` ×${esc(c.emailCount)}` : ""}</span>`;
}

function contactsTable() {
  $("contactsCount").textContent = contacts.length ? `(${contacts.length})` : "";
  $("contactsCsv").disabled = !contacts.length;
  if (!contacts.length) { $("contacts").innerHTML = '<tr><td colspan="9" class="empty">No guest has left a contact yet.</td></tr>'; return; }
  const canSend = emailSetup?.enabled;
  $("contacts").innerHTML = contacts.map((c) => `<tr>
    <td style="white-space:nowrap">${esc(new Date(c.createdAt).toLocaleString())}</td>
    <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<span class="muted">—</span>'}</td>
    <td style="white-space:nowrap">${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '<span class="muted">—</span>'}</td>
    <td>${esc(LANG_NAME[c.lang] || c.lang)}</td>
    <td>${c.country ? esc(countryName(c.country)) : '<span class="muted">—</span>'}</td>
    <td class="num">${esc(c.calls)}</td>
    <td>${c.stage ? `<span class="chip${c.stage === "booked" ? " ok" : ""}">${esc(STAGE_LABEL[c.stage])}</span>` : '<span class="muted">No call</span>'}</td>
    <td>${c.email ? followUp(c) : '<span class="muted">No e-mail</span>'}</td>
    <td><div class="row-actions">
      ${c.email ? `<button class="btn small" type="button" data-send="${esc(c.id)}"${canSend ? "" : ' disabled title="Turn on Telnyx Email in E-mail first"'}>${c.emailed ? "Send again" : "Send e-mail"}</button>` : ""}
      <button class="btn danger small" type="button" data-delete="${esc(c.id)}">Delete</button>
    </div></td>
  </tr>`).join("");
}

function setupNote() {
  const s = emailSetup;
  $("emailSetup").innerHTML = !s ? ""
    : !s.enabled ? 'Telnyx Email is off, so follow-up e-mails can\'t be sent: turn it on in <a href="/email.html">E-mail</a>.'
    : `Sent with Telnyx Email from <strong>${esc(s.from)}</strong>${s.sandbox ? ' · <span class="chip warn">sandbox: nothing is delivered</span>' : ""}${s.overrideTo ? ` · every e-mail goes to <strong>${esc(s.overrideTo)}</strong> instead (see <a href="/email.html">E-mail</a>)` : ""}.`;
}

async function loadContacts() {
  try {
    const [list, tpl] = await Promise.all([api("GET", "/api/admin/contacts"), api("GET", "/api/admin/contacts/template")]);
    contacts = list.contacts;
    emailSetup = tpl.email;
    templateDefaults = tpl.defaults;
    if (!templateDirty) fillTemplate(tpl.template);
    setupNote();
    contactsTable();
  } catch (err) {
    $("contacts").innerHTML = `<tr><td colspan="9" class="empty form-error">${esc(err.message)}</td></tr>`;
  }
}
$("contacts").addEventListener("click", async (e) => {
  const send = e.target.closest("[data-send]");
  if (send) {
    const c = contacts.find((x) => x.id === send.dataset.send);
    const to = emailSetup?.overrideTo || c.email;
    if (!confirm(`Send the follow-up e-mail to ${to}${to !== c.email ? ` (redirect for ${c.email})` : ""}?${templateDirty ? "\n\nThe template has unsaved changes: the saved version is sent." : ""}`)) return;
    send.disabled = true;
    send.textContent = "Sending…";
    try {
      const { contact } = await api("POST", `/api/admin/contacts/${encodeURIComponent(c.id)}/email`);
      contacts = contacts.map((x) => (x.id === c.id ? { ...x, ...contact } : x));
    } catch (err) { alert(`Not sent: ${err.message}`); }
    contactsTable();
    return;
  }
  const id = e.target.closest("[data-delete]")?.dataset.delete;
  const c = contacts.find((x) => x.id === id);
  if (!c || !confirm(`Delete the contact ${c.email || c.phone}?`)) return;
  try {
    await api("DELETE", `/api/admin/contacts/${encodeURIComponent(id)}`);
    contacts = contacts.filter((x) => x.id !== id);
    contactsTable();
  } catch (err) { alert(err.message); }
});
$("contactsCsv").onclick = () => {
  const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const rows = [["Left on", "E-mail", "Phone", "Language", "Country", "Calls", "Got to", "Follow-up sent"],
    ...contacts.map((c) => [c.createdAt, c.email, c.phone, LANG_NAME[c.lang] || c.lang, c.country ? countryName(c.country) : "", c.calls, c.stage ? STAGE_LABEL[c.stage] : "", c.emailed?.at || ""])];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" }));
  a.download = `telnyxhotel-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// The follow-up e-mail template, with a live preview rendered by the server.
const tform = $("templateForm");
let templateDefaults = null, templateDirty = false, previewTimer = null;
function fillTemplate(t) {
  for (const [k, v] of Object.entries(t)) if (tform.elements[k]) tform.elements[k].value = v;
  templateDirty = false;
  preview();
}
const templateValues = () => Object.fromEntries([...tform.elements].filter((el) => el.name).map((el) => [el.name, el.value]));
async function preview() {
  try {
    const r = await api("POST", "/api/admin/contacts/template/preview", templateValues());
    $("templatePreview").srcdoc = r.html;
    $("previewSubject").textContent = r.subject;
    $("templateError").textContent = "";
  } catch (err) { $("templateError").textContent = err.message; }
}
tform.addEventListener("input", () => {
  templateDirty = true;
  $("templateOk").textContent = "";
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, 400);
});
tform.onsubmit = async (e) => {
  e.preventDefault();
  $("templateSave").disabled = true;
  try {
    fillTemplate((await api("PUT", "/api/admin/contacts/template", templateValues())).template);
    $("templateOk").textContent = "Saved. New follow-up e-mails use this version.";
  } catch (err) { $("templateError").textContent = err.message; }
  $("templateSave").disabled = false;
};
$("templateReset").onclick = () => {
  if (!templateDefaults || !confirm("Replace the fields with the default template? Nothing is saved until you press Save.")) return;
  fillTemplate(templateDefaults);
  templateDirty = true;
};
$("templateBtn").onclick = () => {
  const open = $("templateCard").hidden;
  $("templateCard").hidden = !open;
  $("templateBtn").setAttribute("aria-expanded", String(open));
  if (open) $("templateCard").scrollIntoView({ behavior: "smooth", block: "start" });
};

let STAGES = [];
async function load() {
  $("error").textContent = "";
  $("refreshBtn").disabled = true;
  try {
    const data = await api("GET", `/api/admin/guests?days=${encodeURIComponent($("days").value)}`);
    STAGES = data.stages;
    const calls = data.calls;
    kpis(calls);
    heatmap(calls);
    funnel(calls);
    findings(calls, compare(calls));
    sentiment(calls);
    missed(calls);
    whereFrom(calls, data.geo);
    table(calls);
    if (data.insightsError) $("error").textContent = `Some insights could not be read from Telnyx: ${data.insightsError}`;
    if (data.limited) $("error").textContent += " Only the most recent 1000 calls are counted.";
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("refreshBtn").disabled = false;
  }
}

// Tabs: one panel at a time, kept in the URL hash.
const TABS = [...document.querySelectorAll(".page-tabs [role=tab]")].map((b) => b.dataset.tab);
function showTab(name) {
  if (!TABS.includes(name)) name = TABS[0];
  for (const t of TABS) {
    const on = t === name;
    const tab = $(`tab-${t}`);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (name === "traffic" && trafficShown !== $("days").value) { trafficShown = $("days").value; loadTraffic(); }
}
document.querySelector(".page-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[role=tab]");
  if (tab) history.replaceState(null, "", `#${tab.dataset.tab}`), showTab(tab.dataset.tab);
});
document.querySelector(".page-tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(document.activeElement?.dataset.tab);
  if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  history.replaceState(null, "", `#${next}`);
  showTab(next);
  $(`tab-${next}`).focus();
});
showTab(location.hash.slice(1));
addEventListener("hashchange", () => showTab(location.hash.slice(1)));

const reload = () => {
  trafficShown = null;
  load();
  loadContacts();
  if (!$("panel-traffic").hidden) showTab("traffic");
};
$("days").onchange = reload;
$("refreshBtn").onclick = reload;
load();
loadContacts();
