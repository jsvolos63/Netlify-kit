// @jfs/netlify-kit — shared serverless-function primitives for the JFS
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
// ONE fixed-window engine (per-name × per-IP buckets), exposed through the two
// calling conventions the family's apps already ship — the conventions are
// kept source-compatible, but they now share buckets, IP extraction, pruning,
// and the test seam instead of being two parallel limiters:
//   • checkRateLimit / checkRateLimitDistributed — return a ready-to-return
//     429 / 414 response object (or null). market-monitor's createHandler form.
//   • rateLimit — a low-level fixed-window check returning { ok, retryAfter },
//     letting a handler shape its own 429 (Surf-Tracker form).
// Both are best-effort, in-process (per warm instance); the distributed variant
// adds a Netlify Blobs bucket with transparent in-memory fallback.

const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,39}$/;
export const MAX_QUERY_LENGTH = 2048;

// --- shared engine: per-`${name}:${ip}` fixed-window buckets ---

const buckets = new Map();
const MAX_KEYS = 5000;

/** Validated client IP for bucketing: clientIp() → IP_RE check → 'unknown'.
 *  Anything unparseable collapses into the shared 'unknown' bucket (fail
 *  toward throttling rather than toward a bypass). */
function extractIp(event) {
  const ip = clientIp(event);
  return IP_RE.test(ip) ? ip : 'unknown';
}

function pruneBuckets(now, windowMs) {
  for (const [k, b] of buckets) {
    if (now - b.windowStart >= windowMs) buckets.delete(k);
  }
  if (buckets.size > MAX_KEYS) buckets.clear();
}

/** Core check. Returns { ok: true } or { ok: false, retryAfter } (seconds,
 *  time remaining in the caller's current window). */
function checkWindow(name, ip, max, windowMs, now) {
  const key = `${name}:${ip}`;
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

function queryTooLongResponse() {
  return {
    statusCode: 414,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    body: JSON.stringify({ error: 'Query string too long' }),
  };
}

function tooManyRequestsResponse(retryAfterSeconds) {
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
      ...corsHeaders,
    },
    body: JSON.stringify({ error: 'Too many requests' }),
  };
}

/** Returns a 429 / 414 response object if rate-limited or the query string is
 *  oversized, or null if allowed. The response already carries CORS headers.
 *  Retry-After reflects the actual time left in the window (previously the
 *  full window length). */
export function checkRateLimit(event, max = 60, windowMs = 60_000) {
  const qs = event.rawQuery || event.rawQueryString || '';
  if (typeof qs === 'string' && qs.length > MAX_QUERY_LENGTH) {
    return queryTooLongResponse();
  }
  const verdict = checkWindow('ip', extractIp(event), max, windowMs, Date.now());
  return verdict.ok ? null : tooManyRequestsResponse(verdict.retryAfter);
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

/** Async distributed rate-limit check. Returns a 429 / 414 response object, or
 *  null if allowed. Falls back transparently to `checkRateLimit` when the
 *  Blobs store is unavailable. */
export async function checkRateLimitDistributed(event, max = 60, windowMs = 60_000) {
  const qs = event.rawQuery || event.rawQueryString || '';
  if (typeof qs === 'string' && qs.length > MAX_QUERY_LENGTH) {
    return queryTooLongResponse();
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
    return tooManyRequestsResponse(Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)));
  }
  try {
    await store.setJSON(key, { count, expiresAt: windowStart + windowMs * 2 });
  } catch { /* better to permit than to error out */ }
  return null;
}

/** Test seam: reset the cached Blobs store promise so tests can stub it. */
export function _resetStoreCache() { storePromise = null; }

// --- Surf-Tracker form: rateLimit (per-name buckets, returns { ok, retryAfter }) ---

/** Best client IP from a Netlify event: `x-nf-client-connection-ip` (the real
 *  client IP Netlify sets) → first `x-forwarded-for` hop → `client-ip` →
 *  `'unknown'`. */
export function clientIp(event) {
  const h = (event && event.headers) || {};
  const xff = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : '';
  return h['x-nf-client-connection-ip'] || xff || h['client-ip'] || 'unknown';
}

/** Fixed-window check. Returns `{ ok: true }` under the limit, or
 *  `{ ok: false, retryAfter }` (seconds) once `max` is exceeded within
 *  `windowMs`. Fails open by construction. Shares the bucket store with
 *  checkRateLimit (namespaced by `name`, so counts never collide). */
