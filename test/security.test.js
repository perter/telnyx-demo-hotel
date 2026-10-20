// Regression + security tests: boots the real server on a throwaway database
// and checks that pages, data and sockets are only reachable by logged-in users
// with the right permission, and that users only see their own data. Run: npm test
//
// Runs without credentials: the tests that need the Telnyx voice list or the live
// assistant (TELNYX_API_KEY / TELNYX_ASSISTANT_ID in .env) are skipped; they only read.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const ADMIN = { email: "admin@test.local", password: "admin-pass-123" };

let server, dataDir, log = "";

before(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "telnyxhotel-test-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: dataDir,
      ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ADMIN_NAME: "Test Admin",
      SESSION_SECRET: "test-secret", TELNYX_API_KEY: process.env.TELNYX_API_KEY || readEnvKey() || "KEY_test",
      // A placeholder is enough: the tests never get as far as the assistant.
      TELNYX_ASSISTANT_ID: process.env.TELNYX_ASSISTANT_ID || "assistant-test",
      SMTP_HOST: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/login.html`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${log}`);
});

after(() => {
  server?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

function readEnvKey() {
  try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* none */ }
  return process.env.TELNYX_API_KEY;
}

const alive = () => fetch(`${BASE}/health`).then((r) => r.ok, () => false);

// Raw request: the path is sent exactly as given (no URL normalization).
function raw(pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "localhost", port: PORT, path: pathname, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error(`timeout on ${pathname}`)));
    if (body) req.write(body);
    req.end();
  });
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers.get("set-cookie");
  return { res, cookie: cookie?.split(";")[0], setCookie: cookie, body: await res.json() };
}

const api = (cookie, method, url, body) => fetch(`${BASE}${url}`, {
  method, redirect: "manual",
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

// Opens a WebSocket and resolves with the handshake status (101 = upgraded).
function wsStatus(pathname, { cookie, origin } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(`ws://localhost:${PORT}${pathname}`, { headers, origin });
    ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on("open", () => { resolve(101); ws.terminate(); });
    ws.on("error", () => resolve("error"));
  });
}

const PAGES = ["/", "/index.html", "/flow.html", "/history.html", "/admin.html", "/guests.html", "/assistant.html", "/email.html", "/sms.html"];
const ADMIN_PAGES = ["/admin.html", "/guests.html", "/assistant.html", "/email.html", "/sms.html"];
const ADMIN_APIS = [
  ["GET", "/api/admin/users"], ["POST", "/api/admin/users"], ["PATCH", "/api/admin/users/u_x"], ["DELETE", "/api/admin/users/u_x"],
  ["GET", "/api/admin/guests"], ["GET", "/api/admin/traffic"], ["GET", "/api/admin/concierge"], ["PUT", "/api/admin/concierge"],
  ["GET", "/api/admin/assistant"], ["PATCH", "/api/admin/assistant/prompt"], ["PATCH", "/api/admin/assistant/knowledge"], ["PATCH", "/api/admin/assistant/avatar"],
  ["GET", "/api/admin/email"], ["PUT", "/api/admin/email"], ["POST", "/api/admin/email/test"],
  ["GET", "/api/admin/sms"], ["PUT", "/api/admin/sms"], ["POST", "/api/admin/sms/test"],
  ["GET", "/api/admin/sms/profiles"], ["GET", "/api/admin/sms/profiles/x/senders"], ["GET", "/api/admin/sms/whatsapp"],
];
const APIS = [
  ["GET", "/api/auth/me"], ["POST", "/api/auth/password"],
  ["GET", "/api/calls"], ["GET", "/api/calls/c_x"], ["DELETE", "/api/calls/c_x"], ["GET", "/api/messages"],
  ["GET", "/api/concierge"], ["GET", "/api/prefs"], ["PUT", "/api/prefs"], ["POST", "/api/tts"],
  ["POST", "/api/booking-recap"], ["GET", "/recap/x"], ["POST", "/api/booking-sms"],
  ...ADMIN_APIS,
];
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
// A bookable stay (availability is made up per date: pick a free room).
async function freeStay() {
  await import("../public/booking.js");
  const stay = { hotel: "rome_centro", check_in: day(30), check_out: day(32), adults: 2 };
  return { ...stay, room_type: globalThis.Booking.checkAvailability(stay).rooms.find((x) => x.available).room_type, guest_name: "Ada Test" };
}
const SOCKETS = ["/ws/assistant"];

