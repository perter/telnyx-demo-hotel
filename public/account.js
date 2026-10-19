// Logged-in account: loads /api/auth/me and exposes window.Account.
// Every page but the booking page shows the top bar (Account.topbar); the
// booking page, a mock hotel website, gets a small account menu bottom-left.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const initials = (name) => String(name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  const ready = fetch("/api/auth/me", { credentials: "same-origin" }).then((res) => {
    if (res.status === 401) {
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      return new Promise(() => {}); // never resolves: we're leaving
    }
    return res.json();
  });

  // A guest's way out is the login page, to sign in with an account.
  const exitLabel = (user) => (user.guest ? "Sign in" : "Log out");

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login.html";
  }

  // JSON API call: throws the server's error message; a lost session goes to the login page.
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  const link = (p) => `<a href="${p.href}"${p.href === location.pathname ? ' aria-current="page"' : ""}>${esc(p.label)}</a>`;

  function topbar(el) {
    ready.then(({ user, pages }) => {
      const admin = pages.filter((p) => p.admin);
      el.className = "topbar";
      el.innerHTML = `
        <a class="brand" href="/"><span class="telnyx-logo" role="img" aria-label="Telnyx"></span><span class="tagline">TelnyxHotel</span></a>
        <nav aria-label="Pages">${pages.filter((p) => !p.admin).map(link).join("")}
          ${admin.length ? `<span class="nav-group" aria-label="Admin">${admin.map(link).join("")}</span>` : ""}</nav>
        <span class="who" title="${esc(user.guest ? "Guest demo" : user.email)}"><span class="av">${esc(initials(user.name))}</span>${esc(user.name)}</span>
        <button type="button" class="btn ghost small" data-logout>${exitLabel(user)}</button>`;
      el.querySelector("[data-logout]").onclick = logout;
    });
  }

  function floatingMenu({ user, pages }) {
    const box = document.createElement("div");
    box.className = "acct";
    box.innerHTML = `
      <button type="button" aria-haspopup="true" aria-expanded="false"><span class="av">${esc(initials(user.name))}</span>${esc(user.name.split(" ")[0])}</button>
      <div class="menu" hidden role="menu">
        <div class="head">${esc(user.name)}<small>${esc(user.guest ? "Guest demo" : user.email)}</small></div>
        ${pages.map(link).join("").replaceAll("<a ", '<a role="menuitem" ')}
        <button type="button" role="menuitem" data-logout>${exitLabel(user)}</button>
      </div>`;
    const toggle = box.querySelector("button");
    const menu = box.querySelector(".menu");
    toggle.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      toggle.setAttribute("aria-expanded", String(!menu.hidden));
    };
    document.addEventListener("click", (e) => { if (!box.contains(e.target)) menu.hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; });
    box.querySelector("[data-logout]").onclick = logout;
    document.body.append(box);
  }

  if (document.currentScript?.hasAttribute("data-menu")) {
    ready.then((me) => (document.body ? floatingMenu(me) : addEventListener("DOMContentLoaded", () => floatingMenu(me))));
  }

  window.Account = { ready, topbar, esc, api };
})();