export function rateLimit(event, { name, windowMs, max }, now = Date.now()) {
  return checkWindow(name, clientIp(event), max, windowMs, now);
}

/** Test-only reset of ALL in-memory limiter state (both calling forms —
 *  previously this cleared only the rateLimit buckets, leaving tests no way
 *  to reset checkRateLimit's counters). */
export function _resetRateLimit() { buckets.clear(); }

// ─────────────── Netlify Blobs: store opener + short-TTL cache ───────────────
//
// Generalized from FlightCheck's flightCache.js (short-TTL get/set with graceful
// degradation) and Surf-Tracker's blobs.js (explicit-credential store opener).
// Install-time dependency-free: @netlify/blobs is reached through the same
// dynamic import() as the distributed limiter, and every op degrades to a no-op
// (a null store reads as a miss) so a storage hiccup can never break a request.

/** Open a Blobs store, or null when Blobs isn't available (local dev, unit
 *  tests, or a deploy where the runtime context isn't discoverable — a known
 *  esbuild/@netlify/blobs interaction). Passes explicit credentials when BOTH a
 *  site ID and token resolve, which is what makes storage work on sites where
 *  the runtime auto-config isn't found; otherwise falls back to the plain
 *  runtime-configured getStore. Resolution (override per-call via opts):
 *    consistency — opts.consistency (default 'strong')
 *    siteID      — opts.siteID || BLOBS_SITE_ID / NETLIFY_SITE_ID / SITE_ID
 *    token       — opts.token  || BLOBS_TOKEN / NETLIFY_API_TOKEN / NETLIFY_AUTH_TOKEN
 *  Apps that bake in their own default site ID pass it as opts.siteID. */
export async function openStore(name, opts = {}) {
  let getStore;
  try {
    ({ getStore } = await import('@netlify/blobs'));
  } catch {
    return null;
  }
  const consistency = opts.consistency || 'strong';
  const siteID = opts.siteID || process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = opts.token || process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  const cfg = { name, consistency };
  if (siteID && token) { cfg.siteID = siteID; cfg.token = token; }
  try {
    return getStore(cfg);
  } catch {
    return null;
  }
}

/** Build a stable cache key by joining the distinguishing parts with '|'
 *  (nullish parts become ''). e.g. blobKey(flight, date) → "UA123|2026-07-01". */
export function blobKey(...parts) {
  return parts.map((p) => (p == null ? '' : String(p))).join('|');
}

/** Read a TTL-stamped entry written by setTTLCached. Returns the stored `data`
 *  when present and — if `ttlMs` is given — fresher than it; otherwise null. A
 *  null store, malformed entry, or transient read failure all resolve to null
 *  so the caller fetches live. Omit `ttlMs` to read without expiry.
 *
 *  Note: an entry cached with `data: undefined` serializes to `{ at }` (JSON
 *  drops undefined), so its data reads back as `undefined` — normalized to null
 *  here so a `=== null` miss check can't mistake it for a real hit. Falsy-but-
 *  real values (null, false, 0, '') round-trip intact. */
export async function getTTLCached(store, key, { ttlMs, now = Date.now() } = {}) {
  if (!store) return null;
  try {
    const entry = await store.get(key, { type: 'json' });
    if (!entry || typeof entry.at !== 'number') return null;
    if (ttlMs != null && now - entry.at > ttlMs) return null;
    return entry.data === undefined ? null : entry.data;
  } catch {
    return null;
  }
}

/** Write `data` under `key` with a `{ at }` write timestamp for getTTLCached.
 *  Best-effort: a null store or a failed write is swallowed and returns false —
 *  caching is an optimization, never a correctness requirement. Returns true on
 *  a successful write. */
export async function setTTLCached(store, key, data, { now = Date.now() } = {}) {
  if (!store) return false;
  try {
    await store.setJSON(key, { at: now, data });
    return true;
  } catch {
    return false;
  }
}

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

