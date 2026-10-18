// A finished call's full record (timeline included) can be a few hundred KB of
// JSON; it's stored gzip-compressed and base64-encoded so a row stays small.
import zlib from "node:zlib";

export const packCall = (call) => `gz:${zlib.gzipSync(JSON.stringify(call)).toString("base64")}`;

export function unpackCall(data) {
  if (data.startsWith("gz:")) return JSON.parse(zlib.gunzipSync(Buffer.from(data.slice(3), "base64")).toString());
  return JSON.parse(data);
}
