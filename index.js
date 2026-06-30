// @jfs/netlify-kit v0.2.0 — shared serverless-function primitives for the JFS
// family of buildless static sites deployed on Netlify.
//
// Every sibling app that ships Netlify Functions (market-monitor, Surf-Tracker,
// FlightCheck, …) re-implements the same cross-cutting concerns in each
// function's `utils/` or `lib/` folder: CORS headers + preflight, JSON / text /
// error response shaping, an SSRF guard for caller-supplied URLs, input
// validation regexes, a retry-with-backoff fetch wrapper, a per-IP rate
// limiter, and a try/catch handler boundary. Each copy drifts slightly — and
// the differences are exactly the subtle correctness bugs (a double-decoded
// `&`, an unbounded `await res.text()`, a metadata-IP SSRF hole) that a single
// tested implementation eliminates. This module is that single copy.
//
// COMPATIBILITY SUPERSET. The sibling apps grew slightly different signatures
// for the same idea (market-monitor's `jsonResponse(body, cacheControl,
// extraHeaders)` returns 200; Surf-Tracker's `jsonResponse(statusCode, obj,
// opts)` takes an explicit status). To let every app adopt the kit by changing
// only its import paths — not its call sites — `jsonResponse`/`textResponse`
// detect the calling convention from their first argument (a number ⇒ the
// status-first form, anything else ⇒ the body-first form). The behavior of each
// form is byte-for-byte what its origin app already shipped, so the apps' test
// suites pass unchanged.
//
// Pure ESM, dependency-free at install time. The one optional integration —
// Netlify Blobs for distributed rate limiting — is reached through a dynamic
// `import('@netlify/blobs')` that degrades to the in-memory limiter when the
// package (or a configured store) isn't present.
//
// Canonical sources this consolidates:
//   - market-monitor/netlify/functions/utils/{cors,handler,validate,retry,
//     ssrf,rate-limit,rate-limit-distributed}.js
//   - Surf-Tracker/netlify/functions/lib/{http,ratelimit,url}.js
//   - FlightCheck/netlify/functions/lib/http.js (response sugar)

// ───────────────────────────── CORS ─────────────────────────────
//
// The cross-origin posture the family relies on: a `*` (or env-pinned) origin
// for the split-deploy setups, GET+POST+OPTIONS, a JSON request content-type,
// and `nosniff`.

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

export const corsHeaders = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'X-Content-Type-Options': 'nosniff',
};

/** Returns a 204 preflight response for an OPTIONS request, or null otherwise.
 *  The 204 already carries the CORS headers. (market-monitor form.) */
export function handlePreflight(event) {
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  return null;
}

/** Unconditional CORS preflight (204) with advertised verbs/headers — the
 *  Surf-Tracker form, used when a handler answers OPTIONS itself rather than
 *  delegating to `createHandler`. */
export function preflightResponse(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const methods = typeof o.methods === 'string' ? o.methods : 'GET, OPTIONS';
  const allowHeaders = typeof o.allowHeaders === 'string' ? o.allowHeaders : 'content-type';
  const maxAge = typeof o.maxAge === 'string' ? o.maxAge : '86400';
  const corsOrigin = typeof o.corsOrigin === 'string' ? o.corsOrigin : '*';
  return {
    statusCode: 204,
    headers: {
      'access-control-allow-origin': corsOrigin,
      'access-control-allow-methods': methods,
      'access-control-allow-headers': allowHeaders,
      'access-control-max-age': maxAge,
    },
    body: '',
  };
}

// ─────────────────────────── responses ──────────────────────────

export const JSON_HEADERS = { 'Content-Type': 'application/json', ...corsHeaders };

const JSON_CT_CHARSET = 'application/json; charset=utf-8';
const TEXT_CT_CHARSET = 'text/plain; charset=utf-8';

