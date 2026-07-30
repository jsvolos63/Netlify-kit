// Tests for @jfs/netlify-kit. Run with: node test.mjs  (or: npm test)
// Uses node:test (auto-runs, non-zero exit on failure) — no framework deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  corsHeaders,
  handlePreflight,
  preflightResponse,
  JSON_HEADERS,
  jsonResponse,
  jsonBodyResponse,
  jsonStatusResponse,
  errorResponse,
  textResponse,
  ok,
  badRequest,
  notFound,
  methodNotAllowed,
  serverError,
  badGateway,
  upstreamError,
  createResponders,
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
  assert.equal(JSON_HEADERS['Content-Type'], 'application/json; charset=utf-8');
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
  assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
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
  assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(r.body, '{"error":"nope"}');
  const custom = jsonResponse(200, { ok: 1 }, { cacheControl: 'max-age=60', headers: { 'x-h': '1' } });
  assert.equal(custom.headers['Cache-Control'], 'max-age=60');
  assert.equal(custom.headers['x-h'], '1');
});

// The EXACT emitted header sets, pinned deliberately: header-shape drift
// between the two jsonResponse branches is the bug 0.8.0 fixed, so any future
// change to either shape must edit this test on purpose.
test('json response header shapes are pinned (both branches, exact)', () => {
  assert.deepEqual(jsonBodyResponse({ a: 1 }).headers, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    // NOTE: no Cache-Control — body-first never emits one unless asked
    // (consumers rely on that for CDN-cacheable proxies).
  });
  assert.deepEqual(jsonStatusResponse(404, { error: 'nope' }).headers, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', // status-first defaults to no-store
    'Access-Control-Allow-Origin': '*',
  });
});

test('named forms delegate to the same implementations as the overload', () => {
  assert.deepEqual(jsonBodyResponse({ a: 1 }, 'no-store', { ETag: 'x' }), jsonResponse({ a: 1 }, 'no-store', { ETag: 'x' }));
  assert.deepEqual(jsonStatusResponse(429, { error: 'rl' }, { cacheControl: 'no-store' }), jsonResponse(429, { error: 'rl' }, { cacheControl: 'no-store' }));
});

// The overload's documented hazard: a bare numeric payload dispatches as a
// STATUS CODE, not a body. The named forms are how to say each unambiguously.
test('jsonResponse numeric first argument always dispatches status-first', () => {
  const r = jsonResponse(42);
  assert.equal(r.statusCode, 42); // 42 became the status…
  assert.equal(r.body, undefined); // …and the body is JSON.stringify(undefined)
  const b = jsonBodyResponse(42);
  assert.equal(b.statusCode, 200);
  assert.equal(b.body, '42');
});

