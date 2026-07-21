// Tests for @jfs/netlify-kit. Run with: node test.mjs  (or: npm test)
// Uses node:test (auto-runs, non-zero exit on failure) — no framework deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  corsHeaders,
  handlePreflight,
  preflightResponse,
  JSON_HEADERS,
  jsonResponse,
  errorResponse,
  textResponse,
  ok,
  badRequest,
  notFound,
  methodNotAllowed,
  serverError,
  badGateway,
  upstreamError,
  errorMessage,
  checkResponseSize,
  readTextCapped,
  MAX_RESPONSE_BYTES,
  SYMBOL_RE,
  FRED_ID_RE,
  UNIX_TS_RE,
  isValidDate,
  isValidTimestamp,
  parseSafeHttpsUrl,
  isSafeHttpsUrl,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateAddress,
  resolveHostIsPublic,
  safeFetch,
  fetchWithRetry,
  RETRYABLE_STATUSES,
  clientIp,
  checkRateLimit,
  checkRateLimitDistributed,
  _resetStoreCache,
  rateLimit,
  _resetRateLimit,
  MAX_QUERY_LENGTH,
  createHandler,
  openStore,
  blobKey,
  getTTLCached,
  setTTLCached,
  ANTHROPIC_VERSION,
  ANTHROPIC_DEFAULT_MODEL,
  DEFAULT_MODEL,
  normalizeEffort,
  callAnthropic,
  openAnthropicStream,
  parseModelJson,
  toBullets,
  userFacingReason,
} from './index.js';

// ───────────────────────── shared fakes ─────────────────────────

function headersOf(map) {
  return { get: (k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : null) };
}

function streamResponse(chunks, { contentLength } = {}) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    headers: headersOf(contentLength != null ? { 'content-length': String(contentLength) } : {}),
    body: {
      getReader() {
        return {
          read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }),
          cancel: async () => { i = chunks.length; },
        };
      },
    },
  };
}

function eventWith({ headers = {}, method, rawQuery } = {}) {
  return { httpMethod: method, headers, rawQuery };
}

// ───────────────────────────── CORS ─────────────────────────────

test('corsHeaders + JSON_HEADERS', () => {
  assert.equal(corsHeaders['Access-Control-Allow-Origin'], '*');
  assert.equal(corsHeaders['X-Content-Type-Options'], 'nosniff');
  assert.equal(JSON_HEADERS['Content-Type'], 'application/json');
  assert.equal(JSON_HEADERS['Access-Control-Allow-Origin'], '*');
});

test('handlePreflight: 204 only for OPTIONS', () => {
  assert.equal(handlePreflight(eventWith({ method: 'OPTIONS' })).statusCode, 204);
  assert.equal(handlePreflight(eventWith({ method: 'GET' })), null);
});

test('preflightResponse: advertises verbs', () => {
  const r = preflightResponse({ methods: 'GET, POST, OPTIONS' });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
  assert.equal(r.headers['access-control-max-age'], '86400');
});

// ─────────────────────────── responses ──────────────────────────

