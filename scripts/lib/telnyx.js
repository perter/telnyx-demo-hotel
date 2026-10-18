// Shared by the CLI scripts (setup, assistant:sync, kb:sync): the Telnyx REST
// API, the knowledge-base bucket (Telnyx Storage, S3-compatible) and the
// assistant built from assistant/.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = "https://api.telnyx.com/v2";

export async function telnyx(key, method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${url} ${res.status}: ${JSON.stringify(json.errors?.[0] ?? json)}`), { status: res.status });
  return json;
}

// ---------------------------------------------------------------------------
// Knowledge base: kb/*.txt in a Storage bucket, embedded for the retrieval tool.
// Bucket names are unique across all Telnyx accounts, so each install picks its own.
// ---------------------------------------------------------------------------
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (k, data) => crypto.createHmac("sha256", k).update(data).digest();

// One S3 request signed with AWS Signature V4; the API key is the access key.
async function s3({ key, bucket, region }, method, object = "", body = "", contentType) {
  const host = `${region}.telnyxcloudstorage.com`;
  const pathname = `/${bucket}${object ? `/${object.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) headers["content-type"] = contentType;
  const names = Object.keys(headers).sort();
  const canonical = [method, pathname, "", ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  let k = hmac(`AWS4${key}`, day);
  for (const part of [region, "s3", "aws4_request"]) k = hmac(k, part);
  const signature = crypto.createHmac("sha256", k).update(["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n")).digest("hex");
  const { host: _, ...sent } = headers;
  const res = await fetch(`https://${host}${pathname}`, {
    method,
    headers: { ...sent, Authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` },
    body: body || undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, etag: res.headers.get("etag")?.replaceAll('"', ""), text: await res.text() };
}

export const kbFiles = () => fs.readdirSync(path.join(ROOT, "kb")).filter((f) => f.endsWith(".txt")).sort();

// Creates the bucket if needed, uploads the files that changed and waits until
// Telnyx has embedded them. Returns the uploaded file names.
export async function syncKnowledgeBase({ key, bucket, region, log = console.log }) {
  const ctx = { key, bucket, region };
  const created = await s3(ctx, "PUT");
  if (created.status === 409 && !/BucketAlreadyOwnedByYou/.test(created.text)) {
    throw new Error(`The bucket name "${bucket}" is taken by another Telnyx account: set another KB_BUCKET in .env`);
  }
  if (![200, 409].includes(created.status)) throw new Error(`create bucket ${created.status}: ${created.text}`);
  log(`Bucket ${bucket} (${region}): ${created.status === 200 ? "created" : "exists"}`);

  // Upload only what changed (the bucket's ETag is the file's MD5).
  const files = [];
  for (const f of kbFiles()) {
    const body = fs.readFileSync(path.join(ROOT, "kb", f), "utf8");
    const head = await s3(ctx, "HEAD", f);
    if (head.status === 200 && head.etag === crypto.createHash("md5").update(body).digest("hex")) continue;
    const put = await s3(ctx, "PUT", f, body, "text/plain; charset=utf-8");
    if (put.status !== 200) throw new Error(`upload ${f} ${put.status}: ${put.text}`);
    log(`Uploaded ${f}`);
    files.push(f);
  }
  if (!files.length) {
    log("Knowledge base is up to date.");
    return files;
  }

  // The first run embeds the bucket; later, Telnyx re-embeds changed files on its
  // own, so wait until every uploaded file has been embedded after this upload.
  const uploadedAt = new Date(Date.now() - 5000).toISOString();
  const { data: task } = await telnyx(key, "POST", "/ai/embeddings", { bucket_name: bucket });
  log(`Embedding task ${task.task_id}: ${task.status}`);
  for (let i = 0; i < 72; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const { data: embedded } = await telnyx(key, "GET", `/ai/embeddings/buckets/${bucket}`);
    const failed = embedded.filter((e) => files.includes(e.filename) && /fail/.test(e.status));
    if (failed.length) throw new Error(`embedding failed: ${failed.map((e) => `${e.filename} (${e.error_reason || e.status})`).join(", ")}`);
    const pending = files.filter((f) => {
      const e = embedded.find((x) => x.filename === f);
      return !e?.last_embedded_at || `${e.last_embedded_at}Z` < uploadedAt;
    });
    if (!pending.length) {
      log(`Embedded ${files.length} file(s).`);
      return files;
    }
    process.stdout.write(`\r  waiting for embeddings: ${pending.length} file(s) (${(i + 1) * 5}s)`);
  }
  throw new Error(`still not embedded after 6 minutes; check GET /v2/ai/embeddings/buckets/${bucket}`);
}

// ---------------------------------------------------------------------------
// Assistant: assistant/assistant.json with the prompt from instructions.md and
// the retrieval tool pointed at this install's bucket.
// ---------------------------------------------------------------------------
const CONFIG = path.join(ROOT, "assistant/assistant.json");
const PROMPT = path.join(ROOT, "assistant/instructions.md");

export function assistantConfig({ bucket, keepVoice = false } = {}) {
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  config.instructions = fs.readFileSync(PROMPT, "utf8");
  delete config.instructions_note;
  if (keepVoice) delete config.voice_settings; // the web backend switches it per call
  if (bucket) for (const t of config.tools) if (t.type === "retrieval") t.retrieval.bucket_ids = [bucket];
  return config;
}

export const readAssistant = (key, id) => telnyx(key, "GET", `/ai/assistants/${id}`);

// Copies the live prompt and model into the repo.
export function pullAssistant(live) {
  fs.writeFileSync(PROMPT, `${String(live.instructions || "").trim()}\n`);
  const saved = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  saved.model = live.model;
  fs.writeFileSync(CONFIG, `${JSON.stringify(saved, null, 2)}\n`);
}

// What differs between the live assistant and the repo (edited from /assistant.html?).
export function liveDifferences(live, config) {
  const norm = (text) => String(text || "").trim();
  return [
    norm(live.instructions) !== norm(config.instructions) && "prompt",
    live.model !== config.model && `model (${live.model} live, ${config.model} in the repo)`,
  ].filter(Boolean);
}

// Creates the assistant, or updates the one with this id.
export const saveAssistant = (key, id, config) => telnyx(key, "POST", `/ai/assistants${id ? `/${id}` : ""}`, config);

// ---------------------------------------------------------------------------
// .env: read and update KEY=value lines in place, keeping comments.
// ---------------------------------------------------------------------------
export const ENV = path.join(ROOT, ".env");

export function readEnv(file = ENV) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

// Sets each key: replaces its line (commented-out "# KEY=" included) or appends it.
export function writeEnv(values, file = ENV) {
  let lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    const j = i >= 0 ? i : lines.findIndex((l) => new RegExp(`^\\s*#\\s*${k}\\s*=`).test(l));
    if (j >= 0) lines[j] = line;
    else lines.push(line);
  }
  if (lines.at(-1) !== "") lines.push("");
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });
}
