// @jfs/netlify-kit v0.1.0 — shared serverless-function primitives for the JFS
// family of buildless static sites deployed on Netlify.
//
// Every sibling app that ships Netlify Functions (market-monitor, Surf-Tracker,
// FlightCheck, …) re-implements the same handful of cross-cutting concerns in
// each function's `utils/` or `lib/` folder: CORS headers + preflight, JSON /
// text / error response shaping, an SSRF guard for caller-supplied URLs, input
// validation regexes, a retry-with-backoff fetch wrapper, a per-IP rate
// limiter, and a try/catch handler boundary. Each copy drifts slightly — and
// the differences are exactly the subtle correctness bugs (double-decoded `&`,
// an unbounded `await res.text()`, a metadata-IP SSRF hole) that a single
// tested implementation eliminates. This module is that single copy.
//
// Pure ESM, dependency-free at install time. The one optional integration —
// Netlify Blobs for distributed rate limiting — is reached through a dynamic
// `import('@netlify/blobs')` that degrades to the in-memory limiter when the
// package or a configured store isn't present, so nothing here forces a
// dependency on consumers that don't use it.
//
// The canonical sources this consolidates:
//   - market-monitor/netlify/functions/utils/{cors,handler,validate,retry,
//     ssrf,rate-limit,rate-limit-distributed}.js
//   - Surf-Tracker/netlify/functions/lib/{http,ratelimit,url}.js
//   - FlightCheck/netlify/functions/lib/http.js
//
// Sections: CORS · responses · validation · SSRF · retry · rate limiting ·
// handler factory.

// ───────────────────────────── CORS ─────────────────────────────

// The cross-origin posture the family relies on: a `*` (or env-pinned) origin
// for the GitHub-Pages / split-deploy setups, GET+POST+OPTIONS, a JSON
// content-type on the request, and `nosniff`. `buildCorsHeaders` returns a
// fresh object each call so a caller can mutate the result without poisoning a
// shared singleton.
export function buildCorsHeaders(opts = {}) {
  const {
    origin = process.env.CORS_ORIGIN || '*',
    methods = 'GET, POST, OPTIONS',
    headers = 'Content-Type',
    maxAge,
  } = opts;
  const out = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': headers,
    'X-Content-Type-Options': 'nosniff',
  };
  if (maxAge != null) out['Access-Control-Max-Age'] = String(maxAge);
  return out;
}

/** Returns a 204 preflight response for an OPTIONS request, or null otherwise.
 *  The 204 already carries the CORS headers, so callers can
 *  `const pf = handlePreflight(event); if (pf) return pf;`. */
export function handlePreflight(event, opts = {}) {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: buildCorsHeaders(opts), body: '' };
  }
  return null;
}

// ─────────────────────────── responses ──────────────────────────

const JSON_CT = 'application/json';

/** Standard JSON response. `body` may be a JS value (stringified) or an
 *  already-serialised JSON string (passed through verbatim — skips a
 *  parse/stringify round-trip when relaying an upstream payload). Options:
 *  `{ statusCode=200, cacheControl, headers, cors }` where `cors` is either
 *  `true` (default headers), `false` (omit), or an options object forwarded to
 *  `buildCorsHeaders`. */