test('jsonResponse body-first (market-monitor form)', () => {
  const r = jsonResponse({ a: 1 }, 'no-store', { ETag: 'x' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.headers.ETag, 'x');
  assert.equal(r.body, '{"a":1}');
  // pre-serialised string passes through
  assert.equal(jsonResponse('{"raw":true}').body, '{"raw":true}');
});

test('jsonResponse status-first (Surf-Tracker form)', () => {
  const r = jsonResponse(404, { error: 'nope' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.equal(r.body, '{"error":"nope"}');
  const custom = jsonResponse(200, { ok: 1 }, { cacheControl: 'max-age=60', headers: { 'x-h': '1' } });
  assert.equal(custom.headers['cache-control'], 'max-age=60');
  assert.equal(custom.headers['x-h'], '1');
});

test('errorResponse: { error } body + extraHeaders', () => {
  const r = errorResponse(400, 'Missing symbol', { 'Retry-After': '5' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.headers['Retry-After'], '5');
  assert.deepEqual(JSON.parse(r.body), { error: 'Missing symbol' });
});

test('textResponse: text content-type, optional cache-control', () => {
  const r = textResponse(200, 'hello');
  assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  assert.ok(!('cache-control' in r.headers));
  assert.equal(r.body, 'hello');
  assert.equal(textResponse(204, null).body, '');
  assert.equal(textResponse(200, 'x', { cacheControl: 'no-store' }).headers['cache-control'], 'no-store');
});

test('response sugar (FlightCheck form)', () => {
  assert.equal(ok({ a: 1 }).statusCode, 200);
  assert.equal(ok({ a: 1 }).headers['Access-Control-Allow-Origin'], '*');
  assert.equal(badRequest('x').statusCode, 400);
  assert.equal(notFound('x').statusCode, 404);
  assert.equal(methodNotAllowed().statusCode, 405);
  assert.deepEqual(JSON.parse(methodNotAllowed().body), { error: 'Method not allowed.' });
  assert.equal(serverError('x').statusCode, 500);
  assert.equal(badGateway('x').statusCode, 502);
  // upstreamError clamps out-of-range status and forwards extra headers
  assert.equal(upstreamError(200, 'x').statusCode, 502);
  assert.equal(upstreamError(503, 'x').statusCode, 503);
  assert.equal(upstreamError(429, 'busy', { 'Retry-After': '30' }).headers['Retry-After'], '30');
});

test('errorMessage: bounded stringification', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(new Error('x'.repeat(500)), 10).length, 10);
});

test('checkResponseSize: 502 over cap, null otherwise', () => {
  const over = checkResponseSize({ headers: headersOf({ 'content-length': String(MAX_RESPONSE_BYTES + 1) }) });
  assert.equal(over.statusCode, 502);
  assert.equal(checkResponseSize({ headers: headersOf({ 'content-length': '100' }) }), null);
  assert.equal(checkResponseSize({ headers: headersOf({}) }), null);
});

test('readTextCapped: returns under cap, throws .tooLarge over', async () => {
  assert.equal(await readTextCapped(streamResponse(['ab', 'cd']), 100), 'abcd');
  await assert.rejects(() => readTextCapped(streamResponse(['aaaa', 'bbbb', 'cccc']), 6), (e) => e.tooLarge === true);
  await assert.rejects(() => readTextCapped(streamResponse(['x'], { contentLength: 1000 }), 10), (e) => e.tooLarge === true);
  // no readable stream → text() fallback, still guarded
  assert.equal(await readTextCapped({ headers: headersOf({}), text: async () => 'plain' }, 100), 'plain');
  await assert.rejects(() => readTextCapped({ headers: headersOf({}), text: async () => 'x'.repeat(50) }, 10), (e) => e.tooLarge === true);
});

// ────────────────────────── validation ──────────────────────────

test('symbol / fred / timestamp regexes', () => {
  for (const s of ['AAPL', 'BINANCE:BTCUSDT', 'BTC/USD', '^GSPC', '000001.SS']) assert.ok(SYMBOL_RE.test(s), s);
  for (const s of ['a', 'TOO$BAD', 'X'.repeat(21)]) assert.ok(!SYMBOL_RE.test(s), s);
  assert.ok(FRED_ID_RE.test('DGS10'));
  assert.ok(!FRED_ID_RE.test('dgs-10'));
  assert.ok(UNIX_TS_RE.test('1700000000'));
  assert.ok(!UNIX_TS_RE.test('17000000000000'));
});

test('isValidDate / isValidTimestamp', () => {
  assert.ok(isValidDate('2024-02-29'));
  assert.ok(!isValidDate('2023-02-29'));
  assert.ok(!isValidDate('2024-13-01'));
  assert.ok(!isValidDate('2024-2-1'));
  assert.ok(isValidTimestamp('0'));
  assert.ok(isValidTimestamp(String(Math.floor(Date.now() / 1000))));
  assert.ok(!isValidTimestamp(String(Math.floor(Date.now() / 1000) + 100000)));
  assert.ok(!isValidTimestamp('abc'));
});

// ──────────────────────────── SSRF ──────────────────────────────

test('parseSafeHttpsUrl: accepts public https, rejects the rest', () => {
  assert.ok(parseSafeHttpsUrl('https://example.com/a').ok);
  assert.equal(parseSafeHttpsUrl('http://example.com').error, 'not-https');
  assert.equal(parseSafeHttpsUrl('https://example.com:8443').error, 'bad-port');
  assert.equal(parseSafeHttpsUrl('https://u:p@example.com').error, 'has-credentials');
  assert.equal(parseSafeHttpsUrl('https://127.0.0.1').error, 'disallowed-host');
  assert.equal(parseSafeHttpsUrl('https://localhost').error, 'disallowed-host');
  assert.equal(parseSafeHttpsUrl('https://foo.internal').error, 'disallowed-host');
  assert.equal(parseSafeHttpsUrl('not a url').error, 'invalid-url');
  assert.ok(!isSafeHttpsUrl('http://example.com'));
  assert.ok(isSafeHttpsUrl('https://example.com'));
});

test('parseSafeHttpsUrl: trailing-dot hosts and non-dotted-decimal IP encodings are rejected', () => {
  // A single trailing dot (the DNS root) must not slip past the localhost /
  // internal-suffix checks.
  assert.equal(parseSafeHttpsUrl('https://localhost./').error, 'disallowed-host');
  assert.equal(parseSafeHttpsUrl('https://foo.internal./').error, 'disallowed-host');
  assert.equal(parseSafeHttpsUrl('https://bar.local./').error, 'disallowed-host');
  assert.equal(parseSafeHttpsUrl('https://baz.lan./').error, 'disallowed-host');
  // Non-dotted-decimal IPv4 encodings that resolvers accept as 127.0.0.1.
  assert.equal(parseSafeHttpsUrl('https://2130706433/').error, 'disallowed-host'); // decimal
  assert.equal(parseSafeHttpsUrl('https://0x7f000001/').error, 'disallowed-host'); // hex
  assert.equal(parseSafeHttpsUrl('https://0177.0.0.1/').error, 'disallowed-host'); // octal
  // A trailing dot on a real public host is still fine.
  assert.ok(parseSafeHttpsUrl('https://example.com./').ok);
});

test('private IP helpers', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.5.5', '100.64.0.1'])
    assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) assert.ok(!isPrivateIPv4(ip), ip);
  assert.ok(isPrivateIPv4('999.999.999.999'));
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', 'ff02::1']) assert.ok(isPrivateIPv6(ip), ip);
  assert.ok(!isPrivateIPv6('2606:4700:4700::1111'));
  assert.ok(isPrivateAddress('10.0.0.1', 4));
  assert.ok(isPrivateAddress('::1', 6));
  assert.ok(!isPrivateAddress('8.8.8.8', 4));
});