// ---------------------------------------------------------------------------
describe("logged out", () => {
  test("every page redirects to the login page", async () => {
    for (const p of PAGES) {
      const res = await api(null, "GET", p);
      assert.equal(res.status, 302, p);
      assert.match(res.headers.get("location"), /^\/login\.html\?next=/, p);
    }
  });

  test("the login page and what it shows are public, nothing else", async () => {
    for (const p of ["/login.html", "/console.css", "/brand.css", "/ui.js", "/assets/telnyx.svg", "/assets/hero.jpg", "/api/version"]) {
      assert.equal((await fetch(`${BASE}${p}`)).status, 200, p);
    }
    for (const p of ["/assets/logo.svg", "/assets/band.jpg", "/assets/CREDITS.md", "/account.js"]) {
      assert.ok([302, 401].includes((await api(null, "GET", p)).status), p);
    }
  });

  test("page scripts, styles and images need a login", async () => {
    for (const p of ["/history.js", "/admin.js", "/reception.js", "/flow.js", "/i18n.js", "/reception.css", "/assets/logo.svg"]) {
      const res = await api(null, "GET", p);
      assert.ok([302, 401].includes(res.status), `${p} → ${res.status}`);
    }
  });

  test("encoded, doubled or re-cased page paths don't slip past the gate", async () => {
    for (const p of ["/%66low.html", "/%61dmin.html", "/FLOW.HTML", "/Admin.html", "//flow.html", "/./admin.html",
      "/assets/../admin.html", "/history.html%3F", "/%2fadmin.html"]) {
      const res = await raw(p);
      assert.ok(res.status !== 200, `${p} → ${res.status}`);
    }
  });

  test("every API answers 401", async () => {
    for (const [m, url] of APIS) {
      const res = await api(null, m, url, m === "GET" || m === "DELETE" ? undefined : {});
      assert.equal(res.status, 401, `${m} ${url}`);
    }
  });

  test("every WebSocket is refused", async () => {
    for (const s of SOCKETS) assert.equal(await wsStatus(s), 401, s);
  });

  test("the version is public: backend from package.json, and a branch", async () => {
    const { readFileSync } = await import("node:fs");
    const v = await (await fetch(`${BASE}/api/version`)).json();
    assert.equal(v.backend, JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
    assert.ok(v.branch && typeof v.branch === "string");
    assert.deepEqual(Object.keys(v).sort(), ["backend", "branch"], "nothing else");
  });

  test("forged, expired or malformed session cookies are rejected without crashing", async () => {
    const forged = Buffer.from(JSON.stringify({ uid: "u_x", sv: 1, exp: Date.now() + 1e9 })).toString("base64url");
    for (const c of [`telnyxhotel_session=${forged}.AAAA`, "telnyxhotel_session=%E0%A4%A", "telnyxhotel_session=..", "telnyxhotel_session="]) {
      const res = await raw("/api/auth/me", { headers: { Cookie: c } });
      assert.equal(res.status, 401, c);
      assert.equal(await wsStatus("/ws/assistant", { cookie: c }), 401, `ws ${c}`);
    }
    assert.ok(await alive(), "server still up");
  });

  test("malformed JSON gets a JSON 400 without a stack trace", async () => {
    const res = await raw("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.body, /at .*\.js:\d+|node_modules/);
  });

  test("wrong passwords and unknown e-mails get the same answer", async () => {
    const a = await login(ADMIN.email, "wrong-password");
    const b = await login("nobody@test.local", "wrong-password");
    assert.equal(a.res.status, 401);
    assert.equal(b.res.status, 401);
    assert.deepEqual(a.body, b.body);
    assert.equal(a.cookie, undefined);
  });
});

// ---------------------------------------------------------------------------
describe("logged in", () => {
  let admin, booker, viewer, viewerId;

  before(async () => {
    admin = (await login(ADMIN.email, ADMIN.password)).cookie;
    const mk = async (email, pages) => {
      const res = await api(admin, "POST", "/api/admin/users", { name: email, email, password: "user-pass-123", pages });
      assert.equal(res.status, 201);
      return (await res.json()).user.id;
    };
    await mk("booker@test.local", ["booking"]);
    viewerId = await mk("viewer@test.local", ["booking", "history"]);
    booker = (await login("booker@test.local", "user-pass-123")).cookie;
    viewer = (await login("viewer@test.local", "user-pass-123")).cookie;
  });

  test("session cookie is HttpOnly and SameSite", async () => {
    const { setCookie } = await login(ADMIN.email, ADMIN.password);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Secure/); // plain http locally; forced on Edge
  });

  test("admin can open every page and asset", async () => {
    for (const p of [...PAGES, "/history.js", "/reception.css", "/assets/logo.svg"]) {
      assert.equal((await api(admin, "GET", p)).status, 200, p);
    }
  });

  test("/api/auth/me returns the user without secrets", async () => {
    const body = await (await api(admin, "GET", "/api/auth/me")).json();
    assert.equal(body.user.email, ADMIN.email);
    assert.equal(body.user.isAdmin, true);
    assert.ok(!JSON.stringify(body).includes("scrypt"), "no password hash");
    const users = await (await api(admin, "GET", "/api/admin/users")).json();
    assert.ok(!JSON.stringify(users).includes("scrypt"), "no password hash in the user list");
  });

  test("a user only reaches the pages they were granted", async () => {
    assert.equal((await api(booker, "GET", "/")).status, 200);
    for (const p of ["/flow.html", "/history.html", ...ADMIN_PAGES]) {
      assert.equal((await api(booker, "GET", p)).status, 403, p);
    }
    for (const p of ["/%61dmin.html", "/ADMIN.HTML", "/./history.html"]) {
      assert.ok((await raw(p, { headers: { Cookie: booker } })).status !== 200, p);
    }
  });

  test("the back office is admin-only, whatever a user is granted", async () => {
    // Back-office pages can't be granted one by one: they are dropped, as are made-up names.
    const res = await api(admin, "POST", "/api/admin/users", {
      name: "Staff", email: "staff@test.local", password: "staff-pass-123",
      pages: ["booking", "flow", "history", "assistant", "email", "sms", "email:read", "sms:write", "superuser"],
    });
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).user.pages, ["booking", "flow", "history"]);
    const grants = (await (await api(admin, "GET", "/api/admin/users")).json()).pages.map((p) => p.key);
    assert.deepEqual(grants, ["booking", "flow", "history", "admin"]);

    const staff = (await login("staff@test.local", "staff-pass-123")).cookie;
    for (const p of ["/", "/flow.html", "/history.html"]) assert.equal((await api(staff, "GET", p)).status, 200, p);
    for (const p of ADMIN_PAGES) assert.equal((await api(staff, "GET", p)).status, 403, p);
    for (const [m, url] of ADMIN_APIS) {
      const r = await api(staff, m, url, ["POST", "PATCH", "PUT"].includes(m) ? { pages: ["admin"], enabled: false, to: "+15550002222" } : undefined);
      assert.equal(r.status, 403, `${m} ${url}`);
    }
    assert.equal((await api(staff, "GET", "/api/admin/assistant/../../admin.html")).status !== 200, true);
    const menu = (await (await api(staff, "GET", "/api/auth/me")).json()).pages;
    assert.deepEqual(menu.map((p) => p.href), ["/", "/flow.html", "/history.html"], "no back office in the menu");

    // Admins get every page; the back office is flagged for the menu's admin group.
    const adminMenu = (await (await api(admin, "GET", "/api/auth/me")).json()).pages;
    assert.deepEqual(adminMenu.filter((p) => p.admin).map((p) => p.href), ADMIN_PAGES);
    // 400 with a configured assistant, 502 without one: either way the request got past the gate.
    assert.ok([400, 502].includes((await api(admin, "PATCH", "/api/admin/assistant/bogus", {})).status), "admin reaches the settings API");
  });

  test("e-mail setup: admins read and write it, input is validated", async () => {
    const setup = { enabled: true, from: "frontdesk@example.com", fromName: "Front desk", sandbox: true };
    assert.equal((await api(admin, "PUT", "/api/admin/email", { enabled: true })).status, 400, "on without a sender");
    assert.equal((await api(admin, "PUT", "/api/admin/email", { ...setup, from: "not an address" })).status, 400);
    const saved = await api(admin, "PUT", "/api/admin/email", setup);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).settings.from, "frontdesk@example.com");
    assert.equal((await api(admin, "POST", "/api/admin/email/test", { to: "nope" })).status, 400);
    const seen = await (await api(admin, "GET", "/api/admin/email")).json();
    assert.equal(seen.settings.sandbox, true);
    assert.ok(!JSON.stringify(seen).includes("KEY"), "no API key in the answer");
    assert.equal((await api(admin, "PUT", "/api/admin/email", { enabled: false })).status, 200, "off for the other tests");
  });

  test("SMS setup: admins configure it, the log keeps every attempt, users see only their own", async () => {
    const setup = { enabled: true, from: "+15550001111", overrideTo: "" };
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { enabled: true })).status, 400, "on without a sender");
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { ...setup, from: "not a sender!" })).status, 400);
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { ...setup, from: "TelnyxHotel" })).status, 400, "alphanumeric needs a profile");
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { ...setup, overrideTo: "12345" })).status, 400);
    const saved = await api(admin, "PUT", "/api/admin/sms", { ...setup, from: "+1 (555) 000-1111" });
    assert.equal(saved.status, 200);
    const stored = (await saved.json()).settings;
    assert.equal(stored.from, "+15550001111", "normalized");
    assert.equal(stored.channel, "sms", "SMS unless WhatsApp is chosen");

    // WhatsApp needs a number and an approved template; the channel is only ever sms or whatsapp.
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { ...setup, channel: "whatsapp" })).status, 400);
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { ...setup, channel: "whatsapp", waFrom: "nope", waTemplate: "t" })).status, 400);
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { ...setup, channel: "whatsapp", waFrom: "+15550003333", waTemplate: "Bad Name!" })).status, 400);
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { ...setup, channel: "pigeon" })).status, 200);
    assert.equal((await (await api(admin, "GET", "/api/admin/sms")).json()).settings.channel, "sms", "unknown channel → sms");

    // A guest number that isn't a phone number is not sent, and still logged.
    const booking = { ...(await freeStay()), phone: "12345" };
    const res = await api(booker, "POST", "/api/booking-sms", { booking, code: "THABCDEF", lang: "it", callId: "c_0123456789abcdef" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: false, channel: "sms", reason_code: "invalid_number", reason: "not a phone number in international format" });
    assert.equal((await api(booker, "POST", "/api/booking-sms", { booking: { ...booking, room_type: "nope" }, code: "THABCDEF" })).status, 400, "booking re-validated");
    const log = (await (await api(admin, "GET", "/api/admin/sms")).json()).messages;
    assert.equal(log[0].status, "not_sent");
    assert.equal(log[0].code, "THABCDEF");
    assert.equal(log[0].user, "booker@test.local");
    assert.equal(log[0].callId, "c_0123456789abcdef", "linked to its call for the history");
    await api(booker, "POST", "/api/booking-sms", { booking, code: "THABCDEF", callId: "x'); DROP TABLE calls;--" });
    assert.equal((await (await api(admin, "GET", "/api/admin/sms")).json()).messages[0].callId, null, "a malformed call id is dropped");

    // Isolation: the booker's messages are theirs (and the admin's), nobody else's.
    assert.equal((await api(booker, "GET", "/api/messages")).status, 403, "messages live on the history page");
    const theirs = await (await api(viewer, "GET", "/api/messages")).json();
    assert.equal(theirs.isAdmin, false);
    assert.equal(theirs.sms.length, 0, "another user sees none of them");
    const all = await (await api(admin, "GET", "/api/messages")).json();
    assert.equal(all.isAdmin, true);
    assert.ok(all.sms.filter((m) => m.user === "booker@test.local").length >= 2);
    const staff = (await login("staff@test.local", "staff-pass-123")).cookie;
    await api(staff, "POST", "/api/booking-sms", { booking, code: "THSTAFF2" });
    const own = await (await api(staff, "GET", "/api/messages")).json();
    assert.deepEqual(own.sms.map((m) => [m.user, m.code]), [["staff@test.local", "THSTAFF2"]]);

    // On WhatsApp, the same checks apply and the attempt is logged on that channel.
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { ...setup, channel: "whatsapp", waFrom: "+15550003333", waTemplate: "booking_confirmation", waLanguage: "en_US", waParams: 5 })).status, 200);
    assert.equal((await (await api(booker, "POST", "/api/booking-sms", { booking, code: "THABCDEF", lang: "en" })).json()).channel, "whatsapp");
    const waLog = (await (await api(admin, "GET", "/api/admin/sms")).json()).messages;
    assert.equal(waLog[0].channel, "whatsapp");
    assert.equal(waLog[0].status, "not_sent");

    // Turned off: nothing is sent or logged.
    assert.equal((await api(admin, "PUT", "/api/admin/sms", { enabled: false })).status, 200);
    assert.equal((await (await api(booker, "POST", "/api/booking-sms", { booking, code: "THABCDEF" })).json()).reason_code, "off");
    assert.equal((await (await api(admin, "GET", "/api/admin/sms")).json()).messages.length, waLog.length);
  });

  test("a recap preview is only shown to the user who made the booking (and admins)", async () => {
    const booking = { ...(await freeStay()), email: "ada@example.com" };
    const res = await api(booker, "POST", "/api/booking-recap", { booking, code: "THRECAP2", lang: "en" });
    assert.equal(res.status, 200);
    const { preview_url: url } = await res.json();
    assert.match(url, /^\/recap\//);
    assert.equal((await api(booker, "GET", url)).status, 200);
    assert.equal((await api(admin, "GET", url)).status, 200);
    const staff = (await login("staff@test.local", "staff-pass-123")).cookie;
    assert.equal((await api(staff, "GET", url)).status, 404, "another user can't open it");
  });

  test("a user only opens the WebSockets they were granted", async () => {
    const res = await api(admin, "POST", "/api/admin/users", { name: "Flow", email: "flow@test.local", password: "flow-pass-123", pages: ["flow"] });
    assert.equal(res.status, 201);
    const flow = (await login("flow@test.local", "flow-pass-123")).cookie;
    assert.equal(await wsStatus("/ws/assistant", { cookie: flow }), 403);
    assert.equal(await wsStatus("/ws/nope", { cookie: admin }), "error", "unknown socket path");
  });

  test("cross-site WebSocket handshakes are refused even with a valid cookie", async () => {
    assert.equal(await wsStatus("/ws/assistant", { cookie: admin, origin: "https://evil.example" }), 403);
    assert.equal(await wsStatus("/ws/assistant", { cookie: admin, origin: "null" }), 403);
  });

  test("video avatar: off for new users, only an admin turns it on per user", async () => {
    const created = await api(admin, "POST", "/api/admin/users", { name: "Video", email: "video@test.local", password: "video-pass-123", pages: ["booking"] });
    const { user } = await created.json();
    assert.equal(user.avatar, false);
    const video = (await login("video@test.local", "video-pass-123")).cookie;
    assert.equal((await api(video, "PATCH", `/api/admin/users/${user.id}`, { avatar: true })).status, 403, "not by the user");
    assert.equal((await api(admin, "PATCH", `/api/admin/users/${user.id}`, { avatar: "yes" })).status, 400);
    const on = await api(admin, "PATCH", `/api/admin/users/${user.id}`, { avatar: true });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).user.avatar, true);
    assert.deepEqual((await (await api(video, "GET", "/api/auth/me")).json()).user.pages, ["booking"], "no extra access");
    assert.equal((await (await api(video, "GET", "/api/auth/me")).json()).user.avatar, true);
    const withAvatar = await api(admin, "POST", "/api/admin/users", { name: "V2", email: "v2@test.local", password: "video-pass-123", pages: [], avatar: true });
    assert.equal((await withAvatar.json()).user.avatar, true);
  });

  test("users can't give themselves more access", async () => {
    // Unknown permission names are dropped, and only admins can edit users.
    const res = await api(admin, "PATCH", `/api/admin/users/${viewerId}`, { pages: ["booking", "history", "superuser"] });
    assert.deepEqual((await res.json()).user.pages, ["booking", "history"]);
  });

  test("call history: users see only their own calls, admins see all", async (t) => {
    // A call with a voice that doesn't exist fails right after the voice check, so it's
    // recorded without touching the assistant. The voice list comes from Telnyx.
    const voices = await api(viewer, "GET", "/api/concierge");
    if (voices.status !== 200) return t.skip("no Telnyx voice list (TELNYX_API_KEY missing or offline)");
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws/assistant`, { headers: { Cookie: `${viewer}; telnyxhotel_prefs=${viewerId}|en|Nope.voice` } });
      ws.on("close", resolve);
      ws.on("error", resolve);
    });
    let mine = [];
    for (let i = 0; i < 20 && !mine.length; i++) {
      mine = (await (await api(viewer, "GET", "/api/calls")).json()).calls;
      if (!mine.length) await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(mine.length, 1);
    const id = mine[0].id;
    assert.equal((await api(viewer, "GET", `/api/calls/${id}`)).status, 200);
    assert.equal((await api(admin, "GET", `/api/calls/${id}`)).status, 200);
    assert.equal((await (await api(admin, "GET", "/api/calls")).json()).calls.length, 1);

    // Another non-admin with the history page can't read or delete it.
    await api(admin, "PATCH", `/api/admin/users/${(await (await api(booker, "GET", "/api/auth/me")).json()).user.id}`, { pages: ["booking", "history"] });
    assert.equal((await (await api(booker, "GET", "/api/calls")).json()).calls.length, 0);
    assert.equal((await api(booker, "GET", `/api/calls/${id}`)).status, 404);
    assert.equal((await api(booker, "DELETE", `/api/calls/${id}`)).status, 404);
    assert.equal((await api(booker, "GET", `/api/calls?user=${viewerId}`)).status, 200);
    assert.equal((await (await api(booker, "GET", `/api/calls?user=${viewerId}`)).json()).calls.length, 0);
    await api(admin, "PATCH", `/api/admin/users/${(await (await api(booker, "GET", "/api/auth/me")).json()).user.id}`, { pages: ["booking"] });

    assert.equal((await api(viewer, "DELETE", `/api/calls/${id}`)).status, 200);
  });

  test("concierge settings: admins edit them, guests get only the enabled shortlist", async (t) => {
    const res = await api(admin, "GET", "/api/admin/concierge");
    if (res.status !== 200) return t.skip("no Telnyx voice list (TELNYX_API_KEY missing or offline)");
    const { config, voices } = await res.json();
    assert.deepEqual(config.languages, ["en", "fr", "de", "it", "es", "nl"], "all six languages by default");
    const it = voices.filter((v) => v.language.startsWith("it")).slice(0, 2).map((v) => v.id);
    const fr = voices.find((v) => v.language.startsWith("fr")).id;

    // Validation: no languages, a voice of another language, an unknown voice.
    assert.equal((await api(admin, "PUT", "/api/admin/concierge", { languages: [], defaultLanguage: "it" })).status, 400);
    assert.equal((await api(admin, "PUT", "/api/admin/concierge", { languages: ["it"], defaultLanguage: "it", voices: { it: [fr] } })).status, 400);
    assert.equal((await api(admin, "PUT", "/api/admin/concierge", { languages: ["it"], defaultLanguage: "it", voices: { it: ["Telnyx.Ultra.nope"] } })).status, 400);

    const ok = await api(admin, "PUT", "/api/admin/concierge", {
      languages: ["it", "fr"], defaultLanguage: "fr",
      voices: { it, fr: [fr] }, defaultVoice: { it: it[1] }, greetings: { fr: "Bonjour, ici {name}." },
    });
    assert.equal(ok.status, 200);
    const pub = await (await api(booker, "GET", "/api/concierge")).json();
    assert.equal(pub.defaultLanguage, "fr");
    assert.deepEqual(pub.languages.map((l) => l.code), ["it", "fr"]);
    assert.deepEqual(pub.languages[0].voices.map((v) => v.id), it);
    assert.equal(pub.languages[0].defaultVoice, it[1]);
    assert.equal(pub.languages[1].greeting, "Bonjour, ici {name}.");

    // The user's pick is a cookie: honoured while it's on the shortlist, and only for that user.
    const bookerId = (await (await api(booker, "GET", "/api/auth/me")).json()).user.id;
    const outside = voices.find((v) => v.language.startsWith("it") && !it.includes(v.id)).id;
    const put = await api(booker, "PUT", "/api/prefs", { lang: "it", voice: it[0] });
    assert.equal(put.status, 200);
    const prefs = put.headers.get("set-cookie");
    assert.match(prefs, /^telnyxhotel_prefs=.*HttpOnly.*SameSite=Lax/);
    const withPrefs = `${booker}; ${prefs.split(";")[0]}`;
    assert.deepEqual((await (await api(withPrefs, "GET", "/api/concierge")).json()).preferred, { lang: "it", voice: it[0] });
    assert.deepEqual(await (await api(withPrefs, "GET", "/api/prefs")).json(), { lang: "it", voice: it[0] });
    assert.deepEqual(await (await api(booker, "PUT", "/api/prefs", { lang: "it", voice: outside })).json(), { lang: "it", voice: it[1] }, "not offered → the default");
    assert.equal((await api(booker, "PUT", "/api/prefs", { lang: "nl" })).status, 400, "language not enabled");
    assert.deepEqual(await (await api(`${viewer}; ${prefs.split(";")[0]}`, "GET", "/api/prefs")).json(), { lang: "fr", voice: fr }, "another user's cookie is ignored");
    assert.deepEqual(await (await api(`${booker}; telnyxhotel_prefs=${bookerId}|it|${outside}`, "GET", "/api/prefs")).json(), { lang: "it", voice: it[1] });

    // A voice outside the shortlist can't start a call.
    const closed = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws/assistant`, { headers: { Cookie: `${booker}; telnyxhotel_prefs=${bookerId}|it|${encodeURIComponent(outside)}` } });
      let error = "";
      ws.on("message", (d) => { error ||= JSON.parse(d).error?.message || ""; });
      ws.on("close", () => resolve(error));
    });
    assert.match(closed, /voice not allowed/);

    // Back to the defaults for the other tests.
    await api(admin, "PUT", "/api/admin/concierge", { languages: ["en", "it"], defaultLanguage: "en", voices: { it, en: [voices.find((v) => v.language.startsWith("en")).id] } });
  });

  test("assistant settings reject bad input before anything is written to Telnyx", async (t) => {
    // Validation reads the live assistant first, so this needs TELNYX_API_KEY and TELNYX_ASSISTANT_ID.
    if ((await api(admin, "GET", "/api/admin/assistant")).status !== 200) return t.skip("no live Telnyx assistant (TELNYX_ASSISTANT_ID missing or offline)");
    assert.equal((await api(admin, "PATCH", "/api/admin/assistant/bogus", {})).status, 400);
    assert.equal((await api(admin, "PATCH", "/api/admin/assistant/listening", { eot_threshold: 2, eot_timeout_ms: 2500, time_limit_secs: 600 })).status, 400);
    assert.equal((await api(admin, "PATCH", "/api/admin/assistant/prompt", { model: "x/not-a-model", instructions: "hi" })).status, 400);
    assert.equal((await api(admin, "PATCH", "/api/admin/assistant/prompt", { model: "x", instructions: "   " })).status, 400);
    assert.equal((await api(admin, "PATCH", "/api/admin/assistant/avatar", { enabled: true, avatar_id: "elena", background_id: "moon" })).status, 400);
    assert.equal((await api(admin, "PATCH", "/api/admin/assistant/avatar", { enabled: true, avatar_id: "../x", background_id: "studio" })).status, 400);
  });

  test("API responses aren't cached and pages can't be framed", async () => {
    const res = await api(admin, "GET", "/api/calls");
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    const page = await api(admin, "GET", "/admin.html");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("x-powered-by"), null);
  });

  test("changing a password signs that user out everywhere", async () => {
    const { cookie } = await login("viewer@test.local", "user-pass-123");
    assert.equal((await api(cookie, "POST", "/api/auth/password", { current: "wrong", next: "new-pass-1234" })).status, 403);
    assert.equal((await api(cookie, "POST", "/api/auth/password", { current: "user-pass-123", next: "new-pass-1234" })).status, 200);
    assert.equal((await api(cookie, "GET", "/api/auth/me")).status, 401);
    assert.equal((await api(viewer, "GET", "/api/auth/me")).status, 401);
    assert.equal((await login("viewer@test.local", "new-pass-1234")).res.status, 200);
  });

  test("deleting a user ends their session", async () => {
    const res = await api(admin, "POST", "/api/admin/users", { name: "Temp", email: "temp@test.local", password: "temp-pass-123", pages: ["booking"] });
    const { id } = (await res.json()).user;
    const temp = (await login("temp@test.local", "temp-pass-123")).cookie;
    assert.equal((await api(temp, "GET", "/")).status, 200);
    assert.equal((await api(admin, "DELETE", `/api/admin/users/${id}`)).status, 200);
    assert.equal((await api(temp, "GET", "/api/auth/me")).status, 401);
    assert.equal((await api(temp, "GET", "/")).status, 302);
  });

  test("the last admin can't be removed or demoted", async () => {
    const me = (await (await api(admin, "GET", "/api/auth/me")).json()).user;
    assert.equal((await api(admin, "DELETE", `/api/admin/users/${me.id}`)).status, 400);
    assert.equal((await api(admin, "PATCH", `/api/admin/users/${me.id}`, { pages: ["booking"] })).status, 400);
  });

  test("logout clears the cookie", async () => {
    const res = await api(admin, "POST", "/api/auth/logout");
    assert.match(res.headers.get("set-cookie"), /telnyxhotel_session=;.*Max-Age=0/);
  });
});

