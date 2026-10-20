// Traffic of the Telnyx Edge function serving this app, for the Guest stats
// page: request counts by outcome, latency, CPU and memory, from the Edge
// Compute metric aggregates API (kept 7 days). Every HTTP request
// counts (pages, assets, API, WebSockets, bots), not calls. The share of
// requests per Edge region is shown in the Telnyx Portal only: the API
// doesn't return it.
const TELNYX = "https://api.telnyx.com/v2";
const MAX_HOURS = 168;
const TTL = 60_000;

let apiKey, functionName;
let funcId = null;
const cache = new Map(); // hours -> { at, value }

export function initEdgeMetrics(options) {
  apiKey = options.apiKey;
  functionName = options.functionName || "telnyxhotel-concierge";
}

async function telnyx(pathname, attempt = 0) {
  const res = await fetch(`${TELNYX}${pathname}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return telnyx(pathname, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Telnyx ${res.status}: ${body.errors?.[0]?.detail || body.errors?.[0]?.title || "request failed"}`), { status: 502 });
  return body;
}

async function resolveFunction() {
  if (funcId) return funcId;
  for (let page = 1; page <= 10; page++) {
    const { data = [], meta = {} } = await telnyx(`/compute/funcs?page[number]=${page}&page[size]=50`);
    const f = data.find((x) => x.name === functionName || x.func_name === functionName || x.id === functionName);
    if (f) return (funcId = f.id);
    if (page >= (meta.total_pages || 1)) break;
  }
  throw Object.assign(new Error(`Edge function "${functionName}" not found on this Telnyx account`), { status: 404 });
}

// Run fn over items, a few at a time (Telnyx rate-limits bursts).
async function pool(items, fn, parallel = 4) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const aggregate = async (id, from, to) =>
  (await telnyx(`/compute/funcs/${id}/metric_aggregates?start_time=${new Date(from).toISOString()}&end_time=${new Date(to).toISOString()}`)).data?.[0] || {};

// days → hours, at most the 7 days the metrics are kept.
export async function edgeTraffic({ days = 30 } = {}) {
  const hours = days === 1 ? 24 : MAX_HOURS;
  const cached = cache.get(hours);
  if (cached && Date.now() - cached.at < TTL) return cached.value;

  const id = await resolveFunction();
  // The per-minute series is sampled, not counted: buckets come from the aggregate API.
  // Whole hours, or calendar days in UTC; the last bucket runs up to now.
  const size = (hours <= 24 ? 1 : 24) * 3600_000;
  const end = Math.floor(Date.now() / 60_000) * 60_000;
  const count = hours * 3600_000 / size;
  const start = Math.floor(end / size) * size - (count - 1) * size;
  const edges = Array.from({ length: count }, (_, i) => start + i * size);
  const [agg, parts] = await Promise.all([aggregate(id, start, end), pool(edges, (t) => aggregate(id, t, Math.min(t + size, end)))]);
  const value = {
    function: functionName,
    hours,
    bucketHours: size / 3600_000,
    capped: days !== 1 && days !== 7,
    totals: {
      requests: agg.request_count ?? 0,
      success: agg.request_success_count ?? 0,
      clientErrors: agg.request_client_error_count ?? 0,
      errors: agg.request_error_count ?? 0,
      latencyP50Ms: agg.request_latency_p50_ms ?? null,
      latencyP95Ms: agg.request_latency_p95_ms ?? null,
      latencyP99Ms: agg.request_latency_p99_ms ?? null,
      cpuAvgCores: agg.cpu_used_cores_avg ?? null,
      cpuMaxCores: agg.cpu_used_cores_max ?? null,
      memoryAvgBytes: agg.memory_used_bytes_avg ?? null,
      memoryMaxBytes: agg.memory_used_bytes_max ?? null,
    },
    series: edges.map((t, i) => ({
      t: new Date(t).toISOString(),
      requests: parts[i].request_count ?? 0,
      success: parts[i].request_success_count ?? 0,
      clientErrors: parts[i].request_client_error_count ?? 0,
      errors: parts[i].request_error_count ?? 0,
      p95Ms: parts[i].request_latency_p95_ms ?? null,
    })),
  };
  cache.set(hours, { at: Date.now(), value });
  return value;
}