// market-monitor form: `jsonResponse(body, cacheControl?, extraHeaders?)` → 200.
// `body` may be a JS value (stringified) or a pre-serialised JSON string.
function bodyFirstJson(body, cacheControl, extraHeaders) {
  const headers = { ...JSON_HEADERS };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return {
    statusCode: 200,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

// Surf-Tracker form: `jsonResponse(statusCode, obj, opts?)`.
function statusFirstJson(statusCode, obj, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const headers = o.headers && typeof o.headers === 'object' ? o.headers : {};
  const cacheControl = typeof o.cacheControl === 'string' ? o.cacheControl : 'no-store';
  const corsOrigin = typeof o.corsOrigin === 'string' ? o.corsOrigin : '*';
  return {
    statusCode,
    headers: {
      'content-type': JSON_CT_CHARSET,
      'cache-control': cacheControl,
      'access-control-allow-origin': corsOrigin,
      ...headers,
    },
    body: JSON.stringify(obj),
  };
}

/** JSON response. Two calling conventions, disambiguated by the first argument:
 *   - `jsonResponse(body, cacheControl?, extraHeaders?)` → a 200 with the
 *     family CORS + content-type headers (market-monitor form).
 *   - `jsonResponse(statusCode, obj, opts?)` → an arbitrary-status JSON body
 *     with `cache-control: no-store` by default (Surf-Tracker form). */
export function jsonResponse(a, b, c) {
  return typeof a === 'number' ? statusFirstJson(a, b, c) : bodyFirstJson(a, b, c);
}

/** Standard JSON error: `{ error }` body with CORS + content-type + nosniff.
 *  `errorResponse(statusCode, error, extraHeaders?)` (market-monitor form). */
export function errorResponse(statusCode, error, extraHeaders) {
  return {
    statusCode,
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
    body: JSON.stringify({ error }),
  };
}

/** Plain-text response, `textResponse(statusCode, body, opts?)` (Surf-Tracker
 *  form). `cache-control` is only emitted when a caller asks for one. */
export function textResponse(statusCode, body, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const headers = o.headers && typeof o.headers === 'object' ? o.headers : {};
  const corsOrigin = typeof o.corsOrigin === 'string' ? o.corsOrigin : '*';
  const out = {
    'content-type': TEXT_CT_CHARSET,
    'access-control-allow-origin': corsOrigin,
    ...headers,
  };
  if (typeof o.cacheControl === 'string') out['cache-control'] = o.cacheControl;
  return { statusCode, headers: out, body: body == null ? '' : String(body) };
}

// FlightCheck response sugar — thin, named status shortcuts over the helpers
// above. (FlightCheck additionally wants `cache-control: no-store` on every
// function response; it passes that through its own thin wrapper.)
export const ok = (body) => bodyFirstJson(body);
export const badRequest = (error) => errorResponse(400, error);
export const notFound = (error) => errorResponse(404, error);
export const methodNotAllowed = (error = 'Method not allowed.') => errorResponse(405, error);
export const serverError = (error) => errorResponse(500, error);
export const badGateway = (error) => errorResponse(502, error);

/** Relay an upstream error status, clamped to a valid 4xx/5xx range so an
 *  unexpected upstream value never yields a malformed response. `extraHeaders`
 *  forwards rate-limit hints (e.g. Retry-After). */
export const upstreamError = (status, err, extraHeaders) => {
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
  return errorResponse(safeStatus, err, extraHeaders);
};

/** Safe, bounded stringification of a thrown value for an error body/log. */
export function errorMessage(e, max = 200) {
  return String((e && e.message) || e).slice(0, max);
}

// Default upstream-body cap: 5 MB.
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Cheap pre-read guard: if an upstream advertises a `content-length` over the
 *  cap, return a 502 response object; otherwise null. content-length may be
 *  absent (chunked) — then this passes and `readTextCapped` is the backstop.
 *  `checkResponseSize(response, headers?)` (market-monitor form). */
export function checkResponseSize(response, headers) {
  const cl = response?.headers?.get?.('content-length');
  if (cl && Number(cl) > MAX_RESPONSE_BYTES) {
    return {
      statusCode: 502,
      headers: headers || {},
      body: JSON.stringify({ error: 'Upstream response too large' }),
    };
  }
  return null;
}

/** Read a fetch Response body as UTF-8 text, refusing to buffer more than
 *  `maxBytes`. Streams the body and aborts the moment it exceeds the cap. A
 *  too-large body throws an Error tagged `.tooLarge = true` so callers can
 *  treat it as a hard, non-retryable failure. */
export async function readTextCapped(res, maxBytes) {
  const tooLarge = () => {
    const e = new Error('Upstream response too large');
    e.tooLarge = true;
    return e;
  };
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > maxBytes) throw tooLarge();

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

// Ticker symbols: A-Z, digits, dot, dash, colon, slash, caret, equals. Max 20.
export const SYMBOL_RE = /^[A-Z0-9.\-:/^=]{1,20}$/;
// FRED series IDs: uppercase letters, digits, underscore; max 30.
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
// For functions that fetch a caller-supplied URL without a static host
// allowlist. Two layers: a string-level guard (HTTPS only, no IP literals, no
// internal suffixes) and a DNS-resolution guard that rejects any name pointing
// at a private / link-local / loopback address (e.g. an attacker domain whose
// A record is 169.254.169.254, the cloud-metadata endpoint). The pure IP
// helpers are exported for unit testing.

/** String-level guard. Returns `{ ok, url, error }`. */
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
// thrown network errors and 502/503/504; 429 only when the caller opts in.
// Never retries other 4xx, and never an AbortError on the caller's signal.

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
      try { await r.body?.cancel?.(); } catch { /* best effort */ }
    } catch (e) {
      if (e?.name === 'AbortError' || init?.signal?.aborted) throw e;
      lastErr = e;
      if (attempt === retries) throw e;
    }
    await sleepFn(fullJitter(attempt, baseMs, capMs, rng));
  }
  throw lastErr || new Error('fetchWithRetry: exhausted retries');
}