export function jsonResponse(body, opts = {}) {
  const { statusCode = 200, cacheControl, headers, cors = true } = opts;
  const h = { 'Content-Type': JSON_CT };
  if (cors) Object.assign(h, buildCorsHeaders(cors === true ? undefined : cors));
  if (cacheControl) h['Cache-Control'] = cacheControl;
  if (headers) Object.assign(h, headers);
  return {
    statusCode,
    headers: h,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** Standard JSON error: `{ error }` body with CORS + content-type + nosniff.
 *  Use for every 4xx / 5xx that returns a JSON error. */
export function errorResponse(statusCode, error, opts = {}) {
  return jsonResponse({ error: String(error) }, { ...opts, statusCode });
}

/** Plain-text response with the same CORS default as jsonResponse.
 *  `cache-control` is only emitted when a caller asks for one. */
export function textResponse(body, opts = {}) {
  const { statusCode = 200, cacheControl, headers, cors = true } = opts;
  const h = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (cors) Object.assign(h, buildCorsHeaders(cors === true ? undefined : cors));
  if (cacheControl) h['Cache-Control'] = cacheControl;
  if (headers) Object.assign(h, headers);
  return { statusCode, headers: h, body: body == null ? '' : String(body) };
}

/** Safe, bounded stringification of a thrown value for an error body/log, so a
 *  pathological `.message` can't bloat a response or a log line. */
export function errorMessage(e, max = 200) {
  return String((e && e.message) || e).slice(0, max);
}

// Default upstream-body cap: 5 MB. Functions that fetch arbitrary upstreams
// should guard against a hostile/runaway host streaming a multi-GB body into a
// serverless function's memory.
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Cheap pre-read guard: if an upstream advertises a `content-length` over the
 *  cap, return a 502 response object; otherwise null. content-length may be
 *  absent (chunked) — then this passes and `readTextCapped` is the backstop. */
export function checkResponseSize(response, opts = {}) {
  const { maxBytes = MAX_RESPONSE_BYTES, headers } = opts;
  const cl = response?.headers?.get?.('content-length');
  if (cl && Number(cl) > maxBytes) {
    return errorResponse(502, 'Upstream response too large', headers ? { headers } : undefined);
  }
  return null;
}

/** Read a fetch Response body as UTF-8 text, refusing to buffer more than
 *  `maxBytes`. Streams the body and aborts the moment it exceeds the cap. A
 *  too-large body throws an Error tagged `.tooLarge = true` so callers can
 *  treat it as a hard, non-retryable failure. Decoding matches `Response.text()`
 *  (always UTF-8 per the Fetch standard). */
export async function readTextCapped(res, maxBytes = MAX_RESPONSE_BYTES) {
  const tooLarge = () => {
    const e = new Error('Upstream response too large');
    e.tooLarge = true;
    return e;
  };
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > maxBytes) throw tooLarge();

  // No readable stream (rare) — fall back to text(), still size-guarded.
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooLarge();
    return text;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* already closing */ }
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ────────────────────────── validation ──────────────────────────

// Ticker symbols: A-Z, digits, dot, dash, colon, slash, caret, equals. Max 20
// chars — covers BINANCE:BTCUSDT, BTC/USD, ^GSPC, 000001.SS.
export const SYMBOL_RE = /^[A-Z0-9.\-:/^=]{1,20}$/;

// FRED series IDs: uppercase letters, digits, underscore; max 30 chars.
export const FRED_ID_RE = /^[A-Z0-9_]{1,30}$/;

// Unix timestamps: 1-11 digits.
export const UNIX_TS_RE = /^\d{1,11}$/;

/** Calendar date `YYYY-MM-DD`, validated against rollover (rejects 2024-02-30). */
export function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return d instanceof Date && !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

/** Unix timestamp string in a sane range (0 … now + 1 day). */
export function isValidTimestamp(str) {
  if (!UNIX_TS_RE.test(str)) return false;
  const ts = Number(str);
  const maxTs = Math.floor(Date.now() / 1000) + 86400;
  return ts >= 0 && ts <= maxTs;
}

// ──────────────────────────── SSRF ──────────────────────────────
//
// For functions that fetch a caller-supplied URL and can't use a static host
// allowlist (e.g. an article extractor that follows wherever a news item
// links). Two layers: a string-level guard (HTTPS only, no IP literals, no
// internal suffixes) and a DNS-resolution guard that rejects any name pointing
// at a private / link-local / loopback address (e.g. an attacker domain whose
// A record is 169.254.169.254, the cloud-metadata endpoint). The pure IP
// helpers are exported for unit testing.

/** String-level guard. Returns `{ ok: true, url }` (a parsed URL) or
 *  `{ ok: false, error }`. */
export function parseSafeHttpsUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: 'invalid-url', url: null };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'not-https', url: null };
  if (url.port && url.port !== '443') return { ok: false, error: 'bad-port', url: null };
  if (url.username || url.password) return { ok: false, error: 'has-credentials', url: null };

  const host = url.hostname.toLowerCase();
  const isIpLiteral =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
  if (
    isIpLiteral ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return { ok: false, error: 'disallowed-host', url: null };
  }
  return { ok: true, error: null, url };
}