/* ═══════════════════════ Anthropic (Claude) client ═══════════════════════
 *
 * Hardened Messages-API call machinery, consolidated from the two hand-synced
 * copies in the family: Surf-Tracker's non-streaming client
 * (netlify/functions/lib/anthropic.js — summarize.js / summary-chat.js) and
 * market-monitor's streaming client (netlify/functions/utils/anthropic.mjs —
 * analyze.mjs / analysis-core.mjs). Both call sites keep their exact semantics;
 * only the import path changes.
 *
 * Shared hardening, both entry points:
 *   - one transient-error retry (429 / 529 / 5xx) before giving up,
 *   - host-tagged error messages that never leak the api key or the raw
 *     upstream body into a response (a 429 body carries the org id),
 *   - `.status` and `.retryAfter` tagged on the thrown error so callers can
 *     surface an honest "busy, try again in Ns" (see userFacingReason).
 *
 * Auth: x-api-key only, via raw fetch — deliberately NOT the Anthropic SDK.
 * The SDK's env-based auth resolution attached a conflicting Authorization
 * header inside Netlify Functions and 401'd; the raw x-api-key call
 * authenticates cleanly, and it keeps this kit dependency-free.
 */

export const ANTHROPIC_VERSION = '2023-06-01';

/** Default to Opus 4.8 — the most capable model — for the highest-quality
 *  output. Opus is slower and pricier than the small models, so callers pair
 *  it with an explicit `effort` (typically "low") to bound thinking/token
 *  spend under a synchronous Netlify function's ~26s budget. Override
 *  per-endpoint via an env var at the call site. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-8';
// Name used by the existing Surf-Tracker call sites, kept as an alias.
export const DEFAULT_MODEL = ANTHROPIC_DEFAULT_MODEL;

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Effort levels accepted by output_config.effort ("max" is Opus-tier only).
 *  Validates an env-configured effort before sending it. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export function normalizeEffort(value, def = 'low') {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return EFFORT_LEVELS.has(v) ? v : def;
}

const anthropicSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function anthropicBase(opts) {
  const base = (opts.baseUrl || process.env.ANTHROPIC_BASE_URL || ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  // Host we're actually calling — surfaced in errors so a hung request makes
  // it obvious whether we're hitting api.anthropic.com or a stray override.
  let host;
  try { host = new URL(base).host; } catch { host = base; }
  return { base, host };
}

function anthropicHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

// Tag the status (and Retry-After, if any) on the error so callers can render
// a clean, actionable message — and NOT leak the raw upstream body.
function tagUpstreamError(host, res, body) {
  const err = new Error(`${host} HTTP ${res.status}: ${String(body || '').slice(0, 200)}`);
  err.status = res.status;
  const retryAfter = res.headers && typeof res.headers.get === 'function'
    ? Number(res.headers.get('retry-after'))
    : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
  return err;
}

const isRetryableAnthropicStatus = (status) =>
  status === 429 || status === 529 || (status >= 500 && status < 600);

/**
 * Call the Messages API (non-streaming) and return the concatenated text
 * content. Throws on a non-2xx (after one transient retry while time remains
 * in `timeoutMs`) or a network/timeout failure, with a host-tagged message the
 * caller can surface in a degraded response.
 *
 * opts: { apiKey, model, system, userText, messages, maxTokens, timeoutMs,
 *         baseUrl, thinking, effort, fetchImpl }
 *   userText — convenience for a single-turn call (wrapped as one user message)
 *   messages — full Anthropic messages array for a multi-turn call; takes
 *              precedence over userText when present and non-empty
 *   system   — string or the array-with-cache_control form; passed through
 *   thinking — e.g. { type: "adaptive" }; omitted → model default
 *   effort   — "low".."max"; sent as output_config.effort to bound token spend
 *   fetchImpl — injectable for tests (default globalThis.fetch)
 */
