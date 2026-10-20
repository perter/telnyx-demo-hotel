// Accounts, sessions and page access (IAM).
//
// Users live in the users table (db.js): { id, name, email, pages[], avatar,
// passwordHash, sessionVersion, createdAt }, cached in memory and re-read every
// few seconds so changes made on another instance show up. Passwords are hashed
// with scrypt. Sessions are stateless signed cookies (HMAC-SHA256) carrying the
// user id and sessionVersion, so a password change or a deletion logs them out.
// `avatar` turns the video avatar (beta, billed per minute) on for that user.
//
// Booking, flow and history are granted page by page; the back office (users,
// guest stats, AI Assistant, e-mail, SMS) is admin-only.
//
// Guests (no account, from the login page) get a session of their own with
// booking and flow only: English only, nothing sent by e-mail,
// SMS or WhatsApp (server.js), and their calls are recorded for the admins.
import crypto from "node:crypto";
import path from "node:path";
import { onEdge } from "./settings.js";

const PAGES = {
  booking: { label: "Booking", href: "/" },
  flow: { label: "How it works", href: "/flow.html" },
  history: { label: "Call history", href: "/history.html" },
  admin: { label: "Users & access", href: "/admin.html", admin: true },
  guests: { label: "Guest stats", href: "/guests.html", admin: true },
  assistant: { label: "AI Assistant", href: "/assistant.html", admin: true },
  email: { label: "E-mail", href: "/email.html", admin: true },
  sms: { label: "SMS / WhatsApp", href: "/sms.html", admin: true },
};

// HTML pages → permission. Everything else needs a login too, except PUBLIC_PATHS.
const PAGE_PATHS = Object.fromEntries(Object.entries(PAGES).map(([key, p]) => [p.href, key]));
PAGE_PATHS["/index.html"] = "booking";

// What an admin can tick for a user: the guest-facing pages, or admin.
export const GRANTS = [
  ...Object.entries(PAGES).filter(([, p]) => !p.admin).map(([key, p]) => ({ key, label: p.label, href: p.href })),
  { key: "admin", label: "Admin (users, guest stats, AI Assistant, e-mail, SMS)", href: PAGES.admin.href },
];
const GRANT_KEYS = new Set(GRANTS.map((g) => g.key));
// The login page and what it shows (also used by the "No access" page), and the version.
const PUBLIC_PATHS = new Set(["/login.html", "/brand.css", "/console.css", "/ui.js", "/assets/telnyx.svg", "/assets/hero.jpg", "/api/auth/login", "/api/auth/logout", "/api/auth/guest", "/api/version"]);

const COOKIE = "telnyxhotel_session";
const SESSION_TTL = 7 * 24 * 3600_000;
const GUEST_TTL = 2 * 3600_000;
const GUEST_PAGES = ["booking", "flow"];
const GUEST_ID_RE = /^g_[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,253}$/;

const USERS_TTL = 5000;
let db, secret, guestsEnabled = true;
let users = [];
let loadedAt = 0;
let loading = null;

// admin: { email, password, name } for the first account, used only while
// there are no users at all.
export async function initAuth(database, { sessionSecret, admin, guests = true }) {
  db = database;
  secret = sessionSecret;
  guestsEnabled = guests;
  await refreshUsers(true);
  if (!users.length) await bootstrapAdmin(admin);
}

export function refreshUsers(force = false) {
  if (!force && Date.now() - loadedAt < USERS_TTL) return Promise.resolve();
  loading ??= db.prepare("SELECT data FROM users").all()
    .then(({ results }) => {
      users = results.map((r) => JSON.parse(r.data));
      loadedAt = Date.now();
    })
    .catch((err) => console.error("Could not load users:", err.message)) // keep the last known list
    .finally(() => { loading = null; });
  return loading;
}

