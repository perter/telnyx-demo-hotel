// First run: from a Telnyx API key to a working TelnyxHotel.
//   npm run setup               (npm run setup -- --dry-run to only show the plan)
// 1. checks Node and creates .env from .env.example;
// 2. asks for TELNYX_API_KEY if .env has none, and checks it (read-only call);
// 3. creates the knowledge base: a Storage bucket with kb/*.txt, embedded;
// 4. creates the AI Assistant from assistant/ (prompt, model, transcription,
//    voice, hangup + retrieval + the three client-side booking tools), or updates
//    the one in TELNYX_ASSISTANT_ID;
// 5. writes TELNYX_ASSISTANT_ID, KB_BUCKET and, when unset, SESSION_SECRET and
//    the first admin's ADMIN_EMAIL / ADMIN_PASSWORD into .env.
// Safe to re-run. --force overwrites a live assistant edited from /assistant.html.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  ENV, ROOT, assistantConfig, kbFiles, liveDifferences, readAssistant, readEnv, saveAssistant, syncKnowledgeBase, telnyx, writeEnv,
} from "./lib/telnyx.js";

const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const step = (n, text) => console.log(`\n[${n}/5] ${text}`);
const done = (text) => console.log(`      ✓ ${text}`);
const plan = (text) => console.log(`      → ${DRY ? "would " : ""}${text}`);
function fail(text) {
  console.error(`\n✗ ${text}`);
  process.exit(1);
}

console.log(`TelnyxHotel setup${DRY ? " (dry run: nothing is created or written)" : ""}`);

// 1. Node and .env ------------------------------------------------------------
step(1, "Environment");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) fail(`Node.js 22.5 or newer is required (this is ${process.version}).`);
done(`Node.js ${process.version}`);
if (!fs.existsSync(ENV)) {
  if (DRY) plan("create .env from .env.example");
  else {
    fs.copyFileSync(path.join(ROOT, ".env.example"), ENV);
    fs.chmodSync(ENV, 0o600);
    done("created .env from .env.example");
  }
} else done(".env found");
const env = readEnv(fs.existsSync(ENV) ? ENV : path.join(ROOT, ".env.example"));
const updates = {};

// 2. API key ------------------------------------------------------------------
step(2, "Telnyx API key");
let key = process.env.TELNYX_API_KEY || env.TELNYX_API_KEY;
if (!key || /your-key|^KEY0xP\.\.\./.test(key)) {
  if (!process.stdin.isTTY) fail("Put your Telnyx API key in .env (TELNYX_API_KEY=…). Create one at https://portal.telnyx.com/#/api-keys");
  console.log("      No API key yet. Create one in the Telnyx Portal: https://portal.telnyx.com/#/api-keys");
  console.log("      (no Telnyx account? sign up at https://telnyx.com/sign-up)");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  key = (await rl.question("      Paste your API key: ")).trim();
  rl.close();
  if (!key) fail("No API key given.");
  updates.TELNYX_API_KEY = key;
}
try {
  await telnyx(key, "GET", "/ai/assistants");
} catch (err) {
  fail(err.status === 401 || err.status === 403
    ? "Telnyx refused this API key. Check it in the Portal (https://portal.telnyx.com/#/api-keys)."
    : `Could not reach the Telnyx API: ${err.message}`);
}
done("the key works (AI Assistants API reachable)");

// An assistant from an earlier run is updated, and keeps its knowledge base.
let id = env.TELNYX_ASSISTANT_ID || "";
let live = null;
if (id) {
  try { live = await readAssistant(key, id); } catch (err) {
    if (err.status !== 404) fail(`Could not read assistant ${id}: ${err.message}`);
    console.log(`      ! TELNYX_ASSISTANT_ID=${id} does not exist in this account: a new assistant will be created.`);
    id = "";
  }
}
const liveBucket = live?.tools?.find((t) => t.type === "retrieval")?.retrieval?.bucket_ids?.[0];

// 3. Knowledge base -----------------------------------------------------------
step(3, "Knowledge base (Telnyx Storage + embeddings)");
const bucket = env.KB_BUCKET || liveBucket || `telnyxhotel-kb-${crypto.randomBytes(4).toString("hex")}`;
const region = env.KB_REGION || "us-central-1";
if (!env.KB_BUCKET) updates.KB_BUCKET = bucket;
if (DRY) plan(`use bucket ${bucket} in ${region} (created if missing), upload the changed files of ${kbFiles().length} in kb/ and embed them`);
else {
  try {
    await syncKnowledgeBase({ key, bucket, region, log: (text) => done(text) });
  } catch (err) { fail(`Knowledge base: ${err.message}`); }
}

// 4. AI Assistant -------------------------------------------------------------
step(4, "AI Assistant");
const config = assistantConfig({ bucket, keepVoice: !!live });
const tools = config.tools.map((t) => t.client_side_tool?.name || t.type).join(", ");
const differs = live ? liveDifferences(live, config) : [];
if (live && differs.length && !FORCE) {
  done(`kept "${live.name}" (${id}): its ${differs.join(", ")} differ from assistant/, as if edited from /assistant.html (--force overwrites)`);
} else if (DRY) {
  plan(`${live ? `update ${id}` : "create"} "${config.name}": ${config.model}, ${config.transcription.model} transcription, tools: ${tools}`);
} else {
  try {
    const saved = await saveAssistant(key, live ? id : undefined, config);
    id = saved.id;
    done(`${live ? "updated" : "created"} "${saved.name}" (${saved.id}), tools: ${tools}`);
  } catch (err) { fail(`Assistant: ${err.message}`); }
}
if (id && id !== env.TELNYX_ASSISTANT_ID) updates.TELNYX_ASSISTANT_ID = id;

// 5. .env ---------------------------------------------------------------------
step(5, "Settings (.env)");
if (!env.SESSION_SECRET) updates.SESSION_SECRET = crypto.randomBytes(32).toString("base64url");
let password = null;
if (!env.ADMIN_EMAIL) updates.ADMIN_EMAIL = "admin@example.com";
if (!env.ADMIN_PASSWORD) updates.ADMIN_PASSWORD = password = crypto.randomBytes(12).toString("base64url");
const shown = Object.keys(updates).map((k) => (/KEY|SECRET|PASSWORD/.test(k) ? `${k}=…` : `${k}=${updates[k]}`));
if (!shown.length) done("nothing to change");
else if (DRY) plan(`write ${shown.join(", ")}`);
else {
  writeEnv(updates);
  done(`wrote ${shown.join(", ")}`);
}

const email = updates.ADMIN_EMAIL || env.ADMIN_EMAIL;
console.log(`
Done${DRY ? " (dry run)" : ""}. Next:
  npm start                     then open http://localhost:${env.PORT || 3000}
  Sign in as ${email}${password && !DRY ? ` with the password ${password}\n                                (shown once; it is also in .env: change it from Users & access)` : ""}
  The first admin is created on the first start, while there are no users yet.

In the app (admin pages, top bar):
  Users & access   create accounts and grant Booking / How it works / Call history
  AI Assistant     languages, voice shortlists, prompt, model, video avatar
  E-mail           turn on booking recaps with Telnyx Email (a sending domain)
  SMS / WhatsApp   turn on confirmations with Telnyx Messaging

Run it for real: HTTPS is needed for the microphone. Deploy on your own Node
22.5+ backend, or on Telnyx Edge Compute (README → Deploy).`);
