// IP → country (geo.js). Skipped until the table is built: npm run geo:update
import { test } from "node:test";
import assert from "node:assert/strict";
import { countryOf, geoReady } from "../geo.js";

test("origin IPs map to a country; private, loopback and malformed ones don't", (t) => {
  if (!geoReady()) return t.skip("no geo/ip-country.bin.gz (npm run geo:update)");
  assert.equal(countryOf("8.8.8.8"), "US");
  assert.equal(countryOf("81.2.69.142"), "GB");
  assert.equal(countryOf("::ffff:81.2.69.142"), "GB", "IPv4-mapped IPv6");
  assert.match(countryOf("2a00:1450:4001:80b::200e"), /^[A-Z]{2}$/);
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "::1", "", null, "not an ip", "1:2:3"]) assert.equal(countryOf(ip), null, String(ip));
});