export async function callAnthropic(opts) {
  const { apiKey, model, system, userText, messages, maxTokens, timeoutMs, thinking, effort } = opts;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const { base, host } = anthropicBase(opts);
  const payload = {
    model,
    max_tokens: maxTokens,
    system,
    messages: Array.isArray(messages) && messages.length
      ? messages
      : [{ role: 'user', content: userText }],
  };
  // Adaptive thinking keeps Opus's reasoning in (omitted) thinking blocks
  // rather than leaking into the visible output; effort caps how much of it
  // (and the overall token spend) happens, which is what keeps Opus inside a
  // synchronous function's time budget. Both are GA on the raw endpoint.
  if (thinking) payload.thinking = thinking;
  if (effort) payload.output_config = { effort };
  const reqBody = JSON.stringify(payload);
  const deadline = Date.now() + timeoutMs;

  // Up to two attempts: a transient 429/529/5xx (rate limit / overloaded) gets
  // one short retry while time remains, before we give up and let the caller
  // degrade.
  let res, lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = deadline - Date.now();
    if (budget <= 0) break;
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => { try { ctl.abort(); } catch { /* already settled */ } }, budget);
    try {
      res = await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        headers: anthropicHeaders(apiKey),
        body: reqBody,
        signal: ctl.signal,
      });
    } catch (e) {
      // Connect/TLS/abort failures. Report the host, how long it hung, and the
      // underlying cause so "aborted after ~timeout" (network/host unreachable)
      // is distinguishable from a fast failure (e.g. ENOTFOUND → wrong URL).
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      lastErr = new Error(
        `request to ${host} did not complete after ${Date.now() - started}ms ` +
        `(${(e && e.name) || 'Error'}${cause ? ': ' + cause : ''})`,
      );
      break; // a timeout/abort won't succeed on retry within the same budget
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) break;
    const body = await res.text().catch(() => '');
    lastErr = tagUpstreamError(host, res, body);
    const retryable = isRetryableAnthropicStatus(res.status);
    res = null;
    if (!retryable || attempt === 1 || deadline - Date.now() < 1500) break;
    await anthropicSleep(Math.min(1000, Math.max(0, deadline - Date.now() - 1000)));
  }
  if (!res) throw lastErr || new Error('model call failed');

  const data = await res.json();
  return Array.isArray(data.content)
    ? data.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('')
    : '';
}

/**
 * Issue a streaming Messages request, retrying once on a transient upstream
 * failure before any bytes are consumed. Resolves to the ok Response (with a
 * readable `.body`); throws a tagged Error otherwise.
 *
 * The retry only ever re-issues the initial POST. Once the upstream returns
 * 2xx with a readable body we hand that Response back and the caller consumes
 * the SSE — we never retry mid-stream. Bound the whole request (headers +
 * stream) by passing an AbortSignal (e.g. AbortSignal.timeout(...)).
 *
 * opts: { apiKey, model, system, messages, maxTokens, effort, thinking,
 *         signal, baseUrl, fetchImpl }
 */
export async function openAnthropicStream(opts) {
  const { apiKey, model, system, messages, maxTokens, effort, thinking, signal } = opts;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const { base, host } = anthropicBase(opts);

  const payload = { model, max_tokens: maxTokens, stream: true, system, messages };
  if (thinking) payload.thinking = thinking;
  if (effort) payload.output_config = { effort };
  const body = JSON.stringify(payload);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        headers: anthropicHeaders(apiKey),
        body,
        signal,
      });
    } catch (e) {
      // Connect / TLS / abort. An abort won't recover on retry.
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      lastErr = new Error(`request to ${host} failed (${(e && e.name) || 'Error'}${cause ? ': ' + cause : ''})`);
      if (e && e.name === 'AbortError') break;
      if (attempt === 0) { await anthropicSleep(500); continue; }
      break;
    }

    if (res.ok && res.body) return res;

    const detail = await res.text().catch(() => '');
    lastErr = tagUpstreamError(host, res, detail);
    if (!isRetryableAnthropicStatus(res.status) || attempt === 1) break;
    await anthropicSleep(600);
  }
  throw lastErr || new Error('model call failed');
}

/** Models occasionally wrap JSON in prose or fences despite instructions; pull
 *  out the first balanced JSON object and parse that. */
export function parseModelJson(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to brace extraction */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error('model did not return parseable JSON');
}

/** Normalize a model value into a clean array of bullet strings. Tolerates an
 *  array (the schema), a single string, or a newline/▪-delimited blob. Strips
 *  leading bullet glyphs and length-caps each (maxChars) so a runaway response
 *  can't bloat a cached blob or the UI. */
export function toBullets(v, maxChars) {
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/\r?\n+/);
  else return [];
  return arr
    .map((x) => String(x == null ? '' : x).replace(/^\s*[-•*\d.]+\s*/, '').trim().slice(0, maxChars))
    .filter(Boolean);
}

/** A clean, user-facing reason for a failed callAnthropic/openAnthropicStream,
 *  derived from the error's tagged status. A 429 (the org's tokens-per-minute
 *  cap, common on lower API tiers) gets a short "try again" message with the
 *  real Retry-After window when the upstream provided one — instead of the raw
 *  429 JSON, which carries the org id and is meaningless to the user.
 *  Everything else falls back to the bounded detail string the caller passes. */
export function userFacingReason(e, detail) {
  if (e && e.status === 429) {
    const wait = e.retryAfter ? `about ${e.retryAfter}s` : 'a minute';
    return `The AI service is busy right now (rate limit reached). Wait ${wait} and try again.`;
  }
  return detail;
}