// ---------------------------------------------------------------------------
describe("client-side", () => {
  test("login only follows same-site ?next= paths", async () => {
    const html = await (await fetch(`${BASE}/login.html`)).text();
    const src = html.match(/const safeNext = (.+);/)[1];
    const safe = (next) => new Function("next", "location", `return ${src};`)(next, { origin: "http://localhost" });
    for (const bad of ["//evil.com", "/\\evil.com", "/\\/evil.com", "https://evil.com", "javascript:alert(1)", "/%5Cevil.com".replace("%5C", "\\")]) {
      assert.equal(safe(bad), null, bad);
    }
    assert.equal(safe("/history.html#/call/x"), "/history.html#/call/x");
  });

  test("every page but the booking site shows the top bar; only the booking site the floating menu", async () => {
    const { readFileSync } = await import("node:fs");
    for (const page of ["flow", "history", "admin", "assistant", "email", "sms"]) {
      const html = readFileSync(path.join(ROOT, `public/${page}.html`), "utf8");
      const js = readFileSync(path.join(ROOT, `public/${page}.js`), "utf8");
      assert.match(html, /<header id="topbar"><\/header>/, page);
      assert.match(html, /<script src="account\.js"><\/script>/, page);
      assert.match(html, /href="brand\.css"/, page);
      assert.match(js, /Account\.topbar\(\$\("topbar"\)\)/, page);
      assert.doesNotMatch(html, /class="subnav"/, page);
    }
    assert.match(readFileSync(path.join(ROOT, "public/index.html"), "utf8"), /<script src="account\.js" data-menu><\/script>/);
  });

  test("every page has the help column and the version footer (ui.js), with the same help keys in every language", async () => {
    const { readFileSync } = await import("node:fs");
    for (const page of ["index", "login", "flow", "history", "admin", "assistant", "email", "sms"]) {
      assert.match(readFileSync(path.join(ROOT, `public/${page}.html`), "utf8"), /<script src="ui\.js"><\/script>/, page);
    }
    const forbidden = await (await api((await login("booker@test.local", "user-pass-123")).cookie, "GET", "/admin.html")).text();
    assert.match(forbidden, /<script src="\/ui\.js">/, "the No access page too");
    const keysOf = (lang) => Object.keys(Object.assign({}, ...[...readFileSync(path.join(ROOT, `public/i18n/${lang}.js`), "utf8")
      .matchAll(/"(help\.[\w.]+)":/g)].map((m) => ({ [m[1]]: 1 })))).sort();
    const en = keysOf("en");
    assert.ok(en.includes("help.booking.1.h") && en.includes("help.flow.1.h"));
    for (const lang of ["fr", "de", "it", "es", "nl"]) assert.deepEqual(keysOf(lang), en, lang);
  });

  test("history page escapes the booking total (it comes from the browser)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(path.join(ROOT, "public/history.js"), "utf8");
    const line = src.split("\n").find((l) => l.includes("const bookingChip"));
    assert.ok(line && !/\$\{b\.total_eur/.test(line), "total_eur must go through esc()");
  });
});