export function isSafeHttpsUrl(input) {
  return parseSafeHttpsUrl(input).ok;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||        // "this" network
    inRange('10.0.0.0', 8) ||       // RFC1918
    inRange('100.64.0.0', 10) ||    // CGNAT
    inRange('127.0.0.0', 8) ||      // loopback
    inRange('169.254.0.0', 16) ||   // link-local (incl. 169.254.169.254 metadata)
    inRange('172.16.0.0', 12) ||    // RFC1918
    inRange('192.0.0.0', 24) ||     // IETF protocol assignments
    inRange('192.0.2.0', 24) ||     // TEST-NET-1
    inRange('192.168.0.0', 16) ||   // RFC1918
    inRange('198.18.0.0', 15) ||    // benchmarking
    inRange('198.51.100.0', 24) ||  // TEST-NET-2
    inRange('203.0.113.0', 24) ||   // TEST-NET-3
    inRange('224.0.0.0', 4) ||      // multicast
    inRange('240.0.0.0', 4)         // reserved
  );
}

export function isPrivateIPv6(ip) {
  const a = String(ip).toLowerCase().split('%')[0]; // drop any zone id
  if (a === '::1' || a === '::') return true; // loopback / unspecified
  // IPv4-mapped / -embedded (::ffff:1.2.3.4) — judge by the embedded v4.
  const v4 = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4 && (a.startsWith('::ffff:') || a.startsWith('::'))) return isPrivateIPv4(v4[1]);
  const head = a.split(':')[0];
  if (/^f[cd]/.test(head)) return true;    // fc00::/7 unique-local
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (/^fec/.test(head)) return true;      // fec0::/10 (deprecated site-local)
  if (/^ff/.test(head)) return true;       // ff00::/8 multicast
  return false;
}

export function isPrivateAddress(address, family) {
  return family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

/** Resolve `hostname` and return `{ ok: true }` only if every resolved address
 *  is in a public range. A DNS failure or empty result is treated as not-ok
 *  (fail closed) — refuse a name we can't vet rather than fetch it blind. */
export async function resolveHostIsPublic(hostname) {
  let dns;
  try {
    ({ promises: dns } = await import('node:dns'));
  } catch {
    return { ok: false, error: 'dns-unavailable' };
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: 'dns-failed' };
  }
  if (!addrs || !addrs.length) return { ok: false, error: 'dns-empty' };
  for (const { address, family } of addrs) {
    if (isPrivateAddress(address, family)) {
      return { ok: false, error: 'private-ip', address };
    }
  }
  return { ok: true, error: null };
}

// ──────────────────────────── retry ─────────────────────────────
//
// Bounded exponential backoff with full jitter around an async fetch. Retries
// on thrown network errors and 502/503/504; 429 only when the caller opts in
// (a free-tier 429 usually means "back off entirely", not "retry now"). Never
// retries other 4xx (the request itself is bad) and never retries an
// AbortError on the caller's signal.

export const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const DEFAULT_RETRIES = 2; // total attempts = retries + 1
const DEFAULT_BASE_MS = 200;
const DEFAULT_CAP_MS = 2000;

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fullJitter(attempt, baseMs, capMs, rng) {
  const exp = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(rng() * exp);
}

export async function fetchWithRetry(url, init, opts) {
  const {
    retries = DEFAULT_RETRIES,
    baseMs = DEFAULT_BASE_MS,
    capMs = DEFAULT_CAP_MS,
    retryOn429 = false,
    sleepFn = _sleep,
    fetchFn = fetch,
    rng = Math.random,
  } = opts || {};

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetchFn(url, init);
      const isRetryable = RETRYABLE_STATUSES.has(r.status) || (retryOn429 && r.status === 429);
      if (!isRetryable || attempt === retries) return r;
      // Drain the body so the connection can be reused.
      try { await r.body?.cancel?.(); } catch { /* best effort */ }
    } catch (e) {
      // An AbortError on the caller's signal must not be retried.
      if (e?.name === 'AbortError' || init?.signal?.aborted) throw e;
      lastErr = e;
      if (attempt === retries) throw e;
    }
    await sleepFn(fullJitter(attempt, baseMs, capMs, rng));
  }
  // Unreachable — the loop always returns or throws.
  throw lastErr || new Error('fetchWithRetry: exhausted retries');
}

// ──────────────────────── rate limiting ─────────────────────────
//
// Best-effort, in-process, fixed-window limiter. Serverless instances are
// ephemeral and several can be warm at once, so this caps burst abuse PER
// INSTANCE rather than globally (ceiling N×max across N warm instances — still
// a cap). Zero latency, zero storage, no cleanup debt; fails open by
// construction. `createRateLimiter` returns an isolated limiter so distinct
// endpoints keep independent buckets instead of sharing one module-global Map.