test('resolveHostIsPublic: localhost is private (fail closed)', async () => {
  const r = await resolveHostIsPublic('localhost');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'private-ip');
});

// safeFetch is exercised against a local http.createServer. Production always
// speaks HTTPS to a vetted public IP; the `_validate` / `_resolve` seams let the
// test permit its own loopback origin while REDIRECT targets still go through
// the real parseSafeHttpsUrl + a private-IP-aware resolver, proving each hop is
// re-vetted.
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  // Permit the test's own origin; defer to the real HTTPS guard for anything
  // else (i.e. redirect Locations).
  const _validate = (u) => {
    const url = new URL(u);
    return url.origin === origin ? { ok: true, url, error: null } : parseSafeHttpsUrl(u);
  };
  // Loopback for our server host; a private verdict for the rebind bait host.
  const _resolve = async (host) => {
    if (host === '127.0.0.1') return { ok: true, address: '127.0.0.1', family: 4 };
    if (host === 'private.example') return { ok: false, error: 'private-ip' };
    return { ok: false, error: 'dns-failed' };
  };
  try {
    return await run({ origin, _validate, _resolve });
  } finally {
    server.close();
  }
}

test('safeFetch: a normal 200 succeeds and returns a Response-like object', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello-body');
    },
    async ({ origin, _validate, _resolve }) => {
      const r = await safeFetch(`${origin}/ok`, { _validate, _resolve });
      assert.equal(r.ok, true);
      assert.equal(r.status, 200);
      assert.equal(await r.text(), 'hello-body');
      assert.equal(r.headers.get('content-type'), 'text/plain');
      assert.equal(r.url, `${origin}/ok`);
    },
  );
});

test('safeFetch: a redirect to http:// is rejected (no downgrade)', async () => {
  await withServer(
    (req, res) => { res.writeHead(302, { location: 'http://127.0.0.1/' }); res.end(); },
    async ({ origin, _validate, _resolve }) => {
      await assert.rejects(
        safeFetch(`${origin}/red`, { _validate, _resolve }),
        (e) => /blocked-url:not-https/.test(e.message),
      );
    },
  );
});

test('safeFetch: a redirect to a private host is re-vetted and rejected', async () => {
  await withServer(
    (req, res) => { res.writeHead(302, { location: 'https://private.example/' }); res.end(); },
    async ({ origin, _validate, _resolve }) => {
      await assert.rejects(
        safeFetch(`${origin}/red`, { _validate, _resolve }),
        (e) => /blocked-host:private-ip/.test(e.message),
      );
    },
  );
});

test('safeFetch: the redirect hop cap is enforced', async () => {
  await withServer(
    (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
    async ({ origin, _validate, _resolve }) => {
      await assert.rejects(
        safeFetch(`${origin}/loop`, { _validate, _resolve, maxRedirects: 3 }),
        (e) => /too-many-redirects/.test(e.message),
      );
    },
  );
});

test('safeFetch: a hung DNS resolve is bounded by the deadline', async () => {
  // A _resolve that never settles must not hang safeFetch past timeoutMs.
  const hang = () => new Promise(() => {});
  const _validate = (u) => ({ ok: true, url: new URL(u), error: null });
  const start = Date.now();
  await assert.rejects(
    safeFetch('https://slow.example/x', { _validate, _resolve: hang, timeoutMs: 60 }),
    (e) => /timeout/.test(e.message),
  );
  assert.ok(Date.now() - start < 2000, 'rejected promptly rather than hanging');
});

// ──────────────────────────── retry ─────────────────────────────

const noSleep = async () => {};

test('fetchWithRetry: retries 503 then succeeds', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return n < 3 ? { status: 503, body: { cancel: async () => {} } } : { status: 200 }; };
  const r = await fetchWithRetry('u', {}, { fetchFn, sleepFn: noSleep, retries: 3 });
  assert.equal(r.status, 200);
  assert.equal(n, 3);
});