// ---------------------------------------------------------------------------
describe("guest (no account)", () => {
  let guest, guestId, admin;

  before(async () => {
    admin = (await login(ADMIN.email, ADMIN.password)).cookie;
    const res = await fetch(`${BASE}/api/auth/guest`, { method: "POST" });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie");
    assert.match(setCookie, /^telnyxhotel_session=.*HttpOnly.*SameSite=Lax/);
    guest = setCookie.split(";")[0];
    guestId = (await res.json()).user.id;
  });

  test("the login page offers it, and it starts a session of its own", async () => {
    assert.deepEqual(await (await fetch(`${BASE}/api/auth/guest`)).json(), { enabled: true });
    const { user, pages } = await (await api(guest, "GET", "/api/auth/me")).json();
    assert.match(guestId, /^g_[0-9a-f]{12}$/);
    assert.equal(user.guest, true);
    assert.equal(user.isAdmin, false);
    assert.equal(user.avatar, true, "video avatar on (when the assistant has one)");
    assert.deepEqual(pages.map((p) => p.href), ["/", "/flow.html"]);
    const other = (await (await fetch(`${BASE}/api/auth/guest`, { method: "POST" })).json()).user.id;
    assert.notEqual(other, guestId, "every guest is someone else");
  });

  test("only the booking site and how it works: no history, no back office, no password", async () => {
    for (const p of ["/", "/flow.html"]) assert.equal((await api(guest, "GET", p)).status, 200, p);
    for (const p of ["/history.html", ...ADMIN_PAGES]) assert.equal((await api(guest, "GET", p)).status, 403, p);
    for (const [m, url] of [...ADMIN_APIS, ["GET", "/api/calls"], ["GET", "/api/calls/c_x"], ["DELETE", "/api/calls/c_x"], ["GET", "/api/messages"]]) {
      const r = await api(guest, m, url, ["POST", "PATCH", "PUT"].includes(m) ? { pages: ["admin"], enabled: false } : undefined);
      assert.equal(r.status, 403, `${m} ${url}`);
    }
    assert.equal((await api(guest, "POST", "/api/auth/password", { current: "", next: "new-pass-1234" })).status, 403);
  });

  test("nothing is sent by e-mail, SMS or WhatsApp", async () => {
    await api(admin, "PUT", "/api/admin/sms", { enabled: true, from: "+15550001111", overrideTo: "" });
    const before = (await (await api(admin, "GET", "/api/admin/sms")).json()).messages.length;
    const booking = { ...(await freeStay()), email: "ada@example.com", phone: "+447700900123" };
    const recap = await (await api(guest, "POST", "/api/booking-recap", { booking, code: "THGUEST1", lang: "en" })).json();
    assert.equal(recap.sent, false);
    assert.equal(recap.guest, true);
    assert.equal(recap.preview_url, undefined, "not even a preview");
    const sms = await (await api(guest, "POST", "/api/booking-sms", { booking, code: "THGUEST1", lang: "en" })).json();
    assert.deepEqual([sms.sent, sms.reason_code], [false, "guest"]);
    assert.equal((await (await api(admin, "GET", "/api/admin/sms")).json()).messages.length, before, "nothing logged as sent");
    await api(admin, "PUT", "/api/admin/sms", { enabled: false });
  });

  test("forged or tampered guest sessions are rejected", async () => {
    const forge = (data) => `telnyxhotel_session=${Buffer.from(JSON.stringify(data)).toString("base64url")}.AAAA`;
    assert.equal((await api(forge({ gid: "g_000000000000", exp: Date.now() + 1e9 }), "GET", "/api/auth/me")).status, 401);
    const [payload, sig] = guest.split("=")[1].split(".");
    const admin = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), uid: "u_x" })).toString("base64url");
    assert.equal((await api(`telnyxhotel_session=${admin}.${sig}`, "GET", "/api/auth/me")).status, 401);
  });

  test("English only, and the admins see the guest's calls", async (t) => {
    const res = await api(guest, "GET", "/api/concierge");
    if (res.status !== 200) return t.skip("no Telnyx voice list (TELNYX_API_KEY missing or offline)");
    const concierge = await res.json();
    assert.deepEqual(concierge.languages.map((l) => l.code), ["en"]);
    assert.equal(concierge.defaultLanguage, "en");
    assert.equal((await api(guest, "PUT", "/api/prefs", { lang: "it" })).status, 400);
    assert.equal((await api(guest, "PUT", "/api/prefs", { lang: "en" })).status, 200);

    // A call with a voice that doesn't exist is refused at the voice check, and still recorded.
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws/assistant`, { headers: { Cookie: `${guest}; telnyxhotel_prefs=${guestId}|en|Nope.voice` } });
      ws.on("close", resolve);
      ws.on("error", resolve);
    });
    let calls = [];
    for (let i = 0; i < 20 && !calls.length; i++) {
      calls = (await (await api(admin, "GET", `/api/calls?user=${guestId}`)).json()).calls;
      if (!calls.length) await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].user.id, calls[0].user.name], [guestId, "Guest"]);
    await api(admin, "DELETE", `/api/calls/${calls[0].id}`);
  });

  test("guest stats: only for admins, with each call's stage and where it came from", async () => {
    // Refused before the call starts (bad voice, or no voice list): recorded as a guest call all the same.
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws/assistant`, {
        headers: { Cookie: `${guest}; telnyxhotel_prefs=${guestId}|en|Nope.voice`, "CF-IPCountry": "it" },
      });
      ws.on("close", resolve);
      ws.on("error", resolve);
    });
    let call;
    for (let i = 0; i < 20 && !call; i++) {
      const res = await api(admin, "GET", "/api/admin/guests?days=1");
      assert.equal(res.status, 200);
      call = (await res.json()).calls.find((c) => c.guestId === guestId);
      if (!call) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(call, "the guest call is counted");
    assert.deepEqual([call.stage, call.booked, call.endedBy], ["failed", false, "error"]);
    assert.equal(call.ip, null, "a loopback address isn't a location");
    assert.equal(call.country, "IT", "without a public IP, the platform's country header");
    assert.equal((await api(guest, "GET", "/api/admin/guests")).status, 403);
    await api(admin, "DELETE", `/api/calls/${call.id}`);
  });
});

// Rate limit last: it locks this IP out of logins for 15 minutes.
describe("brute force", () => {
  test("logins are rate-limited per IP", async () => {
    let status;
    for (let i = 0; i < 12; i++) status = (await login(ADMIN.email, "nope-nope")).res.status;
    assert.equal(status, 429);
    assert.equal((await login(ADMIN.email, ADMIN.password)).res.status, 429, "even the right password waits");
  });
});