// Caller header overrides replace the kit defaults even when the caller's key
// casing differs — never a duplicate pair of same-name headers.
test('header overrides merge case-insensitively (caller casing wins)', () => {
  const s = jsonStatusResponse(200, { ok: 1 }, { headers: { 'cache-control': 'public, max-age=60' } });
  assert.equal(s.headers['cache-control'], 'public, max-age=60');
  assert.ok(!('Cache-Control' in s.headers));
  const b = jsonBodyResponse({ ok: 1 }, 'no-store', { 'cache-control': 'public, max-age=60', 'content-type': 'application/vnd.x+json' });
  assert.equal(b.headers['cache-control'], 'public, max-age=60');
  assert.ok(!('Cache-Control' in b.headers));
  assert.equal(b.headers['content-type'], 'application/vnd.x+json');
  assert.ok(!('Content-Type' in b.headers));
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

// No response may carry any Access-Control-* header (the no-CORS-endpoint
// posture: per-query-billed proxies stay unreadable to cross-origin scripts).
function assertNoCorsHeaders(r) {
  for (const k of Object.keys(r.headers || {})) {
    assert.ok(!k.toLowerCase().startsWith('access-control-'), `unexpected CORS header ${k}`);
  }
}

test('createResponders (default): byte-identical to the module-level helpers', () => {
  const d = createResponders();
  assert.deepEqual(d.jsonResponse({ a: 1 }, 'no-store', { ETag: 'x' }), jsonResponse({ a: 1 }, 'no-store', { ETag: 'x' }));
  assert.deepEqual(d.jsonResponse(404, { error: 'nope' }), jsonResponse(404, { error: 'nope' }));
  assert.deepEqual(d.errorResponse(400, 'x', { 'Retry-After': '5' }), errorResponse(400, 'x', { 'Retry-After': '5' }));
  assert.deepEqual(d.textResponse(200, 'hi', { cacheControl: 'no-store' }), textResponse(200, 'hi', { cacheControl: 'no-store' }));
  assert.deepEqual(d.ok({ a: 1 }), ok({ a: 1 }));
  assert.deepEqual(d.badRequest('x'), badRequest('x'));
  assert.deepEqual(d.notFound('x'), notFound('x'));
  assert.deepEqual(d.methodNotAllowed(), methodNotAllowed());
  assert.deepEqual(d.serverError('x'), serverError('x'));
  assert.deepEqual(d.badGateway('x'), badGateway('x'));
  assert.deepEqual(d.upstreamError(200, 'x'), upstreamError(200, 'x'));
});

test('createResponders({ cors: false }): identical shapes, zero CORS headers', () => {
  const n = createResponders({ cors: false });

  // body-first JSON: same status/body/content-type/cache-control, nosniff kept.
  const bf = n.jsonResponse({ a: 1 }, 'no-store', { ETag: 'x' });
  assertNoCorsHeaders(bf);
  assert.equal(bf.statusCode, 200);
  assert.equal(bf.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(bf.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(bf.headers['Cache-Control'], 'no-store');
  assert.equal(bf.headers.ETag, 'x');
  assert.equal(bf.body, '{"a":1}');

  // status-first JSON: no Access-Control-Allow-Origin unless explicitly asked.
  const sf = n.jsonResponse(404, { error: 'nope' });
  assertNoCorsHeaders(sf);
  assert.equal(sf.statusCode, 404);
  assert.equal(sf.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(sf.headers['Cache-Control'], 'no-store');
  assert.equal(sf.body, '{"error":"nope"}');
  // ... an explicit per-call corsOrigin always means it, even with cors:false.
  const explicit = n.jsonResponse(200, { ok: 1 }, { corsOrigin: 'https://app.example' });
  assert.equal(explicit.headers['Access-Control-Allow-Origin'], 'https://app.example');

  // the named forms are on the configured set too, same no-CORS shapes.
  assert.deepEqual(n.jsonBodyResponse({ a: 1 }, 'no-store', { ETag: 'x' }), bf);
  assert.deepEqual(n.jsonStatusResponse(404, { error: 'nope' }), sf);

  // text: same content-type, no CORS; opt-in cache-control still works.
  const t = n.textResponse(200, 'hello', { cacheControl: 'no-store' });
  assertNoCorsHeaders(t);
  assert.equal(t.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(t.headers['cache-control'], 'no-store');
  assert.equal(t.body, 'hello');

  // errorResponse + the sugar: shape parity with the CORS versions.
  const e = n.errorResponse(400, 'Missing symbol', { 'Retry-After': '5' });
  assertNoCorsHeaders(e);
  assert.equal(e.headers['Retry-After'], '5');
  assert.deepEqual(JSON.parse(e.body), { error: 'Missing symbol' });
  for (const [r, status] of [
    [n.ok({}), 200], [n.badRequest('x'), 400], [n.notFound('x'), 404],
    [n.methodNotAllowed(), 405], [n.serverError('x'), 500], [n.badGateway('x'), 502],
  ]) {
    assertNoCorsHeaders(r);
    assert.equal(r.statusCode, status);
  }
  assert.deepEqual(JSON.parse(n.methodNotAllowed().body), { error: 'Method not allowed.' });
  // upstreamError still clamps and forwards Retry-After.
  assert.equal(n.upstreamError(200, 'x').statusCode, 502);
  const up = n.upstreamError(429, 'busy', { 'Retry-After': '30' });
  assertNoCorsHeaders(up);
  assert.equal(up.headers['Retry-After'], '30');

  // The default exports are untouched by the factory existing.
  assert.equal(ok({}).headers['Access-Control-Allow-Origin'], '*');
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

// ──────────────────────────── retry ─────────────────────────────

const noSleep = async () => {};

test('fetchWithRetry: retries 503 then succeeds', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return n < 3 ? { status: 503, body: { cancel: async () => {} } } : { status: 200 }; };
  const r = await fetchWithRetry('u', {}, { fetchFn, sleepFn: noSleep, retries: 3 });
  assert.equal(r.status, 200);
  assert.equal(n, 3);
});

// ── Retry-After (0.8.0): a retryable response's Retry-After header sets the
//    backoff delay, capped at capMs; absent/unparseable falls back to jitter.

// A mock retryable response whose Headers only carry Retry-After.
const res503 = (retryAfter) => ({
  status: 503,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' && retryAfter != null ? retryAfter : null) },
  body: { cancel: async () => {} },
});
// One 503 (with the given Retry-After) then a 200; returns the recorded sleeps.
async function sleepsFor(retryAfter, opts = {}) {
  const sleeps = [];
  let n = 0;
  const fetchFn = async () => (n++ === 0 ? res503(retryAfter) : { status: 200 });
  const r = await fetchWithRetry('u', {}, {
    fetchFn,
    sleepFn: async (ms) => { sleeps.push(ms); },
    retries: 2,
    capMs: 2000,
    rng: () => 0, // computed jitter backoff would be 0 — any positive sleep proves Retry-After won
    ...opts,
  });
  assert.equal(r.status, 200);
  return sleeps;
}

test('fetchWithRetry: Retry-After delta-seconds sets the delay', async () => {
  assert.deepEqual(await sleepsFor('1'), [1000]);
});

test('fetchWithRetry: Retry-After HTTP-date sets the delay (relative to now)', async () => {
  // ~1.5s ahead; toUTCString truncates ms, so accept anything in (0, 1500].
  const [ms] = await sleepsFor(new Date(Date.now() + 1500).toUTCString());
  assert.ok(ms > 0 && ms <= 1500, `expected 0 < delay <= 1500, got ${ms}`);
  // a date in the past clamps to 0, never negative.
  const [past] = await sleepsFor(new Date(Date.now() - 60_000).toUTCString());
  assert.equal(past, 0);
});

test('fetchWithRetry: Retry-After is capped at capMs, never extended', async () => {
  assert.deepEqual(await sleepsFor('60'), [2000]); // 60s asked, capMs 2000 wins
  assert.deepEqual(await sleepsFor(new Date(Date.now() + 300_000).toUTCString()), [2000]);
});

test('fetchWithRetry: absent or unparseable Retry-After falls back to jittered backoff', async () => {
  // rng fixed at 0.5, baseMs 200 → attempt-0 backoff = floor(0.5 * 200) = 100.
  const jitterOpts = { rng: () => 0.5, baseMs: 200 };
  assert.deepEqual(await sleepsFor(null, jitterOpts), [100]);
  assert.deepEqual(await sleepsFor('soon', jitterOpts), [100]);
  // headerless mock responses (like the ones elsewhere in this file) also fall back.
  let n = 0;
  const sleeps = [];
  const fetchFn = async () => (n++ === 0 ? { status: 503, body: { cancel: async () => {} } } : { status: 200 });
  await fetchWithRetry('u', {}, { fetchFn, sleepFn: async (ms) => { sleeps.push(ms); }, ...jitterOpts });
  assert.deepEqual(sleeps, [100]);
});

test('fetchWithRetry: Retry-After honored on 429 too when retryOn429 is set', async () => {
  const sleeps = [];
  let n = 0;
  const res429 = { ...res503('1'), status: 429 };
  const fetchFn = async () => (n++ === 0 ? res429 : { status: 200 });
  const r = await fetchWithRetry('u', {}, { fetchFn, sleepFn: async (ms) => { sleeps.push(ms); }, retryOn429: true, rng: () => 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(sleeps, [1000]);
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

test('fetchWithRetry: retries:0 performs exactly one attempt (billed upstreams)', async () => {
  // A retryable 503 is returned as-is — no second request is ever issued.
  let n = 0;
  const r = await fetchWithRetry('u', {}, { fetchFn: async () => { n++; return { status: 503, body: { cancel: async () => {} } }; }, sleepFn: noSleep, retries: 0 });
  assert.equal(r.status, 503);
  assert.equal(n, 1);
  // A thrown network error propagates after the single attempt.
  n = 0;
  await assert.rejects(
    () => fetchWithRetry('u', {}, { fetchFn: async () => { n++; throw new Error('ECONNRESET'); }, sleepFn: noSleep, retries: 0 }),
    /ECONNRESET/,
  );
  assert.equal(n, 1);
});

// A fetchFn that hangs until its per-attempt signal aborts (like real fetch).
const hangingFetch = (calls) => (url, init) => new Promise((resolve, reject) => {
  calls.push(init);
  const abort = () => {
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    reject(e);
  };
  if (init.signal.aborted) abort();
  else init.signal.addEventListener('abort', abort, { once: true });
});

test('fetchWithRetry: attemptTimeoutMs bounds a single attempt (retries:0)', async () => {
  const calls = [];
  const start = Date.now();
  await assert.rejects(
    () => fetchWithRetry('u', {}, { fetchFn: hangingFetch(calls), sleepFn: noSleep, retries: 0, attemptTimeoutMs: 30 }),
    (e) => e.name === 'TimeoutError' && e.timedOut === true && /timed out after 30ms/.test(e.message),
  );
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - start < 2000, 'rejected promptly rather than hanging');
});

test('fetchWithRetry: each attempt gets its OWN deadline; a timed-out attempt is retryable', async () => {
  let n = 0;
  const fetchFn = (url, init) => {
    n++;
    if (n === 1) return hangingFetch([])(url, init); // first attempt hangs → per-attempt timeout
    return Promise.resolve({ status: 200 });
  };
  const r = await fetchWithRetry('u', {}, { fetchFn, sleepFn: noSleep, retries: 1, attemptTimeoutMs: 30 });
  assert.equal(r.status, 200);
  assert.equal(n, 2);
});

test('fetchWithRetry: a caller-signal abort stays terminal even with attemptTimeoutMs', async () => {
  const ctl = new AbortController();
  const calls = [];
  const p = assert.rejects(
    () => fetchWithRetry('u', { signal: ctl.signal }, { fetchFn: hangingFetch(calls), sleepFn: noSleep, retries: 3, attemptTimeoutMs: 5000 }),
    (e) => e.name === 'AbortError',
  );
  ctl.abort();
  await p;
  assert.equal(calls.length, 1); // no retry after the caller aborted
});

test('fetchWithRetry: without attemptTimeoutMs, init passes through untouched', async () => {
  // Existing callers (e.g. init.signal = AbortSignal.timeout(...)) keep the
  // exact same object — no wrapper controller is interposed.
  const init = { headers: { a: '1' } };
  let seen;
  await fetchWithRetry('u', init, { fetchFn: async (url, i) => { seen = i; return { status: 200 }; }, sleepFn: noSleep });
  assert.strictEqual(seen, init);
});

// ──────────────────────── rate limiting ─────────────────────────

test('clientIp: precedence', () => {
  assert.equal(clientIp(eventWith({ headers: { 'x-nf-client-connection-ip': '1.2.3.4' } })), '1.2.3.4');
  // The LAST hop, not the first: proxies append, so '5.6.7.8' here is whatever
  // the caller wrote and '9.9.9.9' is what the nearest trusted proxy observed.
  assert.equal(clientIp(eventWith({ headers: { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' } })), '9.9.9.9');
  // 'client-ip' has no platform meaning and is fully caller-supplied.
  assert.equal(clientIp(eventWith({ headers: { 'client-ip': '10.0.0.9' } })), 'unknown');
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

test('rateLimit: hex-only words and out-of-range octets are NOT IPs (collapse to unknown)', () => {
  _resetRateLimit();
  // Every one of these previously passed the IP check and minted its own
  // bucket key — an unbounded junk-x-forwarded-for cardinality flood. They
  // must all share the single 'unknown' bucket instead.
  const junk = ['deadbeef', 'abc', 'cafe', '999.1.1.1', '1.2.3.999'];
  const opts = { name: 'feed', windowMs: 60_000, max: 1 };
  const evFor = (v) => eventWith({ headers: { 'x-forwarded-for': v } });
  assert.equal(rateLimit(evFor(junk[0]), opts, 1).ok, true);
  for (const v of junk.slice(1)) {
    assert.equal(rateLimit(evFor(v), opts, 2).ok, false, `"${v}" minted its own bucket`);
  }
  // Real IPs still bucket individually.
  assert.equal(rateLimit(evFor('1.2.3.4'), opts, 3).ok, true);
  assert.equal(rateLimit(evFor('2001:db8::1'), opts, 3).ok, true);
  assert.equal(rateLimit(evFor('::1'), opts, 3).ok, true);
});

test('checkRateLimit / checkRateLimitDistributed: { cors: false } strips CORS off 429 and 414', async () => {
  _resetRateLimit();
  const ev = eventWith({ headers: { 'x-forwarded-for': '5.5.5.5' } });
  assert.equal(checkRateLimit(ev, 1, 60_000, { cors: false }), null);
  const blocked = checkRateLimit(ev, 1, 60_000, { cors: false });
  assert.equal(blocked.statusCode, 429);
  assertNoCorsHeaders(blocked);
  assert.ok(blocked.headers['Retry-After']); // the useful headers survive
  assert.equal(blocked.headers['X-Content-Type-Options'], 'nosniff');

  const long = checkRateLimit(eventWith({ headers: {}, rawQuery: 'x'.repeat(MAX_QUERY_LENGTH + 1) }), 60, 60_000, { cors: false });
  assert.equal(long.statusCode, 414);
  assertNoCorsHeaders(long);

  // Distributed: the CAS deny and the in-memory fallback both honor cors:false.
  const store = casStore();
  const dev = eventWith({ headers: { 'x-forwarded-for': '5.5.6.6' } });
  assert.equal(await checkRateLimitDistributed(dev, 1, 60_000, { store, cors: false }), null);
  const dblocked = await checkRateLimitDistributed(dev, 1, 60_000, { store, cors: false });
  assert.equal(dblocked.statusCode, 429);
  assertNoCorsHeaders(dblocked);
  _resetStoreCache();
  const fev = eventWith({ headers: { 'x-forwarded-for': '5.5.7.7' } });
  assert.equal(await checkRateLimitDistributed(fev, 1, 60_000, { cors: false }), null); // no blobs → fallback
  assertNoCorsHeaders(await checkRateLimitDistributed(fev, 1, 60_000, { cors: false }));
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

test('createHandler({ cors: false }): preflight, 429, and 500 all emit zero CORS headers', async () => {
  _resetRateLimit();
  const responders = createResponders({ cors: false });

  // OPTIONS short-circuit becomes a bare 204.
  const bare = createHandler({ cors: false, handle: async () => responders.ok({}) });
  const pf = await bare(eventWith({ method: 'OPTIONS' }));
  assert.equal(pf.statusCode, 204);
  assert.deepEqual(pf.headers, {});

  // The limiter's 429 honors the opt-out.
  const limited = createHandler({ cors: false, rateLimit: { max: 1, windowMs: 60_000 }, handle: async () => responders.ok({}) });
  const ev = eventWith({ headers: { 'x-forwarded-for': '4.5.6.7' } });
  const first = await limited(ev);
  assert.equal(first.statusCode, 200);
  assertNoCorsHeaders(first); // handle used the no-CORS responders
  const blocked = await limited(ev);
  assert.equal(blocked.statusCode, 429);
  assertNoCorsHeaders(blocked);

  // The catch-all 500 honors it too.
  const thrower = createHandler({ cors: false, rateLimit: null, handle: async () => { throw new Error('boom'); } });
  const r = await thrower(eventWith({}));
  assert.equal(r.statusCode, 500);
  assertNoCorsHeaders(r);
  assert.deepEqual(JSON.parse(r.body), { error: 'Internal error' });

  // Default createHandler still speaks CORS everywhere (unchanged behavior).
  _resetRateLimit();
  const dflt = createHandler({ rateLimit: { max: 1, windowMs: 60_000 }, handle: async () => ok({}) });
  const dev = eventWith({ headers: { 'x-forwarded-for': '4.5.6.8' } });
  await dflt(dev);
  assert.equal((await dflt(dev)).headers['Access-Control-Allow-Origin'], '*');
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

test('model constants: Opus 4.8 default, version header', () => {
  assert.equal(DEFAULT_MODEL, 'claude-opus-4-8');
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

// --- limiter IP resolution ------------------------------------------------

test('clientIp: takes the last x-forwarded-for hop, not the caller-written first', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' } }), '203.0.113.7');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7' } }), '203.0.113.7');
  assert.equal(
    clientIp({ headers: { 'x-nf-client-connection-ip': '198.51.100.9', 'x-forwarded-for': '1.2.3.4' } }),
    '198.51.100.9',
    'the platform header still wins',
  );
  assert.equal(clientIp({ headers: { 'client-ip': '1.2.3.4' } }), 'unknown', 'client-ip is no longer trusted');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('rateLimit: rotating the caller-written x-forwarded-for hop cannot mint buckets', () => {
  const opts = { name: 'xff-spoof', windowMs: 60_000, max: 1 };
  const ev = (spoof) => ({ headers: { 'x-forwarded-for': `${spoof}, 203.0.113.7` } });
  assert.equal(rateLimit(ev('10.0.0.1'), opts).ok, true);
  for (let i = 2; i < 40; i++) {
    assert.equal(rateLimit(ev(`10.0.0.${i}`), opts).ok, false, 'rotation must not open a fresh bucket');
  }
});

test('rateLimit: malformed IPv6 spellings collapse into the shared unknown bucket', () => {
  const opts = { name: 'v6-junk', windowMs: 60_000, max: 1 };
  const ev = (ip) => ({ headers: { 'x-nf-client-connection-ip': ip } });
  assert.equal(rateLimit(ev('0:'), opts).ok, true);
  for (const junk of ['a:b', 'dead:beef:', '1:2:3:4:5:6:7:8:9', ':1:2', 'zzzz::1', '1::2::3']) {
    assert.equal(rateLimit(ev(junk), opts).ok, false, junk);
  }
});

test('rateLimit: well-formed IPv6 addresses still get their own buckets', () => {
  const opts = { name: 'v6-ok', windowMs: 60_000, max: 1 };
  const ev = (ip) => ({ headers: { 'x-nf-client-connection-ip': ip } });
  for (const ip of ['::1', '::', '2001:db8::1', '::ffff:192.0.2.1', '1:2:3:4:5:6:7:8', 'fe80::a:b:c:d']) {
    assert.equal(rateLimit(ev(ip), opts).ok, true, ip);
  }
  assert.equal(rateLimit(ev('2001:db8::1'), opts).ok, false, 'a repeat hit on the same address is limited');
});
