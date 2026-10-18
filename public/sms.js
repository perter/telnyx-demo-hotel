// Admin: the booking confirmation sent to the guest's mobile — channel (SMS
// with Telnyx Messaging, or WhatsApp with an approved template) and the
// delivery log.
const $ = (id) => document.getElementById(id);
const { esc, api } = Account;
let profiles = [];
let whatsapp = { numbers: [], templates: [] };
let saved = null;

Account.topbar($("topbar"));


const statusChip = (status) => {
  const kind = /^(delivered|sent)$/.test(status) ? "ok" : /fail|not_sent|unconfirmed/.test(status) ? "err" : "warn";
  return `<span class="chip ${kind}">${esc((status || "—").replace(/_/g, " "))}</span>`;
};

function renderProfiles(selected) {
  const has = profiles.some((p) => p.id === selected);
  $("profileId").innerHTML = `<option value="">— choose a profile —</option>`
    + (selected && !has ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : "")
    + profiles.map((p) => `<option value="${esc(p.id)}"${p.id === selected ? " selected" : ""}>${esc(p.name)}${p.enabled ? "" : " (disabled)"}</option>`).join("");
  showProfile();
}

// Destinations and senders of the chosen profile.
async function showProfile() {
  const id = $("profileId").value;
  const p = profiles.find((x) => x.id === id);
  $("senders").innerHTML = "";
  $("profileInfo").textContent = p
    ? `Can text: ${p.destinations.includes("*") ? "every country" : p.destinations.length ? p.destinations.join(", ") : "no country yet"}.`
    : "";
  if (!id) return;
  try {
    const s = await api("GET", `/api/admin/sms/profiles/${encodeURIComponent(id)}/senders`);
    const options = [...(s.alphaSender ? [s.alphaSender] : []), ...s.numbers];
    $("senders").innerHTML = options.map((o) => `<option value="${esc(o)}">`).join("");
    if (p) $("profileInfo").textContent += ` Senders: ${s.alphaSender ? `“${s.alphaSender}” (alphanumeric), ` : ""}${s.numbers.length} number${s.numbers.length === 1 ? "" : "s"}.`;
  } catch (err) {
    $("profileInfo").textContent = err.message;
  }
}
$("profileId").addEventListener("change", showProfile);

// A template is picked by name and language (the same name can exist per language).
const templateKey = (t) => `${t.name}|${t.language}`;
function renderWhatsApp() {
  const s = saved || {};
  const numbers = whatsapp.numbers.some((n) => n.number === s.waFrom) || !s.waFrom ? whatsapp.numbers : [{ number: s.waFrom, name: "", status: "" }, ...whatsapp.numbers];
  $("waFrom").innerHTML = `<option value="">— choose a number —</option>` + numbers.map((n) =>
    `<option value="${esc(n.number)}"${n.number === s.waFrom ? " selected" : ""}>${esc(n.number)}${n.name ? ` · ${esc(n.name)}` : ""}${n.status && n.status !== "CONNECTED" ? ` (${esc(n.status.toLowerCase())})` : ""}</option>`).join("");
  const current = `${s.waTemplate}|${s.waLanguage}`;
  const templates = whatsapp.templates.some((t) => templateKey(t) === current) || !s.waTemplate
    ? whatsapp.templates : [{ name: s.waTemplate, language: s.waLanguage, category: "", body: "", params: s.waParams }, ...whatsapp.templates];
  $("waTemplate").innerHTML = `<option value="">— choose a template —</option>` + templates.map((t) =>
    `<option value="${esc(templateKey(t))}"${templateKey(t) === current ? " selected" : ""}>${esc(t.name)} · ${esc(t.language)}${t.category ? ` · ${esc(t.category.toLowerCase())}` : ""}</option>`).join("");
  showTemplate();
}

const FACTS = ["guest name", "room and booking code", "hotel", "dates and nights", "check-in time"];
function showTemplate() {
  const t = whatsapp.templates.find((x) => templateKey(x) === $("waTemplate").value);
  $("waPreview").textContent = t
    ? `${t.body}\n\nFilled in with: ${t.params ? FACTS.slice(0, t.params).map((f, i) => `{{${i + 1}}} ${f}`).join(", ") : "nothing (no parameters)"}.${t.params > FACTS.length ? ` This template has ${t.params} parameters, more than the booking can fill.` : ""}`
    : "";
}
$("waTemplate").addEventListener("change", showTemplate);

function showChannel() {
  const wa = $("channel").value === "whatsapp";
  $("smsFields").hidden = wa;
  $("waFields").hidden = !wa;
}
$("channel").addEventListener("change", showChannel);