test('fetchWithRetry: no retry on 400; 429 opt-in; network retried; AbortError not', async () => {
  let n = 0;
  await fetchWithRetry('u', {}, { fetchFn: async () => { n++; return { status: 400 }; }, sleepFn: noSleep });
  assert.equal(n, 1);

  const mk429 = async () => { n++; return { status: 429, body: { cancel: async () => {} } }; };
  n = 0; await fetchWithRetry('u', {}, { fetchFn: mk429, sleepFn: noSleep, retries: 1 });
  assert.equal(n, 1);
  n = 0; await fetchWithRetry('u', {}, { fetchFn: mk429, sleepFn: noSleep, retries: 1, retryOn429: true });
  assert.equal(n, 2);

  n = 0;
  await assert.rejects(() => fetchWithRetry('u', {}, { fetchFn: async () => { n++; throw new Error('ECONNRESET'); }, sleepFn: noSleep, retries: 2 }));
  assert.equal(n, 3);

  n = 0;
  await assert.rejects(() => fetchWithRetry('u', {}, { fetchFn: async () => { n++; const e = new Error('a'); e.name = 'AbortError'; throw e; }, sleepFn: noSleep, retries: 3 }));
  assert.equal(n, 1);

  assert.ok(RETRYABLE_STATUSES.has(503) && !RETRYABLE_STATUSES.has(500));
});

// ──────────────────────── rate limiting ─────────────────────────

