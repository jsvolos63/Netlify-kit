# @jfs/netlify-kit

Shared, dependency-free **Netlify Functions primitives** for the JFS family of
buildless static sites (market-monitor, Surf-Tracker, FlightCheck, …).

Every sibling app that ships Netlify Functions re-implements the same handful of
cross-cutting concerns in each function's `utils/` or `lib/` folder — CORS
headers + preflight, JSON / text / error response shaping, an SSRF guard for
caller-supplied URLs, input-validation regexes, a retry-with-backoff fetch
wrapper, a per-IP rate limiter, and a try/catch handler boundary. Each copy
drifts slightly, and the differences are exactly the subtle correctness bugs a
single tested implementation eliminates (a double-decoded `&`, an unbounded
`await res.text()`, a metadata-IP SSRF hole). This package is that single copy.

Pure ESM, **dependency-free at install time**. The one optional integration —
Netlify Blobs for distributed rate limiting — is reached through a dynamic
`import('@netlify/blobs')` that degrades to the in-memory limiter when the
package (or a configured store) isn't present.

This consolidates the proven implementations from
`market-monitor/netlify/functions/utils/*`,
`Surf-Tracker/netlify/functions/lib/{http,ratelimit,url}.js`, and
`FlightCheck/netlify/functions/lib/http.js`.

## Install

```jsonc
// package.json
"dependencies": { "@jfs/netlify-kit": "github:jsvolos63/netlify-kit#v0.1.0" }
```

## Quick start

```js
import { createHandler, errorResponse, jsonResponse, fetchWithRetry } from '@jfs/netlify-kit';

export const handler = createHandler({
  name: 'quote',
  rateLimit: { max: 120, windowMs: 60_000 },   // per-IP, in-memory
  handle: async (event) => {
    const { symbol } = event.queryStringParameters || {};
    if (!symbol) return errorResponse(400, 'Missing symbol');
    const r = await fetchWithRetry(`https://api.example.com/q?s=${symbol}`, {
      signal: AbortSignal.timeout(8000),
    });
    return jsonResponse(await r.json(), { cacheControl: 'no-store' });
  },
});
```

`createHandler` wraps the cross-cutting concerns — CORS preflight, per-IP rate
limiting, and a top-level try/catch + 500 fallback — so each function only
writes the provider-specific bits. Pass `rateLimit: null` to disable the
limiter, a `{ max, windowMs }` config to tune it, or a pre-built limiter
instance (see below) to share state across functions.

## API

### CORS & responses

- `buildCorsHeaders({ origin, methods, headers, maxAge })` → a fresh header
  object (`origin` defaults to `CORS_ORIGIN` env or `*`, always `nosniff`).
- `handlePreflight(event, corsOpts)` → a 204 response for OPTIONS, else `null`.
- `jsonResponse(body, { statusCode=200, cacheControl, headers, cors=true })` —
  `body` may be a value (stringified) or an already-serialised JSON string
  (passed through). `cors` accepts `true` / `false` / a `buildCorsHeaders`
  options object.
- `errorResponse(statusCode, error, opts)` → `{ error }` JSON body.
- `textResponse(body, { statusCode=200, cacheControl, headers, cors=true })`.
- `errorMessage(err, max=200)` — bounded stringification for logs/bodies.
- `checkResponseSize(response, { maxBytes, headers })` — cheap pre-read 502
  guard from `content-length`; `null` when ok or absent (chunked).
- `readTextCapped(res, maxBytes=5MB)` — stream a fetch body as UTF-8 text,
  aborting past the cap; throws an Error tagged `.tooLarge` (non-retryable).
- `MAX_RESPONSE_BYTES` — the 5 MB default cap.

### Validation

- `SYMBOL_RE`, `FRED_ID_RE`, `UNIX_TS_RE` — character-class + length regexes.
- `isValidDate('YYYY-MM-DD')` — rollover-checked (rejects `2024-02-30`).
- `isValidTimestamp(str)` — unix seconds in `0 … now + 1 day`.

### SSRF guards

For functions that fetch a caller-supplied URL without a static host allowlist.

- `parseSafeHttpsUrl(input)` → `{ ok, url, error }` — HTTPS-only, port 443,
  no credentials, no IP literals, no `localhost`/`.local`/`.internal`/`.lan`.
- `isSafeHttpsUrl(input)` → boolean.
- `resolveHostIsPublic(hostname)` → `{ ok, error, address }` — resolves the
  name and **fails closed** if any address is private / link-local / loopback
  (blocks the `169.254.169.254` metadata trick) or DNS fails.
- `isPrivateIPv4`, `isPrivateIPv6`, `isPrivateAddress(addr, family)` — pure,
  exported for unit testing.

### Retry

- `fetchWithRetry(url, init, { retries=2, baseMs=200, capMs=2000, retryOn429=false, fetchFn, sleepFn, rng })`
  — exponential backoff + full jitter; retries thrown network errors and
  502/503/504 (429 only when opted in), never an `AbortError` on the caller's
  signal. `fetchFn`/`sleepFn`/`rng` are injectable for tests.
- `RETRYABLE_STATUSES` — the `Set` of retried status codes.

### Rate limiting

- `clientIp(event)` — best client IP (`x-nf-client-connection-ip` →
  `x-forwarded-for` first hop → `client-ip` → `'unknown'`), IP-validated.
- `createRateLimiter({ max=60, windowMs=60_000, maxKeys=5000, maxQueryLength=2048, cors })`
  → `{ allow(ip), check(event, overrides), reset() }`. In-process, fixed
  window, fails open. `check` returns a ready-to-return 429 (with `Retry-After`)
  or 414 (oversized query) response, or `null`. Each call returns an **isolated**
  limiter so distinct endpoints keep independent buckets.
- `createDistributedRateLimiter({ ..., storeName='rate-limits' })` → the same
  shape but `check` is **async** and backed by Netlify Blobs for cross-instance
  state, degrading transparently to an in-memory fallback when Blobs is absent.

### Handler factory

- `createHandler({ name, cors, rateLimit, handle, onError })` — see Quick start.
  `rateLimit` accepts a `{ max, windowMs }` config, a limiter instance, or
  `null`/`false`. `handle(event, context)` is required.

## Test

```bash
npm test     # node test.mjs — node:test, no framework deps
```