// ──────────────────────── rate limiting ─────────────────────────
//
// Two limiters the family uses, kept as their origin apps shipped them:
//   • checkRateLimit / checkRateLimitDistributed — return a ready-to-return
//     429 / 414 response object (or null). market-monitor's createHandler form.
//   • rateLimit — a low-level fixed-window check returning { ok, retryAfter },
//     letting a handler shape its own 429 (Surf-Tracker form).
// Both are best-effort, in-process (per warm instance); the distributed variant
// adds a Netlify Blobs bucket with transparent in-memory fallback.

const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,39}$/;
export const MAX_QUERY_LENGTH = 2048;

// --- market-monitor: checkRateLimit (single shared Map, keyed by IP) ---

const hits = new Map();
const CLEANUP_INTERVAL = 120_000;
let lastCleanup = Date.now();

function cleanup(windowMs) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, entry] of hits) {
    if (now - entry.windowStart > windowMs * 2) hits.delete(key);
  }
}

function allowRequest(ip, max = 60, windowMs = 60_000) {
  cleanup(windowMs);
  const now = Date.now();
  const key = ip || 'unknown';
  let entry = hits.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 1, windowStart: now };
    hits.set(key, entry);
    return true;
  }
  entry.count++;
  return entry.count <= max;
}

/** Returns a 429 / 414 response object if rate-limited or the query string is
 *  oversized, or null if allowed. The response already carries CORS headers. */
export function checkRateLimit(event, max = 60, windowMs = 60_000) {
  const qs = event.rawQuery || event.rawQueryString || '';
  if (typeof qs === 'string' && qs.length > MAX_QUERY_LENGTH) {
    return {
      statusCode: 414,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Query string too long' }),
    };
  }
  let ip = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
         || event.headers?.['client-ip']
         || 'unknown';
  if (!IP_RE.test(ip)) ip = 'unknown';

  if (!allowRequest(ip, max, windowMs)) {
    return {
      statusCode: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(windowMs / 1000)),
        ...corsHeaders,
      },
      body: JSON.stringify({ error: 'Too many requests' }),
    };
  }
  return null;
}

// --- market-monitor: checkRateLimitDistributed (Netlify Blobs) ---

let storePromise = null;
function getRateStore() {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    try {
      const { getStore } = await import('@netlify/blobs');
      return getStore({ name: 'rate-limits', consistency: 'strong' });
    } catch {
      return null; // local dev / missing siteID — caller falls back to in-memory
    }
  })();
  return storePromise;
}

function extractIp(event) {
  let ip = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
        || event.headers?.['client-ip']
        || 'unknown';
  if (!IP_RE.test(ip)) ip = 'unknown';
  return ip;
}

/** Async distributed rate-limit check. Returns a 429 / 414 response object, or
 *  null if allowed. Falls back transparently to `checkRateLimit` when the
 *  Blobs store is unavailable. */
