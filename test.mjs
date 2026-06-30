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