async function bootstrapAdmin({ email, password, name } = {}) {
  email = (email || "admin@example.com").toLowerCase();
  const generated = !password;
  password ||= crypto.randomBytes(9).toString("base64url");
  const user = newUser({ name: name || "Admin", email, password, pages: ["admin"] });
  // INSERT OR IGNORE: another instance may be creating it at the same moment.
  await db.prepare("INSERT OR IGNORE INTO users (id, email, data, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, user.email, JSON.stringify(user), user.createdAt).run();
  await refreshUsers(true);
  if (!users.some((u) => u.id === user.id)) return;
  console.log(`Created the first admin account: ${email}`);
  if (generated) console.log(`  password: ${password}   (set ADMIN_PASSWORD to choose it; change it from the admin page)`);
}

async function save(user) {
  await db.prepare("INSERT OR REPLACE INTO users (id, email, data, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, user.email, JSON.stringify(user), user.createdAt).run();
  loadedAt = 0; // re-read on next request
}

// ---------------------------------------------------------------------------
// Passwords & users
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex")); // equalizes timing for unknown e-mails

function newUser({ name, email, password, pages, avatar = false }) {
  return {
    id: `u_${crypto.randomBytes(6).toString("hex")}`,
    name, email, pages, avatar,
    passwordHash: hashPassword(password),
    sessionVersion: 1,
    createdAt: new Date().toISOString(),
  };
}

export const isAdmin = (user) => !!user?.pages.includes("admin");

export const publicUser = (u) => u && ({
  id: u.id, name: u.name, email: u.email, pages: u.pages, isAdmin: isAdmin(u), avatar: !!u.avatar, guest: !!u.guest, createdAt: u.createdAt,
});

// A guest is not stored anywhere: the signed cookie carries its id.
const guestUser = (id) => ({ id, name: "Guest", email: "guest", pages: GUEST_PAGES, avatar: true, guest: true });
export const isGuest = (user) => !!user?.guest;

export function canAccess(user, page) {
  if (!user || !PAGES[page]) return false;
  return isAdmin(user) || (!PAGES[page].admin && user.pages.includes(page));
}

// The pages a user may open, for the menus.
export const allowedPages = (user) => Object.entries(PAGES).filter(([key]) => canAccess(user, key))
  .map(([key, p]) => ({ key, label: p.label, href: p.href, admin: !!p.admin }));

function validate({ name, email, password, pages, avatar }, { partial = false } = {}) {
  const out = {};
  if (name !== undefined || !partial) {
    out.name = String(name ?? "").trim().slice(0, 80);
    if (!out.name) throw badRequest("Name is required");
  }
  if (email !== undefined || !partial) {
    out.email = String(email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(out.email)) throw badRequest("A valid e-mail is required");
  }
  if (password !== undefined && password !== "" || !partial) {
    if (typeof password !== "string" || password.length < 8) throw badRequest("Password must be at least 8 characters");
    if (password.length > 200) throw badRequest("Password is too long");
    out.password = password;
  }
  if (pages !== undefined || !partial) {
    if (!Array.isArray(pages)) throw badRequest("pages must be a list");
    out.pages = [...new Set(pages.filter((p) => GRANT_KEYS.has(p)))];
  }
  if (avatar !== undefined) {
    if (typeof avatar !== "boolean") throw badRequest("avatar must be true or false");
    out.avatar = avatar;
  }
  return out;
}

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export const listUsers = () => users.map(publicUser);
const findUser = (id) => users.find((u) => u.id === id);

export async function createUser(body) {
  await refreshUsers(true);
  const v = validate(body);
  if (users.some((u) => u.email === v.email)) throw badRequest("A user with this e-mail already exists", 409);
  const user = newUser(v);
  await save(user);
  users.push(user);
  return publicUser(user);
}

const adminCount = () => users.filter(isAdmin).length;

export async function updateUser(id, body, actor) {
  await refreshUsers(true);
  const found = findUser(id);
  const user = found && structuredClone(found); // only replace the cached copy once saved
  if (!user) throw badRequest("User not found", 404);
  const v = validate(body, { partial: true });
  if (v.email && users.some((u) => u.email === v.email && u.id !== id)) throw badRequest("A user with this e-mail already exists", 409);
  if (v.pages && isAdmin(user) && !v.pages.includes("admin")) {
    if (id === actor.id) throw badRequest("You can't remove your own admin access");
    if (adminCount() <= 1) throw badRequest("At least one admin is required");
  }
  if (v.name) user.name = v.name;
  if (v.email) user.email = v.email;
  if (v.pages) user.pages = v.pages;
  if (v.avatar !== undefined) user.avatar = v.avatar;
  if (v.password) {
    user.passwordHash = hashPassword(v.password);
    user.sessionVersion++; // log out everywhere
  }
  await save(user);
  users = users.map((u) => (u.id === id ? user : u));
  return publicUser(user);
}

export async function deleteUser(id, actor) {
  await refreshUsers(true);
  const user = findUser(id);
  if (!user) throw badRequest("User not found", 404);
  if (id === actor.id) throw badRequest("You can't delete your own account");
  if (isAdmin(user) && adminCount() <= 1) throw badRequest("At least one admin is required");
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  users = users.filter((u) => u.id !== id);
}

export async function changeOwnPassword(user, current, next) {
  if (isGuest(user)) throw badRequest("Guests have no password", 403);
  if (typeof current !== "string" || !verifyPassword(current, user.passwordHash)) throw badRequest("Current password is wrong", 403);
  validate({ password: next }, { partial: true });
  if (typeof next !== "string" || !next) throw badRequest("New password is required");
  const updated = { ...user, passwordHash: hashPassword(next), sessionVersion: user.sessionVersion + 1 };
  await save(updated);
  users = users.map((u) => (u.id === user.id ? updated : u));
}

// ---------------------------------------------------------------------------
// Sessions (signed cookie)
// ---------------------------------------------------------------------------
const sign = (payload) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, sv: user.sessionVersion, exp: Date.now() + SESSION_TTL })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function issueGuestToken(id) {
  const payload = Buffer.from(JSON.stringify({ gid: id, exp: Date.now() + GUEST_TTL })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function userFromToken(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
  if (!data.exp || data.exp < Date.now()) return null;
  if (data.gid) return guestsEnabled && GUEST_ID_RE.test(data.gid) ? guestUser(data.gid) : null;
  const user = findUser(data.uid);
  return user && user.sessionVersion === data.sv ? user : null;
}

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } // malformed % escapes
    }
  }
  return null;
}