function showSettings(s) {
  saved = s;
  $("enabled").checked = !!s.enabled;
  $("channel").value = s.channel || "sms";
  showChannel();
  renderWhatsApp();
  $("from").value = s.from || "";
  $("overrideTo").value = s.overrideTo || "";
  renderProfiles(s.profileId || "");
  const chip = $("stateChip");
  chip.hidden = false;
  chip.className = `chip ${s.enabled ? "ok" : ""}`;
  chip.textContent = s.enabled ? (s.channel === "whatsapp" ? `On · WhatsApp from ${s.waFrom}` : `On · SMS from ${s.from}`) : "Off";
}

function showMessages(messages) {
  $("messages").innerHTML = messages.length ? messages.map((m) => {
    const to = m.redirected ? `${esc(m.to)} <span class="muted hint">(guest gave ${esc(m.guestNumber)})</span>` : esc(m.to || m.guestNumber || "—");
    const details = [m.code && `booking ${m.code}`, m.lang && m.lang.toUpperCase(), m.carrier, m.parts && `${m.parts} part${m.parts > 1 ? "s" : ""}`, m.cost, m.error]
      .filter(Boolean).map(esc).join(" · ");
    return `<tr>
      <td class="muted" style="white-space:nowrap">${esc(new Date(m.createdAt).toLocaleString())}</td>
      <td>${m.channel === "whatsapp" ? "WhatsApp" : "SMS"}${m.template ? `<div class="muted hint">${esc(m.template)}</div>` : ""}</td>
      <td class="mono">${to}</td>
      <td>${esc(m.kind)}${m.user ? `<div class="muted hint">${esc(m.user)}</div>` : ""}</td>
      <td>${esc(m.lineType || "—")}</td>
      <td>${statusChip(m.status)}</td>
      <td class="muted hint">${details || "—"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty">Nothing sent yet.</td></tr>`;
}

async function loadProfiles() {
  const [p, w] = await Promise.allSettled([api("GET", "/api/admin/sms/profiles"), api("GET", "/api/admin/sms/whatsapp")]);
  if (p.status === "fulfilled") profiles = p.value.profiles;
  else $("loadError").textContent = `Messaging profiles: ${p.reason.message}`;
  if (w.status === "fulfilled") whatsapp = w.value;
  else $("loadError").textContent += ` WhatsApp: ${w.reason.message}`;
  renderProfiles(saved?.profileId || "");
  renderWhatsApp();
}

async function load() {
  $("loadError").textContent = "";
  try {
    const data = await api("GET", "/api/admin/sms");
    showSettings(data.settings);
    showMessages(data.messages);
  } catch (err) {
    $("loadError").textContent = err.message;
  }
}

$("setupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("saveError").textContent = $("saveOk").textContent = "";
  $("saveBtn").disabled = true;
  try {
    const [waTemplate = "", waLanguage = "en_US"] = $("waTemplate").value.split("|");
    const template = whatsapp.templates.find((t) => t.name === waTemplate && t.language === waLanguage);
    const { settings } = await api("PUT", "/api/admin/sms", {
      enabled: $("enabled").checked, channel: $("channel").value,
      profileId: $("profileId").value, from: $("from").value.trim(), overrideTo: $("overrideTo").value.trim(),
      waFrom: $("waFrom").value, waTemplate, waLanguage, waParams: template ? template.params : saved?.waParams ?? 0,
    });
    if (settings) showSettings(settings);
    $("saveOk").textContent = "Saved.";
  } catch (err) {
    $("saveError").textContent = err.message;
  } finally {
    $("saveBtn").disabled = false;
  }
});

$("testForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("testError").textContent = $("testOk").textContent = "";
  $("testBtn").disabled = true;
  try {
    const r = await api("POST", "/api/admin/sms/test", { to: $("testTo").value.trim() });
    $("testOk").textContent = `${r.channel === "whatsapp" ? "WhatsApp" : "SMS"} handed to Telnyx (${r.status})${r.to ? `, to ${r.to}${r.lineType ? `, ${r.lineType}` : ""}` : ""}. The delivery report follows in the log.`;
    [3000, 12_000].forEach((ms) => setTimeout(load, ms));
  } catch (err) {
    $("testError").textContent = err.message;
    load(); // the failed attempt is in the log too
  } finally {
    $("testBtn").disabled = false;
  }
});

$("reloadBtn").addEventListener("click", load);

load().then(loadProfiles);