test('clientIp: precedence', () => {
  assert.equal(clientIp(eventWith({ headers: { 'x-nf-client-connection-ip': '1.2.3.4' } })), '1.2.3.4');
  assert.equal(clientIp(eventWith({ headers: { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' } })), '5.6.7.8');
  assert.equal(clientIp(eventWith({ headers: { 'client-ip': '10.0.0.9' } })), '10.0.0.9');
  assert.equal(clientIp(eventWith({})), 'unknown');
});

test('checkRateLimit: 429 + Retry-After; 414 oversized query', () => {
  const ev = eventWith({ headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(checkRateLimit(ev, 1, 60_000), null);
  const blocked = checkRateLimit(ev, 1, 60_000);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.equal(blocked.headers['Access-Control-Allow-Origin'], '*');
  const long = checkRateLimit(eventWith({ headers: {}, rawQuery: 'x'.repeat(MAX_QUERY_LENGTH + 1) }), 60, 60_000);
  assert.equal(long.statusCode, 414);
});

test('checkRateLimitDistributed: degrades to in-memory without blobs', async () => {
  _resetStoreCache();
  const ev = eventWith({ headers: { 'x-forwarded-for': '4.4.4.4' } });
  assert.equal(await checkRateLimitDistributed(ev, 1, 60_000), null);
  const blocked = await checkRateLimitDistributed(ev, 1, 60_000);
  assert.equal(blocked.statusCode, 429);
});

// Blobs-shaped mock with etag/CAS semantics + a knob to force the first N
// conditional writes to lose the race (simulating a concurrent writer).
function casStore({ conflicts = 0 } = {}) {
  const m = new Map();
  const tags = new Map();
  let remaining = conflicts;
  let ver = 0;
  const deletes = [];
  return {
    getWithMetadata: async (k) => (m.has(k)
      ? { data: m.get(k), etag: tags.get(k) }
      : { data: null, etag: null }),
    setJSON: async (k, v, o = {}) => {
      if (remaining > 0) { remaining -= 1; return { modified: false }; } // lost CAS
      if (o.onlyIfNew && m.has(k)) return { modified: false };
      if (o.onlyIfMatch && o.onlyIfMatch !== (tags.get(k) || null)) return { modified: false };
      ver += 1;
      const et = `e${ver}`;
      m.set(k, JSON.parse(JSON.stringify(v)));
      tags.set(k, et);
      return { modified: true, etag: et };
    },
    delete: async (k) => { deletes.push(k); m.delete(k); tags.delete(k); },
    _map: m,
    _deletes: deletes,
  };
}

test('checkRateLimitDistributed (CAS): counts, denies over max, prunes the prior window', async () => {
  const store = casStore();
  const ev = eventWith({ headers: { 'x-forwarded-for': '8.8.8.8' } });
  // Pre-seed a prior-window key so we can prove it gets pruned on a successful write.
  const now = Date.now();
  const windowMs = 60_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  store._map.set(`rl:8.8.8.8:${windowStart - windowMs}`, { count: 9 });

  assert.equal(await checkRateLimitDistributed(ev, 2, windowMs, { store }), null); // 1
  assert.ok(store._deletes.includes(`rl:8.8.8.8:${windowStart - windowMs}`), 'prior window pruned');
  assert.equal(await checkRateLimitDistributed(ev, 2, windowMs, { store }), null); // 2
  const blocked = await checkRateLimitDistributed(ev, 2, windowMs, { store });     // 3 > 2
  assert.equal(blocked.statusCode, 429);
});

test('checkRateLimitDistributed (CAS): retries a conflicting write, then succeeds', async () => {
  const store = casStore({ conflicts: 1 }); // first write loses, retry wins
  const ev = eventWith({ headers: { 'x-forwarded-for': '8.8.4.4' } });
  assert.equal(await checkRateLimitDistributed(ev, 5, 60_000, { store, retries: 3 }), null);
});

test('checkRateLimitDistributed (CAS): exhausted conflicts fail closed (deny)', async () => {
  const store = casStore({ conflicts: 99 }); // every write loses
  const ev = eventWith({ headers: { 'x-forwarded-for': '8.8.1.1' } });
  const r = await checkRateLimitDistributed(ev, 100, 60_000, { store, retries: 2 });
  assert.equal(r.statusCode, 429); // fail-closed, not silently permitted
});

test('checkRateLimitDistributed: read error falls back by default, denies when failClosed', async () => {
  const boom = { getWithMetadata: async () => { throw new Error('blobs down'); } };
  const ev = eventWith({ headers: { 'x-forwarded-for': '8.8.2.2' } });
  // Default: fall back to the in-memory limiter (permits the first hit).
  assert.equal(await checkRateLimitDistributed(ev, 1, 60_000, { store: boom }), null);
  // failClosed: deny on the read error instead of falling back.
  const r = await checkRateLimitDistributed(ev, 1, 60_000, { store: boom, failClosed: true });
  assert.equal(r.statusCode, 429);
});

test('rateLimit (Surf form): { ok, retryAfter } with injected clock', () => {
  _resetRateLimit();
  const ev = eventWith({ headers: { 'x-nf-client-connection-ip': '7.7.7.7' } });
  assert.deepEqual(rateLimit(ev, { name: 'feed', windowMs: 1000, max: 2 }, 0), { ok: true });
  assert.deepEqual(rateLimit(ev, { name: 'feed', windowMs: 1000, max: 2 }, 100), { ok: true });
  const blocked = rateLimit(ev, { name: 'feed', windowMs: 1000, max: 2 }, 200);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter >= 1);
  assert.equal(rateLimit(ev, { name: 'feed', windowMs: 1000, max: 2 }, 1500).ok, true); // new window
  // distinct names keep distinct buckets
  assert.equal(rateLimit(ev, { name: 'list', windowMs: 1000, max: 1 }, 200).ok, true);
});

test('unified engine: _resetRateLimit clears BOTH calling forms', () => {
  _resetRateLimit();
  const ev = eventWith({ headers: { 'x-forwarded-for': '2.2.2.2' } });
  assert.equal(checkRateLimit(ev, 1, 60_000), null);
  assert.equal(checkRateLimit(ev, 1, 60_000).statusCode, 429);
  _resetRateLimit(); // previously only reset the Surf-form buckets
  assert.equal(checkRateLimit(ev, 1, 60_000), null);
});

test('unified engine: the two forms share IP extraction but not buckets', () => {
  _resetRateLimit();
  // checkRateLimit now sees x-nf-client-connection-ip (the real client IP
  // Netlify sets), like clientIp always did.
  const ev = eventWith({ headers: { 'x-nf-client-connection-ip': '3.3.3.3' } });
  assert.equal(checkRateLimit(ev, 1, 60_000), null);
  assert.equal(checkRateLimit(ev, 1, 60_000).statusCode, 429);
  // Same IP through the Surf form uses its own named bucket — no collision
  // with checkRateLimit's 'ip' namespace.
  assert.equal(rateLimit(ev, { name: 'feed', windowMs: 60_000, max: 1 }, Date.now()).ok, true);
});

test('checkRateLimit: Retry-After reflects time left in the window', () => {
  _resetRateLimit();
  const ev = eventWith({ headers: { 'x-forwarded-for': '6.6.6.6' } });
  assert.equal(checkRateLimit(ev, 1, 10_000), null);
  const blocked = checkRateLimit(ev, 1, 10_000);
  const retryAfter = Number(blocked.headers['Retry-After']);
  assert.ok(retryAfter >= 1 && retryAfter <= 10, `Retry-After ${retryAfter} within window`);
});

test('limiter: a cardinality flood evicts idle keys via LRU, never wipes an active counter', () => {
  _resetRateLimit();
  const W = 60_000, name = 'ep', max = 3;
  const flood = (n, t, base) => {
    for (let i = 0; i < n; i++) {
      const ip = `${base}.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      rateLimit(eventWith({ headers: { 'x-nf-client-connection-ip': ip } }), { name, windowMs: W, max }, t);
    }
  };
  const active = eventWith({ headers: { 'x-nf-client-connection-ip': '9.9.9.9' } });
  // Background flood populates the map with many now-idle keys at t.
  flood(5100, 1_000_000, '10');
  // The active client burns its budget slightly later — now the MRU entries.
  for (let k = 0; k < max; k++) assert.equal(rateLimit(active, { name, windowMs: W, max }, 1_000_001).ok, true);
  assert.equal(rateLimit(active, { name, windowMs: W, max }, 1_000_001).ok, false); // limited
  // A second wave forces eviction: LRU drops the idle t-flood, NOT the active
  // client (pre-fix, buckets.clear() would have reset it to a fresh window).
  flood(300, 1_000_002, '11');
  assert.equal(rateLimit(active, { name, windowMs: W, max }, 1_000_003).ok, false, 'active client stays limited across the flood');
});

test('rateLimit validates the IP (no junk-header bucket minting / poisoning)', () => {
  _resetRateLimit();
  // No x-nf-client-connection-ip → falls back to the client-controlled header.
  // A junk value must collapse to the shared "unknown" bucket, not mint its own.
  const junkA = eventWith({ headers: { 'x-forwarded-for': 'not-an-ip-<script>' } });
  const junkB = eventWith({ headers: { 'x-forwarded-for': 'also~garbage' } });
  assert.equal(rateLimit(junkA, { name: 'feed', windowMs: 60_000, max: 1 }, 1).ok, true);
  // Different junk header, SAME 'unknown' bucket → second call is over the max.
  assert.equal(rateLimit(junkB, { name: 'feed', windowMs: 60_000, max: 1 }, 2).ok, false);
});

// ─────────────────────── handler factory ────────────────────────

test('createHandler: preflight, happy path, rate limit, error → 500, onError', async () => {
  const pf = await createHandler({ handle: async () => ok({}) })(eventWith({ method: 'OPTIONS' }));
  assert.equal(pf.statusCode, 204);

  const happy = createHandler({ rateLimit: null, handle: async (event, ctx) => jsonResponse({ q: event.q, c: ctx }) });
  assert.deepEqual(JSON.parse((await happy({ q: 'AAPL' }, { fn: 1 })).body), { q: 'AAPL', c: { fn: 1 } });

  const limited = createHandler({ rateLimit: { max: 1, windowMs: 60_000 }, handle: async () => ok({}) });
  const ev = eventWith({ headers: { 'x-forwarded-for': '2.3.4.5' } });
  assert.equal((await limited(ev)).statusCode, 200);
  assert.equal((await limited(ev)).statusCode, 429);

  const thrower = createHandler({ rateLimit: null, handle: async () => { throw new Error('boom'); } });
  const r = await thrower(eventWith({}));
  assert.equal(r.statusCode, 500);
  assert.deepEqual(JSON.parse(r.body), { error: 'Internal error' });

  const custom = createHandler({ rateLimit: null, handle: async () => { throw new Error('x'); }, onError: async () => errorResponse(503, 'Down') });
  assert.equal((await custom(eventWith({}))).statusCode, 503);

  assert.throws(() => createHandler({}), /handle option is required/);
});

// ─────────────── Netlify Blobs: store opener + short-TTL cache ───────────────

// In-memory fake matching the { get(key,{type:'json'}), setJSON(key,val) } shape.
function fakeStore() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    // Round-trip through JSON like the real Blobs store does, so undefined
    // values are dropped exactly as they would be in production.
    setJSON: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); },
    _map: m,
  };
}

test('blobKey: joins parts with | and blanks nullish', () => {
  assert.equal(blobKey('UA123', '2026-07-01'), 'UA123|2026-07-01');
  assert.equal(blobKey('UA123', null, undefined, 'x'), 'UA123|||x');
  assert.equal(blobKey(), '');
});

test('setTTLCached / getTTLCached: round-trip, TTL expiry, and null-store no-op', async () => {
  const store = fakeStore();

  // Write stamps { at, data }; read returns data within the TTL.
  assert.equal(await setTTLCached(store, 'k', { v: 1 }, { now: 1000 }), true);
  assert.deepEqual(store._map.get('k'), { at: 1000, data: { v: 1 } });
  assert.deepEqual(await getTTLCached(store, 'k', { ttlMs: 45_000, now: 1000 }), { v: 1 });

  // Fresh enough vs. stale past the TTL.
  assert.deepEqual(await getTTLCached(store, 'k', { ttlMs: 45_000, now: 45_000 }), { v: 1 });
  assert.equal(await getTTLCached(store, 'k', { ttlMs: 45_000, now: 46_001 }), null);

  // No ttlMs → no expiry.
  assert.deepEqual(await getTTLCached(store, 'k', { now: 10_000_000 }), { v: 1 });

  // Missing key → null.
  assert.equal(await getTTLCached(store, 'absent', { ttlMs: 1000 }), null);

  // A null store (Blobs unavailable) is a graceful no-op, never a throw.
  assert.equal(await getTTLCached(null, 'k', { ttlMs: 1000 }), null);
  assert.equal(await setTTLCached(null, 'k', { v: 2 }), false);
});

test('getTTLCached: undefined data reads back as null; falsy-but-real values round-trip', async () => {
  const store = fakeStore();

  // undefined data → JSON drops it → the entry is content-less. It must read as
  // null (a miss), never undefined, so a `=== null` check can't mistake it.
  await setTTLCached(store, 'u', undefined, { now: 1000 });
  assert.deepEqual(store._map.get('u'), { at: 1000 }); // data key dropped by JSON
  assert.equal(await getTTLCached(store, 'u', { ttlMs: 45_000, now: 1000 }), null);

  // Genuine falsy values are real hits and must survive intact.
  for (const [key, val] of [['n', null], ['f', false], ['z', 0], ['e', '']]) {
    await setTTLCached(store, key, val, { now: 1000 });
    assert.strictEqual(await getTTLCached(store, key, { ttlMs: 45_000, now: 1000 }), val);
  }
});

test('getTTLCached: malformed entry and read failure resolve to null', async () => {
  const noStamp = { get: async () => ({ data: { v: 1 } }), setJSON: async () => {} }; // missing .at
  assert.equal(await getTTLCached(noStamp, 'k', { ttlMs: 1000 }), null);

  const boom = { get: async () => { throw new Error('blobs down'); }, setJSON: async () => {} };
  assert.equal(await getTTLCached(boom, 'k', { ttlMs: 1000 }), null);

  const failWrite = { setJSON: async () => { throw new Error('blobs down'); } };
  assert.equal(await setTTLCached(failWrite, 'k', { v: 1 }), false);
});

test('openStore: returns null when @netlify/blobs is unavailable (install-time dependency-free)', async () => {
  // The kit doesn't depend on @netlify/blobs, so the dynamic import fails here
  // and openStore degrades to null rather than throwing.
  assert.equal(await openStore('any-store'), null);
});

// ───────────────────────── Anthropic (Claude) client ─────────────────────────

// A minimal Response-shaped fake. `headers.get` is case-insensitive like the
// real Headers; `json`/`text`/`body` cover both entry points.
function fakeAnthropicResponse({ ok = true, status = 200, headers = {}, jsonBody, textBody = '', withBody = false } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    json: async () => jsonBody,
    text: async () => textBody,
    body: withBody ? {} : null,
  };
}

const textContent = (...texts) => ({
  content: texts.map((t) => ({ type: 'text', text: t })),
});

test('model constants: Opus 4.8 default, DEFAULT_MODEL alias, version header', () => {
  assert.equal(ANTHROPIC_DEFAULT_MODEL, 'claude-opus-4-8');
  assert.equal(DEFAULT_MODEL, ANTHROPIC_DEFAULT_MODEL);
  assert.equal(ANTHROPIC_VERSION, '2023-06-01');
});

test('normalizeEffort: accepts the five levels, trims/lowers, falls back', () => {
  for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeEffort(lvl), lvl);
  }
  assert.equal(normalizeEffort(' HIGH '), 'high');
  assert.equal(normalizeEffort('turbo'), 'low'); // default def
  assert.equal(normalizeEffort(undefined, 'medium'), 'medium');
  assert.equal(normalizeEffort('', 'high'), 'high');
});

test('callAnthropic: concatenates text blocks; sends headers, payload, effort, thinking', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return fakeAnthropicResponse({ jsonBody: textContent('Hello, ', 'world') });
  };
  const out = await callAnthropic({
    apiKey: 'sk-test',
    model: 'claude-opus-4-8',
    system: 'be brief',
    userText: 'hi',
    maxTokens: 100,
    timeoutMs: 2000,
    thinking: { type: 'adaptive' },
    effort: 'low',
    fetchImpl,
  });
  assert.equal(out, 'Hello, world');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /https:\/\/api\.anthropic\.com\/v1\/messages$/);
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
  assert.equal(calls[0].init.headers['anthropic-version'], ANTHROPIC_VERSION);
  const payload = JSON.parse(calls[0].init.body);
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(payload.thinking, { type: 'adaptive' });
  assert.deepEqual(payload.output_config, { effort: 'low' });
  assert.equal(payload.stream, undefined); // non-streaming entry point
});

test('callAnthropic: a full messages array takes precedence over userText', async () => {
  let payload;
  const fetchImpl = async (url, init) => {
    payload = JSON.parse(init.body);
    return fakeAnthropicResponse({ jsonBody: textContent('ok') });
  };
  const messages = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];
  await callAnthropic({ apiKey: 'k', model: 'm', userText: 'ignored', messages, maxTokens: 10, timeoutMs: 2000, fetchImpl });
  assert.deepEqual(payload.messages, messages);
});

test('callAnthropic: retries once on 429 and tags status + retryAfter on final failure', async () => {
  // 429 twice → both attempts consumed → throws with tagged status/retryAfter.
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return fakeAnthropicResponse({ ok: false, status: 429, headers: { 'retry-after': '7' }, textBody: '{"error":"rate"}' });
  };
  await assert.rejects(
    callAnthropic({ apiKey: 'k', model: 'm', userText: 'x', maxTokens: 10, timeoutMs: 10_000, fetchImpl }),
    (e) => e.status === 429 && e.retryAfter === 7 && /HTTP 429/.test(e.message),
  );
  assert.equal(attempts, 2);
});

test('callAnthropic: 429 then success → returns the retried result', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) return fakeAnthropicResponse({ ok: false, status: 529, textBody: 'overloaded' });
    return fakeAnthropicResponse({ jsonBody: textContent('recovered') });
  };
  const out = await callAnthropic({ apiKey: 'k', model: 'm', userText: 'x', maxTokens: 10, timeoutMs: 10_000, fetchImpl });
  assert.equal(out, 'recovered');
  assert.equal(attempts, 2);
});

test('callAnthropic: non-retryable 400 fails after a single attempt', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return fakeAnthropicResponse({ ok: false, status: 400, textBody: 'bad request' });
  };
  await assert.rejects(
    callAnthropic({ apiKey: 'k', model: 'm', userText: 'x', maxTokens: 10, timeoutMs: 10_000, fetchImpl }),
    (e) => e.status === 400,
  );
  assert.equal(attempts, 1);
});

test('callAnthropic: connect failure reports the host and does not leak the key', async () => {
  const fetchImpl = async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ENOTFOUND' };
    throw err;
  };
  await assert.rejects(
    callAnthropic({ apiKey: 'sk-secret', model: 'm', userText: 'x', maxTokens: 10, timeoutMs: 500, fetchImpl }),
    (e) => /api\.anthropic\.com/.test(e.message) && /ENOTFOUND/.test(e.message) && !e.message.includes('sk-secret'),
  );
});

test('callAnthropic: upstream error message is capped and never carries the key', async () => {
  const fetchImpl = async () =>
    fakeAnthropicResponse({ ok: false, status: 500, textBody: 'x'.repeat(1000) });
  await assert.rejects(
    callAnthropic({ apiKey: 'sk-secret', model: 'm', userText: 'x', maxTokens: 10, timeoutMs: 1400, fetchImpl }),
    (e) => e.message.length < 300 && !e.message.includes('sk-secret'),
  );
});

test('callAnthropic: baseUrl override is used and surfaced in errors', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/proxy\.example\.com\/v1\/messages$/);
    return fakeAnthropicResponse({ ok: false, status: 503, textBody: 'down' });
  };
  await assert.rejects(
    callAnthropic({ apiKey: 'k', model: 'm', userText: 'x', maxTokens: 10, timeoutMs: 1400, baseUrl: 'https://proxy.example.com/', fetchImpl }),
    (e) => /proxy\.example\.com HTTP 503/.test(e.message),
  );
});

test('openAnthropicStream: returns the ok Response with a readable body; stream:true in payload', async () => {
  let payload;
  const fetchImpl = async (url, init) => {
    payload = JSON.parse(init.body);
    return fakeAnthropicResponse({ withBody: true });
  };
  const res = await openAnthropicStream({
    apiKey: 'k', model: 'claude-sonnet-4-6', system: 's',
    messages: [{ role: 'user', content: 'x' }], maxTokens: 50, fetchImpl,
  });
  assert.ok(res.ok && res.body);
  assert.equal(payload.stream, true);
});

test('openAnthropicStream: retries once on transient 5xx, then succeeds', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) return fakeAnthropicResponse({ ok: false, status: 503, textBody: 'down' });
    return fakeAnthropicResponse({ withBody: true });
  };
  const res = await openAnthropicStream({ apiKey: 'k', model: 'm', messages: [], maxTokens: 10, fetchImpl });
  assert.ok(res.ok);
  assert.equal(attempts, 2);
});

test('openAnthropicStream: an abort is terminal — no retry', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    openAnthropicStream({ apiKey: 'k', model: 'm', messages: [], maxTokens: 10, fetchImpl }),
    /AbortError/,
  );
  assert.equal(attempts, 1);
});

test('openAnthropicStream: tags status + retryAfter for the caller', async () => {
  const fetchImpl = async () =>
    fakeAnthropicResponse({ ok: false, status: 429, headers: { 'Retry-After': '30' }, textBody: 'rate' });
  await assert.rejects(
    openAnthropicStream({ apiKey: 'k', model: 'm', messages: [], maxTokens: 10, fetchImpl }),
    (e) => e.status === 429 && e.retryAfter === 30,
  );
});

test('parseModelJson: plain JSON, prose/fence-wrapped JSON, junk throws', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('Sure! Here it is:\n```json\n{"a":[1,2]}\n```\nHope that helps.'), { a: [1, 2] });
  assert.deepEqual(parseModelJson('  {"nested":{"b":true}} '), { nested: { b: true } });
  assert.throws(() => parseModelJson('no json here'), /parseable JSON/);
  assert.throws(() => parseModelJson(''), /parseable JSON/);
});

test('toBullets: arrays, delimited blobs, glyph stripping, caps, junk', () => {
  assert.deepEqual(toBullets(['- one', '• two', '3. three'], 100), ['one', 'two', 'three']);
  assert.deepEqual(toBullets('- a\n- b\n\n- c', 100), ['a', 'b', 'c']);
  assert.deepEqual(toBullets('x'.repeat(50), 10), ['x'.repeat(10)]);
  assert.deepEqual(toBullets(null, 100), []);
  assert.deepEqual(toBullets(42, 100), []);
  assert.deepEqual(toBullets(['', '  ', '- real'], 100), ['real']);
});

test('userFacingReason: honest 429 message, fallback detail otherwise', () => {
  const rate = Object.assign(new Error('x'), { status: 429, retryAfter: 12 });
  assert.match(userFacingReason(rate, 'detail'), /about 12s/);
  const rateNoWindow = Object.assign(new Error('x'), { status: 429 });
  assert.match(userFacingReason(rateNoWindow, 'detail'), /a minute/);
  const other = Object.assign(new Error('x'), { status: 500 });
  assert.equal(userFacingReason(other, 'fallback text'), 'fallback text');
  assert.equal(userFacingReason(null, 'fallback text'), 'fallback text');
});
