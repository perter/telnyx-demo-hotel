// IP address → country (ISO 3166 alpha-2), offline, from geo/ip-country.bin.gz
// (built by scripts/geo-update.js from DB-IP's free country database). No
// address ever leaves the server. Loaded on first use; without the file every
// lookup answers null.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "geo", "ip-country.bin.gz");
let table; // { countries, v4, v4c, v6hi, v6lo, v6c } or false when missing

function load() {
  if (table !== undefined) return table;
  try {
    const buf = zlib.gunzipSync(readFileSync(FILE));
    if (buf.toString("latin1", 0, 4) !== "IPC1") throw new Error("unknown format");
    let o = 4;
    const n = buf.readUInt32LE(o); o += 4;
    const countries = Array.from({ length: n }, (_, i) => buf.toString("latin1", o + i * 2, o + i * 2 + 2)); o += n * 2;
    const u32 = (count) => { const a = new Uint32Array(count); for (let i = 0; i < count; i++, o += 4) a[i] = buf.readUInt32LE(o); return a; };
    const u8 = (count) => { const a = Uint8Array.from(buf.subarray(o, o + count)); o += count; return a; };
    const n4 = buf.readUInt32LE(o); o += 4;
    const v4 = u32(n4), v4c = u8(n4);
    const n6 = buf.readUInt32LE(o); o += 4;
    const v6hi = u32(n6), v6lo = u32(n6), v6c = u8(n6);
    table = { countries, v4, v4c, v6hi, v6lo, v6c };
  } catch (err) {
    if (err.code !== "ENOENT") console.error("IP country database unreadable:", err.message);
    table = false;
  }
  return table;
}

// Index of the last range starting at or before the key.
function floor(count, before) {
  let lo = 0, hi = count - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (before(mid)) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function countryOf(ip) {
  const t = load();
  if (!t || !ip) return null;
  let s = String(ip).replace(/^::ffff:(?=\d+\.)/i, "");
  let i = -1, code;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const n = s.split(".").reduce((a, p) => a * 256 + Number(p), 0);
    i = floor(t.v4.length, (m) => t.v4[m] <= n);
    if (i >= 0) code = t.countries[t.v4c[i]];
  } else if (s.includes(":")) {
    s = s.split("%")[0];
    const [head, tail = ""] = s.split("::");
    const a = head ? head.split(":") : [], b = tail ? tail.split(":") : [];
    const g = (s.includes("::") ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a).map((x) => parseInt(x || "0", 16));
    if (g.length !== 8 || g.some((x) => !(x >= 0 && x <= 0xffff))) return null;
    const hi = (g[0] << 16 | g[1]) >>> 0, lo = (g[2] << 16 | g[3]) >>> 0;
    i = floor(t.v6hi.length, (m) => t.v6hi[m] < hi || (t.v6hi[m] === hi && t.v6lo[m] <= lo));
    if (i >= 0) code = t.countries[t.v6c[i]];
  }
  return code && /^[A-Z]{2}$/.test(code) && code !== "ZZ" ? code : null;
}

export const geoReady = () => !!load();
