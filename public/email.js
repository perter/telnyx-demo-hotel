// Admin: Telnyx Email setup for the booking recap, the sending domains and
// what was sent.
const $ = (id) => document.getElementById(id);
const { esc, api } = Account;
const FIELDS = ["from", "fromName", "replyTo", "overrideTo"];
const BOXES = ["enabled", "sandbox"];

Account.topbar($("topbar"));


const statusChip = (status) => {
  const kind = /verified|delivered|completed|sent/.test(status) ? "ok" : /fail|bounce|reject|suspend/.test(status) ? "err" : "warn";
  return `<span class="chip ${kind}">${esc(status || "—")}</span>`;
};

function showSettings(s) {
  for (const id of FIELDS) $(id).value = s[id] || "";
  for (const id of BOXES) $(id).checked = !!s[id];
  const chip = $("stateChip");
  chip.hidden = false;
  chip.className = `chip ${s.enabled ? (s.sandbox ? "warn" : "ok") : ""}`;
  chip.textContent = s.enabled ? (s.sandbox ? "On · sandbox" : "On") : "Off";
}

function showDomains(domains) {
  $("senders").innerHTML = domains.filter((d) => d.sender && d.status === "verified").map((d) => `<option value="${esc(d.sender)}">`).join("");
  $("domains").innerHTML = domains.length ? domains.map((d) => `<tr>
      <td><strong>${esc(d.domain)}</strong></td>
      <td>${esc(d.type)}</td>
      <td>${statusChip(d.status)}</td>
      <td class="mono">${d.sender ? esc(d.sender) : `<span class="muted">any address @${esc(d.domain)}</span>`}</td>
    </tr>`).join("") : `<tr><td colspan="4" class="empty">No sending domain on this Telnyx account yet.</td></tr>`;
}

function showMessages(messages) {
  $("messages").innerHTML = messages.length ? messages.map((m) => `<tr>
      <td class="muted" style="white-space:nowrap">${esc(new Date(m.createdAt).toLocaleString())}</td>
      <td>${esc(m.to.join(", "))}</td>
      <td>${esc(m.subject)}</td>
      <td>${esc(m.tags.join(", ") || "—")}${m.sandbox ? ' <span class="chip warn">sandbox</span>' : ""}</td>
      <td>${statusChip(m.delivery || m.status)}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="empty">Nothing sent yet.</td></tr>`;
}

async function load() {
  $("loadError").textContent = "";
  try {
    const data = await api("GET", "/api/admin/email");
    showSettings(data.settings);
    showDomains(data.domains);
    showMessages(data.messages);
    $("fallbackNote").textContent = `While this is off, recaps use: ${data.fallback}.`;
    if (data.telnyxError) $("loadError").textContent = `Telnyx Email: ${data.telnyxError}`;
  } catch (err) {
    $("loadError").textContent = err.message;
  }
}

$("setupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("saveError").textContent = $("saveOk").textContent = "";
  $("saveBtn").disabled = true;
  try {
    const body = Object.fromEntries([...FIELDS.map((id) => [id, $(id).value.trim()]), ...BOXES.map((id) => [id, $(id).checked])]);
    const { settings } = await api("PUT", "/api/admin/email", body);
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
    const r = await api("POST", "/api/admin/email/test", { to: $("testTo").value.trim() });
    $("testOk").textContent = r.sandbox ? "Accepted by Telnyx in sandbox mode: nothing was delivered."
      : `Handed to Telnyx (${r.status})${r.to ? `, addressed to ${r.to}` : ""}.`;
    setTimeout(load, 2500); // show it in the list once Telnyx has it
  } catch (err) {
    $("testError").textContent = err.message;
  } finally {
    $("testBtn").disabled = false;
  }
});

$("reloadBtn").addEventListener("click", load);

load();
