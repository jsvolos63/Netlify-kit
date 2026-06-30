// Tests for @jfs/netlify-kit. Run with: node test.mjs  (or: npm test)
// Uses node:test (auto-runs, non-zero exit on failure) — no framework deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCorsHeaders,
  handlePreflight,
  jsonResponse,
  errorResponse,
  textResponse,
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
  createRateLimiter,
  createDistributedRateLimiter,
  createHandler,
} from './index.js';

// ───────────────────────── shared fakes ─────────────────────────

function headersOf(map) {
  return { get: (k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : null) };
}

// Fake fetch Response with a streaming body built from string chunks.
function streamResponse(chunks, { contentLength, status = 200 } = {}) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    status,
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

test('buildCorsHeaders: defaults + nosniff, fresh object each call', () => {
  const a = buildCorsHeaders();
  assert.equal(a['Access-Control-Allow-Origin'], '*');
  assert.equal(a['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
  assert.equal(a['X-Content-Type-Options'], 'nosniff');
  assert.ok(!('Access-Control-Max-Age' in a));
  assert.notEqual(a, buildCorsHeaders());
});

test('buildCorsHeaders: overrides + maxAge', () => {
  const h = buildCorsHeaders({ origin: 'https://x.test', methods: 'GET', maxAge: 600 });
  assert.equal(h['Access-Control-Allow-Origin'], 'https://x.test');
  assert.equal(h['Access-Control-Allow-Methods'], 'GET');
  assert.equal(h['Access-Control-Max-Age'], '600');
});

test('handlePreflight: 204 only for OPTIONS', () => {
  const pf = handlePreflight(eventWith({ method: 'OPTIONS' }));
  assert.equal(pf.statusCode, 204);
  assert.equal(pf.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(handlePreflight(eventWith({ method: 'GET' })), null);
});

// ─────────────────────────── responses ──────────────────────────

test('jsonResponse: defaults stringify + CORS + content-type', () => {
  const r = jsonResponse({ a: 1 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(r.body, '{"a":1}');
});

test('jsonResponse: pre-serialised string passes through; cacheControl + cors:false', () => {
  const r = jsonResponse('{"raw":true}', { statusCode: 201, cacheControl: 'no-store', cors: false });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body, '{"raw":true}');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.ok(!('Access-Control-Allow-Origin' in r.headers));
});

test('errorResponse: { error } body + status', () => {
  const r = errorResponse(400, 'Missing symbol');
  assert.equal(r.statusCode, 400);
  assert.deepEqual(JSON.parse(r.body), { error: 'Missing symbol' });
});

test('textResponse: text content-type, cache-control only when asked', () => {
  const r = textResponse('hello');
  assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.ok(!('Cache-Control' in r.headers));
  assert.equal(r.body, 'hello');
  assert.equal(textResponse(null).body, '');
  assert.equal(textResponse('x', { cacheControl: 'no-store' }).headers['Cache-Control'], 'no-store');
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
  assert.equal(checkResponseSize({ headers: headersOf({}) }), null); // chunked → pass
});

test('readTextCapped: returns text under cap', async () => {
  const text = await readTextCapped(streamResponse(['ab', 'cd']), 100);
  assert.equal(text, 'abcd');
});

test('readTextCapped: throws .tooLarge when stream exceeds cap', async () => {
  await assert.rejects(
    () => readTextCapped(streamResponse(['aaaa', 'bbbb', 'cccc']), 6),
    (e) => e.tooLarge === true,
  );
});

test('readTextCapped: rejects up-front on oversized content-length', async () => {
  await assert.rejects(
    () => readTextCapped(streamResponse(['x'], { contentLength: 1000 }), 10),
    (e) => e.tooLarge === true,
  );
});

test('readTextCapped: falls back to res.text() when no readable stream', async () => {
  const res = { headers: headersOf({}), text: async () => 'plain-body' };
  assert.equal(await readTextCapped(res, 100), 'plain-body');
  const big = { headers: headersOf({}), text: async () => 'x'.repeat(50) };
  await assert.rejects(() => readTextCapped(big, 10), (e) => e.tooLarge === true);
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

test('isValidDate: rollover-checked', () => {
  assert.ok(isValidDate('2024-02-29')); // leap year
  assert.ok(!isValidDate('2023-02-29'));
  assert.ok(!isValidDate('2024-13-01'));
  assert.ok(!isValidDate('2024-2-1'));
  assert.ok(!isValidDate('not-a-date'));
});

test('isValidTimestamp: range guarded', () => {
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

test('isPrivateIPv4: ranges', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.5.5', '100.64.0.1'])
    assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) assert.ok(!isPrivateIPv4(ip), ip);
  assert.ok(isPrivateIPv4('999.999.999.999')); // unparseable → unsafe
});

test('isPrivateIPv6 / isPrivateAddress', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', 'ff02::1'])
    assert.ok(isPrivateIPv6(ip), ip);
  assert.ok(!isPrivateIPv6('2606:4700:4700::1111'));
  assert.ok(isPrivateAddress('10.0.0.1', 4));
  assert.ok(isPrivateAddress('::1', 6));
  assert.ok(!isPrivateAddress('8.8.8.8', 4));
});

test('resolveHostIsPublic: localhost resolves to a private IP (fail closed)', async () => {
  const r = await resolveHostIsPublic('localhost');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'private-ip');
});

// ──────────────────────────── retry ─────────────────────────────

const noSleep = async () => {};

test('fetchWithRetry: retries 503 then succeeds', async () => {
  let n = 0;
  const fetchFn = async () => {
    n++;
    return n < 3 ? { status: 503, body: { cancel: async () => {} } } : { status: 200 };
  };
  const r = await fetchWithRetry('u', {}, { fetchFn, sleepFn: noSleep, retries: 3 });
  assert.equal(r.status, 200);
  assert.equal(n, 3);
});

test('fetchWithRetry: does not retry 400', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return { status: 400 }; };
  const r = await fetchWithRetry('u', {}, { fetchFn, sleepFn: noSleep });
  assert.equal(r.status, 400);
  assert.equal(n, 1);
});

test('fetchWithRetry: 429 only retried when opted in', async () => {
  let n = 0;
  const mk = async () => { n++; return { status: 429, body: { cancel: async () => {} } }; };
  n = 0;
  await fetchWithRetry('u', {}, { fetchFn: mk, sleepFn: noSleep, retries: 1 });
  assert.equal(n, 1); // not retried
  n = 0;
  await fetchWithRetry('u', {}, { fetchFn: mk, sleepFn: noSleep, retries: 1, retryOn429: true });
  assert.equal(n, 2); // retried
});

test('fetchWithRetry: network error retried then thrown', async () => {
  let n = 0;
  const fetchFn = async () => { n++; throw new Error('ECONNRESET'); };
  await assert.rejects(() => fetchWithRetry('u', {}, { fetchFn, sleepFn: noSleep, retries: 2 }));
  assert.equal(n, 3);
});

test('fetchWithRetry: AbortError not retried', async () => {
  let n = 0;
  const fetchFn = async () => { n++; const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(() => fetchWithRetry('u', {}, { fetchFn, sleepFn: noSleep, retries: 3 }));
  assert.equal(n, 1);
});

test('RETRYABLE_STATUSES set', () => {
  assert.ok(RETRYABLE_STATUSES.has(503));
  assert.ok(!RETRYABLE_STATUSES.has(500));
});

// ──────────────────────── rate limiting ─────────────────────────

test('clientIp: precedence + validation', () => {
  assert.equal(clientIp(eventWith({ headers: { 'x-nf-client-connection-ip': '1.2.3.4' } })), '1.2.3.4');
  assert.equal(clientIp(eventWith({ headers: { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' } })), '5.6.7.8');
  assert.equal(clientIp(eventWith({ headers: { 'client-ip': '10.0.0.9' } })), '10.0.0.9');
  assert.equal(clientIp(eventWith({ headers: { 'x-forwarded-for': 'garbage' } })), 'unknown');
  assert.equal(clientIp(eventWith({})), 'unknown');
});

test('createRateLimiter.allow: fixed window with injected clock', () => {
  const rl = createRateLimiter({ max: 2, windowMs: 1000 });
  assert.ok(rl.allow('ip', 2, 1000, 0));
  assert.ok(rl.allow('ip', 2, 1000, 100));
  assert.ok(!rl.allow('ip', 2, 1000, 200)); // 3rd in window → blocked
  assert.ok(rl.allow('ip', 2, 1000, 1500)); // new window → allowed
});

test('createRateLimiter.check: 429 with Retry-After, then reset', () => {
  const rl = createRateLimiter({ max: 1, windowMs: 60_000 });
  const ev = eventWith({ headers: { 'x-nf-client-connection-ip': '1.2.3.4' } });
  assert.equal(rl.check(ev), null);
  const blocked = rl.check(ev);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.equal(blocked.headers['Access-Control-Allow-Origin'], '*');
  rl.reset();
  assert.equal(rl.check(ev), null);
});

test('createRateLimiter.check: 414 on oversized query', () => {
  const rl = createRateLimiter({ maxQueryLength: 8 });
  const r = rl.check(eventWith({ headers: {}, rawQuery: 'x'.repeat(20) }));
  assert.equal(r.statusCode, 414);
});

test('createRateLimiter: independent buckets per instance', () => {
  const a = createRateLimiter({ max: 1 });
  const b = createRateLimiter({ max: 1 });
  const ev = eventWith({ headers: { 'x-nf-client-connection-ip': '1.2.3.4' } });
  assert.equal(a.check(ev), null);
  assert.equal(b.check(ev), null); // b's bucket is untouched by a
});

test('createDistributedRateLimiter: degrades to in-memory without blobs', async () => {
  const rl = createDistributedRateLimiter({ max: 1, windowMs: 60_000 });
  const ev = eventWith({ headers: { 'x-nf-client-connection-ip': '1.2.3.4' } });
  assert.equal(await rl.check(ev), null);
  const blocked = await rl.check(ev);
  assert.equal(blocked.statusCode, 429); // fell back to in-memory bucket
  const store = await rl._getStore();
  assert.equal(store, null); // @netlify/blobs not installed → null store
});

// ─────────────────────── handler factory ────────────────────────

test('createHandler: preflight short-circuits', async () => {
  const h = createHandler({ handle: async () => jsonResponse({ ok: true }) });
  const r = await h(eventWith({ method: 'OPTIONS' }));
  assert.equal(r.statusCode, 204);
});

test('createHandler: happy path passes event + context through', async () => {
  const h = createHandler({
    rateLimit: null,
    handle: async (event, context) => jsonResponse({ q: event.queryStringParameters, c: context }),
  });
  const r = await h({ queryStringParameters: { s: 'AAPL' } }, { fn: 1 });
  assert.deepEqual(JSON.parse(r.body), { q: { s: 'AAPL' }, c: { fn: 1 } });
});

test('createHandler: rate limit enforced via config', async () => {
  const h = createHandler({ rateLimit: { max: 1, windowMs: 60_000 }, handle: async () => jsonResponse({}) });
  const ev = eventWith({ headers: { 'x-nf-client-connection-ip': '1.2.3.4' } });
  assert.equal((await h(ev)).statusCode, 200);
  assert.equal((await h(ev)).statusCode, 429);
});

test('createHandler: accepts a pre-built limiter instance', async () => {
  const limiter = createRateLimiter({ max: 1 });
  const h = createHandler({ rateLimit: limiter, handle: async () => jsonResponse({}) });
  const ev = eventWith({ headers: { 'x-nf-client-connection-ip': '9.9.9.9' } });
  assert.equal((await h(ev)).statusCode, 200);
  assert.equal((await h(ev)).statusCode, 429);
});

test('createHandler: thrown error → 500, onError honored', async () => {
  const thrower = createHandler({ rateLimit: null, name: 't', handle: async () => { throw new Error('boom'); } });
  const r = await thrower(eventWith({}));
  assert.equal(r.statusCode, 500);
  assert.deepEqual(JSON.parse(r.body), { error: 'Internal error' });

  const custom = createHandler({
    rateLimit: null,
    handle: async () => { throw new Error('boom'); },
    onError: async () => errorResponse(503, 'Down for maintenance'),
  });
  assert.equal((await custom(eventWith({}))).statusCode, 503);
});

test('createHandler: requires a handle function', () => {
  assert.throws(() => createHandler({}), /handle option is required/);
});
