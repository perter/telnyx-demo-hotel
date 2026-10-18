// Admin: list users, create/edit/delete them, toggle page access (IAM) and
// the video avatar on their calls.
const $ = (id) => document.getElementById(id);
const { esc, api } = Account;
let me = null;
let pages = [];
let users = [];

Account.topbar($("topbar"));


function permBoxes(selected, { name, disabledKeys = [] } = {}) {
  return pages.map((p) => {
    const disabled = disabledKeys.includes(p.key);
    return `<label class="perm${disabled ? " disabled" : ""}" title="${esc(p.href)}">
      <input type="checkbox" name="${name}" value="${p.key}"${selected.includes(p.key) ? " checked" : ""}${disabled ? " disabled" : ""}>
      ${esc(p.label)}</label>`;
  }).join("");
}

function flash(text) {
  $("saved").textContent = text;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => ($("saved").textContent = ""), 2500);
}

function render() {
  const tbody = $("users");
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">No users.</td></tr>`;
    return;
  }
  tbody.innerHTML = users.map((u) => {
    const self = u.id === me.id;
    return `<tr data-id="${u.id}">
      <td><strong>${esc(u.name)}</strong>${self ? ' <span class="chip">you</span>' : ""}<div class="muted">${esc(u.email)}</div></td>
      <td><div class="perm-list">${permBoxes(u.pages, { name: `p_${u.id}`, disabledKeys: self ? ["admin"] : [] })}</div>
        ${u.isAdmin ? '<div class="muted" style="font-size:12px;margin-top:4px">Admin: every page is allowed.</div>' : ""}</td>
      <td><label class="perm" title="Video avatar on this user's calls"><input type="checkbox" data-avatar${u.avatar ? " checked" : ""}> On</label></td>
      <td class="muted" style="white-space:nowrap">${new Date(u.createdAt).toLocaleDateString()}</td>
      <td><div class="row-actions">
        <button class="btn ghost small" data-edit>Edit</button>
        ${self ? "" : '<button class="btn danger small" data-delete>Delete</button>'}
      </div></td>
    </tr>`;
  }).join("");
}

async function load() {
  const [{ user }, data] = await Promise.all([Account.ready, api("GET", "/api/admin/users")]);
  me = user;
  pages = data.pages;
  users = data.users;
  $("createPerms").innerHTML = permBoxes(["booking", "history"], { name: "create" });
  render();
}

// Toggle a permission or the video avatar: saved immediately.
$("users").addEventListener("change", async (e) => {
  const box = e.target.closest("input[type=checkbox]");
  if (!box) return;
  const row = box.closest("tr");
  const id = row.dataset.id;
  const body = box.hasAttribute("data-avatar")
    ? { avatar: box.checked }
    : { pages: [...row.querySelectorAll("input[type=checkbox]:checked:not([data-avatar])")].map((b) => b.value) };
  try {
    const { user } = await api("PATCH", `/api/admin/users/${id}`, body);
    users = users.map((u) => (u.id === id ? user : u));
    flash(body.pages ? `Access updated for ${user.email}` : `Video avatar ${user.avatar ? "on" : "off"} for ${user.email}`);
  } catch (err) {
    box.checked = !box.checked;
    alert(err.message);
  }
  render();
});

$("users").addEventListener("click", async (e) => {
  const row = e.target.closest("tr");
  if (!row) return;
  const user = users.find((u) => u.id === row.dataset.id);
  if (e.target.closest("[data-delete]")) {
    if (!confirm(`Delete ${user.email}? Their call history stays on the server.`)) return;
    try {
      await api("DELETE", `/api/admin/users/${user.id}`);
      users = users.filter((u) => u.id !== user.id);
      render();
      flash(`Deleted ${user.email}`);
    } catch (err) { alert(err.message); }
  }
  if (e.target.closest("[data-edit]")) openEdit(user);
});

$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  $("createError").textContent = "";
  try {
    const { user } = await api("POST", "/api/admin/users", {
      name: f.name.value,
      email: f.email.value,
      password: f.password.value,
      pages: [...f.querySelectorAll("input[name=create]:checked")].map((b) => b.value),
      avatar: f.avatar.checked,
    });
    users.push(user);
    render();
    f.reset();
    $("createPerms").innerHTML = permBoxes(["booking", "history"], { name: "create" });
    flash(`Created ${user.email}`);
  } catch (err) {
    $("createError").textContent = err.message;
  }
});

// ---------- Edit dialog ----------
let editing = null;
function openEdit(user) {
  editing = user;
  const f = $("editForm");
  f.name.value = user.name;
  f.email.value = user.email;
  f.password.value = "";
  $("editError").textContent = "";
  $("editDialog").showModal();
}
$("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, email: f.email.value };
  if (f.password.value) body.password = f.password.value;
  try {
    const { user } = await api("PATCH", `/api/admin/users/${editing.id}`, body);
    users = users.map((u) => (u.id === user.id ? user : u));
    render();
    $("editDialog").close();
    flash(`Saved ${user.email}`);
    if (user.id === me.id && body.password) location.href = "/login.html";
  } catch (err) {
    $("editError").textContent = err.message;
  }
});

// ---------- My password ----------
$("myPasswordBtn").onclick = () => {
  $("pwForm").reset();
  $("pwError").textContent = "";
  $("pwDialog").showModal();
};
$("pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("POST", "/api/auth/password", { current: f.current.value, next: f.next.value });
    location.href = "/login.html"; // sessions were invalidated
  } catch (err) {
    $("pwError").textContent = err.message;
  }
});

document.querySelectorAll("dialog [data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

load().catch((err) => {
  $("users").innerHTML = `<tr><td colspan="5" class="empty">${esc(err.message)}</td></tr>`;
});
