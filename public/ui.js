// Shared page chrome, loaded on every page: the help column (right side,
// collapsed until opened) and the footer with the frontend, backend and
// branch versions. Back-office help is English; the booking and flow pages
// take theirs from the i18n files (help.* keys), so it follows the page language.
(function () {
  const FRONTEND_VERSION = "1.4.0";
  const PAGE = { "/": "booking", "/index.html": "booking", "/flow.html": "flow", "/history.html": "history", "/admin.html": "admin", "/guests.html": "guests",
    "/assistant.html": "assistant", "/email.html": "email", "/sms.html": "sms", "/login.html": "login" }[location.pathname] || "noaccess";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let i18n = false; // set at start: i18n.js may load after this file

  // What each page is for, for the navigation list (English; i18n: help.nav.<key>).
  const NAV = {
    booking: "Book a room by talking to the AI receptionist.",
    flow: "See what happens during a call, step by step.",
    history: "Your calls and guest messages, traced end to end.",
    admin: "Create users and choose what they can open.",
    guests: "Guest calls: when, from where, how many booked and why.",
    assistant: "Languages, voices, prompt, knowledge base, avatar.",
    email: "Booking recap e-mails with Telnyx Email.",
    sms: "Booking confirmations by SMS or WhatsApp.",
  };
  // Suggested order for a new installation.
  const SETUP = [
    ["assistant", "AI Assistant: pick the languages and the voices guests can choose, and check the prompt."],
    ["email", "E-mail: choose a sender on a Telnyx sending domain, try it with a test."],
    ["sms", "SMS / WhatsApp: pick a messaging profile and sender, send a test to your mobile."],
    ["admin", "Users & access: invite the people who will try the demo."],
    ["booking", "Booking: make a test call, then open it in Call history."],
  ];

  // [heading, text] pairs per back-office page.
  const HELP = {
    login: [
      ["Getting an account", "Accounts are created by an admin in Users & access. The first admin is created at the first start, from ADMIN_EMAIL and ADMIN_PASSWORD in .env (npm run setup fills them in)."],
      ["Forgot your password?", "Ask an admin to set a new one. Changing a password signs that user out everywhere."],
      ["Privacy", "Every page needs a login. Each user only sees their own calls and messages; admins see everyone's."],
    ],
    noaccess: [
      ["Why am I here?", "Your account can't open this page. Booking, How it works and Call history are granted per user; the back office is for admins only."],
      ["What next", "Use one of the pages listed, or ask an admin for access."],
    ],
    history: [
      ["What is listed", "Every call you made with the voice concierge (admins: everyone's, with a user filter), and below it the guest messages your bookings sent: recap e-mails and SMS / WhatsApp confirmations with their delivery status."],
      ["Reading a call", "Click a call: the setup trip shows where the time went before the first word, the conversation shows each reply's latency, and the timeline has every event exchanged with Telnyx. Tool calls show what the receptionist did."],
      ["Statuses", "A message is “awaiting delivery” until the carrier reports back; “not sent” explains why (not a mobile number, channel off…)."],
      ["Housekeeping", "Download a call as JSON, or delete it. A call in progress can't be deleted."],
    ],
    admin: [
      ["Users", "Create an account with a name, e-mail and an initial password. Tick the pages it may open: Booking, How it works, Call history. Admin gives everything, including this back office."],
      ["Changes apply at once", "Ticking a box saves it. A new password signs the user out everywhere. You can't remove your own admin access or delete yourself, and one admin must always remain."],
      ["Video avatar", "Turns the video receptionist on for that user's calls (beta, billed per minute). It also needs an avatar set up in AI Assistant."],
    ],
    guests: [
      ["What is counted", "Every finished call made with “Try it as a guest” (no account), for the period you pick. The figures on top cover the whole period; the tabs break them down. Days and hours are in your own time zone."],
      ["How far calls got", "Each call is placed at the furthest booking step it reached, from the receptionist's tool calls: hotel, dates, guests, availability, room, contact details, booking. Unbooked calls are counted by where they stopped."],
      ["Insights", "Summary, Sentiment and Missed Opportunities are the Telnyx conversation insights of the assistant's insight group, read back for each call a minute or so after it ends. The sentiment score (0–1) and the yes/no of a missed opportunity are read from their text."],
      ["Traffic", "Requests served by the app's Telnyx Edge function, by outcome, with latency and memory, from the Edge Compute metrics (kept 7 days). These are requests, not calls or guests. The split by Edge region is only in the Telnyx Portal."],
      ["Where", "Calls by country, worked out on the server from DB-IP country data. The map shades countries by their share of calls. Older calls have no country."],
      ["Contacts", "Guests who left an e-mail or phone number in the pop-up on the booking page, asking to be contacted by Telnyx about TelnyxHotel. Each comes with how far that guest's calls got. Send e-mail sends the follow-up e-mail (Edit follow-up e-mail: subject, heading, message, button and signature, with a live preview) through Telnyx Email and marks the contact as e-mailed. Download them as CSV, and delete a contact once handled or when the guest asks."],
    ],
    assistant: [
      ["Concierge languages & voices", "Enable the languages guests can choose and, per language, a shortlist of Telnyx Ultra voices with a default and a greeting. Guests can only start a call with a voice from these lists; each user's pick is remembered in a cookie."],
      ["The live assistant", "Each card edits the live Telnyx AI Assistant and saves on its own: prompt and model, listening (turn detection), knowledge base, video avatar. Every save creates a new assistant version on Telnyx."],
      ["Repo vs live", "npm run assistant:sync won't overwrite a prompt changed here; use -- --pull to bring it into the repo."],
    ],
    email: [
      ["Sender", "Pick an address on a sending domain of your Telnyx account. A shared domain only sends from onboarding@<domain> to the account owner: use the redirect address for demos."],
      ["Sandbox & redirect", "Sandbox mode makes Telnyx accept but not deliver. A redirect address receives every recap instead of the guest (spoken e-mail addresses are often misheard)."],
      ["Check it", "Send a test, then look at the sent list: it shows only what this demo sent, with the delivery status."],
    ],
    sms: [
      ["Channel", "SMS uses a number or alphanumeric sender of a messaging profile. WhatsApp needs a connected WhatsApp Business number and a template approved by Meta; its parameters are filled from the booking."],
      ["Mobile numbers only", "Before sending, Telnyx Number Lookup checks the guest's number: a landline or VoIP number gets nothing, and the receptionist asks for a mobile."],
      ["Delivery log", "Every attempt is logged, sent or not, and its status is read back from Telnyx until it is delivered or failed. Send a test to your own mobile to check the setup."],
    ],
  };

  const back = ["admin", "guests", "assistant", "email", "sms"].includes(PAGE);
  const T = (key, english) => (i18n ? `<span data-i18n="${key}">${esc(I18N.t(key))}</span>` : esc(english));

  function sectionsHtml() {
    if (!i18n) return (HELP[PAGE] || []).map(([h, p]) => `<details><summary>${esc(h)}</summary><p>${esc(p)}</p></details>`).join("");
    let out = "";
    for (let n = 1; I18N.t(`help.${PAGE}.${n}.h`) !== `help.${PAGE}.${n}.h`; n++) {
      out += `<details><summary>${T(`help.${PAGE}.${n}.h`)}</summary><p>${T(`help.${PAGE}.${n}.p`)}</p></details>`;
    }
    return out;
  }

  function navHtml(pages) {
    if (!pages?.length) return "";
    const item = (p) => `<li><a href="${p.href}"${p.href === location.pathname ? ' aria-current="page"' : ""}>${esc(p.label)}</a><small>${T(`help.nav.${p.key}`, NAV[p.key])}</small></li>`;
    const admin = pages.filter((p) => p.admin);
    let html = `<h3>${T("help.pages", "Pages")}</h3><ul class="help-nav">${pages.filter((p) => !p.admin).map(item).join("")}</ul>`;
    if (admin.length) html += `<h3>${T("help.backoffice", "Back office")}</h3><ul class="help-nav">${admin.map(item).join("")}</ul>`;
    if (back) {
      const href = Object.fromEntries(pages.map((p) => [p.key, p.href]));
      html += `<h3>First-time setup</h3><ol class="help-steps">${SETUP.map(([key, text]) => `<li${href[key] === location.pathname ? ' class="here"' : ""}><a href="${href[key]}">${esc(text.split(":")[0])}</a>:${esc(text.slice(text.indexOf(":") + 1))}</li>`).join("")}</ol>`;
    }
    return html;
  }

  function helpPanel() {
    const box = document.createElement("aside");
    box.className = PAGE === "booking" ? "help light" : "help"; // the hotel site is always light
    box.setAttribute("aria-label", "Help");
    box.innerHTML = `
      <button type="button" class="help-toggle" aria-expanded="false" aria-controls="helpBody">?<span>${T("help.toggle", "Help")}</span></button>
      <div class="help-body" id="helpBody" hidden>
        <div class="help-head"><h2>${T("help.title", "Help")}</h2><button type="button" class="help-close" aria-label="Close help">×</button></div>
        <div class="help-sections">${sectionsHtml()}</div>
        <nav class="help-pages" aria-label="Pages"></nav>
      </div>`;
    const toggle = box.querySelector(".help-toggle");
    const body = box.querySelector(".help-body");
    const set = (open) => {
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      document.body.classList.toggle("help-open", open);
    };
    toggle.onclick = () => set(body.hidden);
    box.querySelector(".help-close").onclick = () => set(false);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !body.hidden) set(false); });
    document.body.append(box);
    window.Account?.ready.then(({ pages }) => (box.querySelector(".help-pages").innerHTML = navHtml(pages)));
  }

  function footer() {
    const line = document.createElement("p");
    line.className = "app-version";
    line.textContent = `Frontend v${FRONTEND_VERSION}`;
    fetch("/api/version").then((r) => r.json()).then((v) => {
      line.textContent = `Frontend v${FRONTEND_VERSION} · Backend v${v.backend} · Branch ${v.branch}`;
    }, () => {});
    const site = document.querySelector(".site-footer");
    if (site) return site.append(line);
    const foot = document.createElement("footer");
    foot.className = "app-footer";
    foot.append(line);
    document.body.append(foot);
  }

  const start = () => {
    i18n = !!window.I18N && (PAGE === "booking" || PAGE === "flow");
    helpPanel();
    footer();
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", start); else start();
})();