const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,39}$/;

/** Best client IP from a Netlify function event:
 *  `x-nf-client-connection-ip` (the real client IP Netlify sets) →
 *  first `x-forwarded-for` hop → `client-ip` → `'unknown'` (so a missing IP
 *  throttles as one shared group rather than escaping the limit). */
export function clientIp(event) {
  const h = (event && event.headers) || {};
  const xff = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : '';
  const ip = h['x-nf-client-connection-ip'] || xff || h['client-ip'] || 'unknown';
  return IP_RE.test(ip) ? ip : 'unknown';
}

// Default cap on the raw query string — reject megabytes of unparseable garbage
// before it ever reaches the parser / upstream.
export const MAX_QUERY_LENGTH = 2048;

/** Create an isolated in-memory rate limiter.
 *  `{ max=60, windowMs=60_000, maxKeys=5000, maxQueryLength=2048 }`.
 *  Returns `{ allow(ip), check(event, overrides), reset() }`:
 *   - `allow(ip)` → boolean (under the limit).
 *   - `check(event)` → a ready-to-return 429 / 414 response object, or null
 *     when allowed. Per-call `{ max, windowMs }` overrides are accepted. */
export function createRateLimiter(config = {}) {
  const {
    max: defMax = 60,
    windowMs: defWindow = 60_000,
    maxKeys = 5000,
    maxQueryLength = MAX_QUERY_LENGTH,
    cors,
  } = config;

  const buckets = new Map(); // key → { windowStart, count }

  function prune(now, windowMs) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= windowMs) buckets.delete(k);
    }
    if (buckets.size > maxKeys) buckets.clear(); // last resort; only under-counts
  }

  function allow(ip, max = defMax, windowMs = defWindow, now = Date.now()) {
    const key = ip || 'unknown';
    let b = buckets.get(key);
    if (!b || now - b.windowStart >= windowMs) {
      b = { windowStart: now, count: 0 };
      buckets.set(key, b);
    }
    b.count++;
    if (buckets.size > maxKeys) prune(now, windowMs);
    return b.count <= max;
  }

  function check(event, overrides = {}) {
    const max = overrides.max ?? defMax;
    const windowMs = overrides.windowMs ?? defWindow;
    const corsOpt = overrides.cors ?? cors;
    const jsonHeaders = (extra) => ({
      'Content-Type': JSON_CT,
      ...buildCorsHeaders(corsOpt === true || corsOpt == null ? undefined : corsOpt),
      ...extra,
    });

    const qs = event?.rawQuery || event?.rawQueryString || '';
    if (typeof qs === 'string' && qs.length > maxQueryLength) {
      return { statusCode: 414, headers: jsonHeaders(), body: JSON.stringify({ error: 'Query string too long' }) };
    }
    if (!allow(clientIp(event), max, windowMs)) {
      return {
        statusCode: 429,
        headers: jsonHeaders({ 'Retry-After': String(Math.ceil(windowMs / 1000)) }),
        body: JSON.stringify({ error: 'Too many requests' }),
      };
    }
    return null;
  }

  return { allow, check, reset: () => buckets.clear() };
}

/** Distributed limiter backed by Netlify Blobs, for endpoints that benefit
 *  from cross-instance state. Read-modify-write can undercount by 1-2 hits per
 *  window under concurrency — acceptable for personal-dashboard thresholds.
 *  Degrades transparently to an in-memory fallback limiter when
 *  `@netlify/blobs` or a configured store is unavailable. Returns the same
 *  `{ check, reset }` shape as `createRateLimiter`, but `check` is async. */
