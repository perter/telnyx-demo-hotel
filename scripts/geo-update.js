#!/usr/bin/env node
// Downloads the free DB-IP "IP to Country Lite" database (CC BY 4.0,
// https://db-ip.com) and compacts it into geo/ip-country.bin.gz for geo.js:
// adjacent ranges of the same country merged, IPv6 kept to its /64 prefix.
// Run monthly or so: npm run geo:update
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "geo", "ip-country.bin.gz");

async function download() {
  const now = new Date();
  for (const back of [0, 1]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const url = `https://download.db-ip.com/free/dbip-country-lite-${d.toISOString().slice(0, 7)}.csv.gz`;
    const res = await fetch(url);
    if (res.ok) return { url, csv: zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString() };
  }
  throw new Error("could not download the DB-IP country database");
}

const v4 = (s) => s.split(".").reduce((n, p) => n * 256 + Number(p), 0);
// The first 64 bits of an IPv6 address, as [hi, lo] 32-bit halves.
function v6prefix(s) {
  const [head, tail = ""] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a;
  const g = groups.map((x) => parseInt(x || "0", 16));
  return [(g[0] << 16 | g[1]) >>> 0, (g[2] << 16 | g[3]) >>> 0];
}

const { url, csv } = await download();
const countries = [];
const index = (cc) => { let i = countries.indexOf(cc); if (i < 0) { i = countries.length; countries.push(cc); } return i; };
const four = [], six = [];
for (const line of csv.split("\n")) {
  const [start, , cc] = line.trim().split(",");
  if (!cc) continue;
  if (start.includes(":")) {
    const [hi, lo] = v6prefix(start);
    const last = six.at(-1);
    if (last && last[0] === hi && last[1] === lo) { last[2] = index(cc); continue; } // same /64
    if (!last || last[2] !== index(cc)) six.push([hi, lo, index(cc)]);
  } else {
    const last = four.at(-1);
    if (!last || last[1] !== index(cc)) four.push([v4(start), index(cc)]);
  }
}

const size = 4 + 4 + countries.length * 2 + 4 + four.length * 5 + 4 + six.length * 9;
const buf = Buffer.alloc(size);
let o = 0;
buf.write("IPC1", o); o += 4;
buf.writeUInt32LE(countries.length, o); o += 4;
for (const cc of countries) { buf.write(cc.padEnd(2).slice(0, 2), o, "latin1"); o += 2; }
buf.writeUInt32LE(four.length, o); o += 4;
for (const [s] of four) { buf.writeUInt32LE(s, o); o += 4; }
for (const [, i] of four) buf[o++] = i;
buf.writeUInt32LE(six.length, o); o += 4;
for (const [hi] of six) { buf.writeUInt32LE(hi, o); o += 4; }
for (const [, lo] of six) { buf.writeUInt32LE(lo, o); o += 4; }
for (const [, , i] of six) buf[o++] = i;

mkdirSync(path.dirname(OUT), { recursive: true });
const gz = zlib.gzipSync(buf, { level: 9 });
writeFileSync(OUT, gz);
console.log(`${url}\n→ ${path.relative(root, OUT)}: ${four.length} IPv4 + ${six.length} IPv6 ranges, ${countries.length} countries, ${(gz.length / 1e6).toFixed(1)} MB`);