export const userFromRequest = (req) => userFromToken(readCookie(req.headers.cookie, COOKIE));

// Telnyx Edge is served over https only, but its proxy doesn't say so in x-forwarded-proto.
const isHttps = (req) => onEdge() || req.secure || req.headers["x-forwarded-proto"] === "https";

export function setCookie(req, res, name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (isHttps(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

// Login attempts: 10 per 15 minutes per IP.
const loginHits = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const hits = (loginHits.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  loginHits.set(ip, hits);
  return hits.length < 10;
}

// Guest sessions: 10 per hour per IP.
const guestHits = new Map();
function guestAllowed(ip) {
  const now = Date.now();
  const hits = (guestHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= 10) return false;
  guestHits.set(ip, [...hits, now]);
  return true;
}

// GET: whether the login page offers guest access. POST: start a guest session.
export function guestStatus(_req, res) {
  res.json({ enabled: guestsEnabled });
}

export function guestLogin(req, res) {
  if (!guestsEnabled) return res.status(404).json({ error: "Guest access is turned off" });
  if (!guestAllowed(req.ip)) return res.status(429).json({ error: "Too many guest sessions, try again later" });
  const user = guestUser(`g_${crypto.randomBytes(6).toString("hex")}`);
  setCookie(req, res, COOKIE, issueGuestToken(user.id), GUEST_TTL);
  res.json({ user: publicUser(user), pages: allowedPages(user) });
}

export async function login(req, res) {
  await refreshUsers();
  const ip = req.ip;
  if (!loginAllowed(ip)) return res.status(429).json({ error: "Too many attempts, try again in a few minutes" });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = users.find((u) => u.email === email);
  const ok = verifyPassword(password, user ? user.passwordHash : DUMMY_HASH) && !!user;
  if (!ok) {
    loginHits.get(ip).push(Date.now());
    return res.status(401).json({ error: "Wrong e-mail or password" });
  }
  setCookie(req, res, COOKIE, issueToken(user), SESSION_TTL);
  res.json({ user: publicUser(user), pages: allowedPages(user) });
}

export function logout(req, res) {
  setCookie(req, res, COOKIE, "", 0);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------
export async function attachUser(req, _res, next) {
  try {
    await refreshUsers();
    req.user = userFromRequest(req);
    next();
  } catch (err) { next(err); }
}

// The file express.static would serve: decoded, dot segments resolved, and
// lower-cased because macOS file systems ignore case. null if undecodable.
function resolvedPath(urlPath) {
  try { return path.posix.normalize(decodeURIComponent(urlPath)).toLowerCase(); } catch { return null; }
}

// Deny by default: only PUBLIC_PATHS are open. Logged-out visitors are sent to
// the login page (HTML) or get a 401; pages need their permission (403 page).
// APIs pass through here logged-in and check their own permission (requirePage).
export function pageGate(req, res, next) {
  const p = resolvedPath(req.path);
  if (p === null) return res.status(400).type("text").send("Bad request");
  if (PUBLIC_PATHS.has(p)) return next();
  const page = PAGE_PATHS[p];
  if (!req.user) {
    const wantsPage = (req.method === "GET" || req.method === "HEAD") && (page || p.endsWith(".html"));
    if (wantsPage) return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
    return res.status(401).json({ error: "Not logged in" });
  }
  if (page && !canAccess(req.user, page)) return res.status(403).type("html").send(forbiddenPage(req.user, page));
  next();
}

// Gate an API route: 401 when logged out, 403 without any of the given pages.
export function requirePage(...pages) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not logged in" });
    if (pages.length && !pages.some((p) => canAccess(req.user, p))) return res.status(403).json({ error: "Not allowed" });
    next();
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function forbiddenPage(user, page) {
  const links = allowedPages(user).map((p) => `<li><a href="${p.href}">${esc(p.label)}</a></li>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>No access — TelnyxHotel</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/console.css"></head>
<body class="auth-page"><main class="auth-card">
<div class="brand"><span class="telnyx-logo" role="img" aria-label="Telnyx"></span><span class="tagline">TelnyxHotel</span></div>
<h1>No access</h1>
<p class="muted">${esc(user.email)} can't open <strong>${esc(PAGES[page].label)}</strong>. Ask an admin to grant it.</p>
${links ? `<p>Pages you can open:</p><ul class="page-links">${links}</ul>` : `<p class="muted">No pages have been assigned to your account yet.</p>`}
<button class="btn" id="logout">Log out</button>
</main><script src="/ui.js"></script><script>document.getElementById("logout").onclick=()=>fetch("/api/auth/logout",{method:"POST"}).then(()=>location.href="/login.html")</script></body></html>`;
}