export async function checkRateLimitDistributed(event, max = 60, windowMs = 60_000) {
  const qs = event.rawQuery || event.rawQueryString || '';
  if (typeof qs === 'string' && qs.length > MAX_QUERY_LENGTH) {
    return {
      statusCode: 414,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: 'Query string too long' }),
    };
  }

  const store = await getRateStore();
  if (!store) return checkRateLimit(event, max, windowMs);

  const ip = extractIp(event);
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `rl:${ip}:${windowStart}`;

  let entry = null;
  try {
    entry = await store.get(key, { type: 'json' });
  } catch {
    return checkRateLimit(event, max, windowMs);
  }

  const count = (entry?.count || 0) + 1;
  if (count > max) {
    return {
      statusCode: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(windowMs / 1000)),
        ...corsHeaders,
      },
      body: JSON.stringify({ error: 'Too many requests' }),
    };
  }
  try {
    await store.setJSON(key, { count, expiresAt: windowStart + windowMs * 2 });
  } catch { /* better to permit than to error out */ }
  return null;
}

/** Test seam: reset the cached Blobs store promise so tests can stub it. */
export function _resetStoreCache() { storePromise = null; }

// --- Surf-Tracker: rateLimit (per-name buckets, returns { ok, retryAfter }) ---

const buckets = new Map();
const MAX_KEYS = 5000;

/** Best client IP from a Netlify event: `x-nf-client-connection-ip` (the real
 *  client IP Netlify sets) → first `x-forwarded-for` hop → `client-ip` →
 *  `'unknown'`. */
export function clientIp(event) {
  const h = (event && event.headers) || {};
  const xff = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : '';
  return h['x-nf-client-connection-ip'] || xff || h['client-ip'] || 'unknown';
}

function pruneBuckets(now, windowMs) {
  for (const [k, b] of buckets) {
    if (now - b.windowStart >= windowMs) buckets.delete(k);
  }
  if (buckets.size > MAX_KEYS) buckets.clear();
}

/** Fixed-window check. Returns `{ ok: true }` under the limit, or
 *  `{ ok: false, retryAfter }` (seconds) once `max` is exceeded within
 *  `windowMs`. Fails open by construction. */
export function rateLimit(event, { name, windowMs, max }, now = Date.now()) {
  const key = `${name}:${clientIp(event)}`;
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    b = { windowStart: now, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > MAX_KEYS) pruneBuckets(now, windowMs);
  if (b.count > max) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.windowStart + windowMs - now) / 1000)) };
  }
  return { ok: true };
}

/** Test-only reset of the per-name bucket state. */
export function _resetRateLimit() { buckets.clear(); }

// ─────────────────────── handler factory ────────────────────────
//
// Wraps the cross-cutting concerns every function needs — CORS preflight,
// per-IP rate limiting, top-level try/catch + 500 fallback.

/** Build a Netlify function handler. Options:
 *   - `name`        — identifier used in the default error log.
 *   - `rateLimit`   — `{ max, windowMs }` (default 60 / 60 s); `null`/`false`
 *                     disables the limiter.
 *   - `distributed` — when true, uses the Blobs-backed limiter.
 *   - `handle`      — `async (event) => responseObject`. Required.
 *   - `onError`     — `async (error, event) => responseObject`. Optional. */
export function createHandler(options) {
  const {
    name = 'handler',
    rateLimit: rateLimitOpt = { max: 60, windowMs: 60_000 },
    distributed = false,
    handle,
    onError,
  } = options || {};

  if (typeof handle !== 'function') {
    throw new Error('createHandler: handle option is required');
  }

  const limiterEnabled = rateLimitOpt !== null && rateLimitOpt !== false;
  const limit = limiterEnabled
    ? (distributed
        ? (event) => checkRateLimitDistributed(event, rateLimitOpt.max, rateLimitOpt.windowMs)
        : (event) => checkRateLimit(event, rateLimitOpt.max, rateLimitOpt.windowMs))
    : null;

  return async (event, context) => {
    const preflight = handlePreflight(event);
    if (preflight) return preflight;

    if (limit) {
      const limited = await limit(event);
      if (limited) return limited;
    }

    try {
      return await handle(event, context);
    } catch (error) {
      if (onError) {
        try {
          return await onError(error, event);
        } catch (innerErr) {
          console.error(`${name} onError threw:`, errorMessage(innerErr));
        }
      }
      console.error(`${name} error:`, errorMessage(error));
      return errorResponse(500, 'Internal error');
    }
  };
}