export function createDistributedRateLimiter(config = {}) {
  const {
    max: defMax = 60,
    windowMs: defWindow = 60_000,
    storeName = 'rate-limits',
    maxQueryLength = MAX_QUERY_LENGTH,
    cors,
  } = config;

  const fallback = createRateLimiter(config);
  let storePromise = null;

  function getStore() {
    if (storePromise) return storePromise;
    storePromise = (async () => {
      try {
        const { getStore } = await import('@netlify/blobs');
        return getStore({ name: storeName, consistency: 'strong' });
      } catch {
        return null; // local dev / missing siteID → in-memory fallback
      }
    })();
    return storePromise;
  }

  async function check(event, overrides = {}) {
    const max = overrides.max ?? defMax;
    const windowMs = overrides.windowMs ?? defWindow;
    const corsOpt = overrides.cors ?? cors;

    const qs = event?.rawQuery || event?.rawQueryString || '';
    if (typeof qs === 'string' && qs.length > maxQueryLength) {
      return {
        statusCode: 414,
        headers: { 'Content-Type': JSON_CT, ...buildCorsHeaders(corsOpt === true || corsOpt == null ? undefined : corsOpt) },
        body: JSON.stringify({ error: 'Query string too long' }),
      };
    }

    const store = await getStore();
    if (!store) return fallback.check(event, overrides);

    const ip = clientIp(event);
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `rl:${ip}:${windowStart}`;

    let entry = null;
    try {
      entry = await store.get(key, { type: 'json' });
    } catch {
      return fallback.check(event, overrides); // read failure → degrade
    }

    const count = (entry?.count || 0) + 1;
    if (count > max) {
      return {
        statusCode: 429,
        headers: {
          'Content-Type': JSON_CT,
          'Retry-After': String(Math.ceil(windowMs / 1000)),
          ...buildCorsHeaders(corsOpt === true || corsOpt == null ? undefined : corsOpt),
        },
        body: JSON.stringify({ error: 'Too many requests' }),
      };
    }
    try {
      await store.setJSON(key, { count, expiresAt: windowStart + windowMs * 2 });
    } catch { /* better to permit than to error out */ }
    return null;
  }

  return { check, reset: () => { storePromise = null; fallback.reset(); }, _getStore: getStore };
}

// ─────────────────────── handler factory ────────────────────────
//
// Wraps the cross-cutting concerns every function needs — CORS preflight,
// per-IP rate limiting, top-level try/catch + 500 fallback — so each function
// focuses on the provider-specific bits.
//
//   export const handler = createHandler({
//     name: 'quote',
//     rateLimit: { max: 120, windowMs: 60_000 },
//     handle: async (event) => {
//       const { symbol } = event.queryStringParameters || {};
//       if (!symbol) return errorResponse(400, 'Missing symbol');
//       const r = await fetchWithRetry(upstream, { signal: AbortSignal.timeout(8000) });
//       return jsonResponse(await r.json(), { cacheControl: 'no-store' });
//     },
//   });

/** Build a Netlify function handler. Options:
 *   - `name`      — identifier used in the default error log.
 *   - `cors`      — options forwarded to `buildCorsHeaders` for the preflight.
 *   - `rateLimit` — `{ max, windowMs }` config (a private limiter is created),
 *                   OR a limiter instance `{ check }` (from `createRateLimiter`
 *                   / `createDistributedRateLimiter`), OR `null`/`false` to
 *                   disable. Default: 60 req / 60 s.
 *   - `handle`    — `async (event, context) => responseObject`. Required.
 *   - `onError`   — `async (error, event) => responseObject`. Optional; the
 *                   default logs and returns a 500. */
export function createHandler(options) {
  const {
    name = 'handler',
    cors,
    rateLimit = { max: 60, windowMs: 60_000 },
    handle,
    onError,
  } = options || {};

  if (typeof handle !== 'function') {
    throw new Error('createHandler: handle option is required');
  }

  let limiter = null;
  if (rateLimit && typeof rateLimit.check === 'function') {
    limiter = rateLimit; // a pre-built limiter instance
  } else if (rateLimit !== null && rateLimit !== false) {
    limiter = createRateLimiter({ ...rateLimit, cors });
  }

  return async (event, context) => {
    const preflight = handlePreflight(event, cors === true || cors == null ? undefined : cors);
    if (preflight) return preflight;

    if (limiter) {
      const limited = await limiter.check(event);
      if (limited) return limited;
    }

    try {
      return await handle(event, context);
    } catch (error) {
      if (onError) {
        try {
          return await onError(error, event);
        } catch (innerErr) {
          // onError itself threw — fall through so we never leak it.
          console.error(`${name} onError threw:`, errorMessage(innerErr));
        }
      }
      console.error(`${name} error:`, errorMessage(error));
      return errorResponse(500, 'Internal error', cors == null ? undefined : { cors });
    }
  };
}
