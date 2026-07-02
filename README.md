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

## Compatibility superset

The sibling apps grew slightly different signatures for the same idea
(market-monitor's `jsonResponse(body, cacheControl, extraHeaders)` returns 200;
Surf-Tracker's `jsonResponse(statusCode, obj, opts)` takes an explicit status).
So apps can adopt the kit by **only changing import paths** — not call sites —
`jsonResponse` / `textResponse` detect the convention from their first argument
(a **number** ⇒ status-first form, anything else ⇒ body-first form), and each
form behaves byte-for-byte like the app it came from. The consolidated sources:

- `market-monitor/netlify/functions/utils/*` (CORS, handler factory, validation,
  retry, SSRF, in-memory + Blobs rate limiters)
- `Surf-Tracker/netlify/functions/lib/{http,ratelimit,url}.js` (`textResponse`,
  `preflightResponse`, `errorMessage`, `readTextCapped`, `rateLimit`, `clientIp`)
- `FlightCheck/netlify/functions/lib/http.js` (response sugar)

## Quick start

```js
import { createHandler, errorResponse, jsonResponse, fetchWithRetry } from '@jfs/netlify-kit';

export const handler = createHandler({
  name: 'quote',
  rateLimit: { max: 120, windowMs: 60_000 },   // per-IP, in-memory
  // distributed: true,                          // → Netlify Blobs limiter
  handle: async (event) => {
    const { symbol } = event.queryStringParameters || {};
    if (!symbol) return errorResponse(400, 'Missing symbol');
    const r = await fetchWithRetry(`https://api.example.com/q?s=${symbol}`, {
      signal: AbortSignal.timeout(8000),
    });
    return jsonResponse(await r.json(), 'no-store');
  },
});
```

## API

**CORS** — `corsHeaders` (object), `handlePreflight(event)` (204 for OPTIONS,
else `null`), `preflightResponse(opts)` (unconditional 204 advertising verbs).

**Responses**
- `JSON_HEADERS` — `Content-Type: application/json` + CORS.
- `jsonResponse(body, cacheControl?, extraHeaders?)` **or**
  `jsonResponse(statusCode, obj, opts?)` — see *Compatibility superset*.
- `errorResponse(statusCode, error, extraHeaders?)` — `{ error }` body.
- `textResponse(statusCode, body, opts?)`.
- `ok`, `badRequest`, `notFound`, `methodNotAllowed`, `serverError`,
  `badGateway`, `upstreamError(status, err, extraHeaders?)` — named sugar.
- `errorMessage(err, max=200)` — bounded stringification.
- `checkResponseSize(response, headers?)` — pre-read 502 guard from
  `content-length`. `readTextCapped(res, maxBytes)` — streamed UTF-8 read that
  throws `.tooLarge` past the cap. `MAX_RESPONSE_BYTES` (5 MB).

**Validation** — `SYMBOL_RE`, `FRED_ID_RE`, `UNIX_TS_RE`, `isValidDate`,
`isValidTimestamp`.

**SSRF guards** — `parseSafeHttpsUrl(input)` → `{ ok, url, error }`,
`isSafeHttpsUrl`, `resolveHostIsPublic(hostname)` (fail-closed DNS check that
blocks the `169.254.169.254` metadata trick), `isPrivateIPv4` / `isPrivateIPv6`
/ `isPrivateAddress`.

**Retry** — `fetchWithRetry(url, init, opts)` (exp backoff + full jitter;
retries network errors + 502/503/504, 429 only with `retryOn429`; injectable
`fetchFn`/`sleepFn`/`rng`), `RETRYABLE_STATUSES`.

**Rate limiting**
- `checkRateLimit(event, max, windowMs)` / `checkRateLimitDistributed(...)`
  (async, Netlify Blobs with in-memory fallback) — return a ready 429/414
  response or `null`. `_resetStoreCache()` test seam. `MAX_QUERY_LENGTH`.
- `rateLimit(event, { name, windowMs, max })` → `{ ok, retryAfter }` low-level
  check. `clientIp(event)`. `_resetRateLimit()` test seam.

**Blobs cache** — a store opener + short-TTL cache, generalized from
FlightCheck's `flightCache.js` and Surf-Tracker's `blobs.js`. Install-time
dependency-free (`@netlify/blobs` via the same dynamic `import()` as the
distributed limiter) and no-op on failure (a null store reads as a miss).
- `openStore(name, opts?)` (async) → a Blobs store, or `null` when Blobs isn't
  available. Passes explicit credentials when both a site ID and token resolve
  (`opts.siteID`/`opts.token` override `BLOBS_SITE_ID`/`NETLIFY_SITE_ID`/`SITE_ID`
  and `BLOBS_TOKEN`/`NETLIFY_API_TOKEN`/`NETLIFY_AUTH_TOKEN`); apps that bake in
  a default site ID pass it as `opts.siteID`. `opts.consistency` (default `strong`).
- `getTTLCached(store, key, { ttlMs?, now? })` / `setTTLCached(store, key, data,
  { now? })` — read/write a `{ at }`-stamped entry; reads past `ttlMs` (or a
  null store / malformed entry / read failure) resolve to `null`, writes are
  best-effort (`false` on a null store or failed write). Omit `ttlMs` to read
  without expiry.
- `blobKey(...parts)` → stable `|`-joined key (nullish parts blank).

**Handler** — `createHandler({ name, rateLimit, distributed, handle, onError })`.

**Anthropic (Claude) client** — hardened Messages-API call machinery,
consolidated from Surf-Tracker's non-streaming client (`lib/anthropic.js`) and
market-monitor's streaming client (`utils/anthropic.mjs`). Raw `fetch` with
`x-api-key` only (deliberately not the SDK — its env-based auth attached a
conflicting Authorization header inside Netlify Functions and 401'd), one
transient-error retry (429/529/5xx), host-tagged errors that never leak the
api key or the raw upstream body, and `.status`/`.retryAfter` tagging.
- `callAnthropic(opts)` (async) → concatenated text content. Non-streaming;
  the retry runs inside the caller's `timeoutMs` deadline budget. `opts`:
  `{ apiKey, model, system, userText | messages, maxTokens, timeoutMs,
  baseUrl?, thinking?, effort?, fetchImpl? }`.
- `openAnthropicStream(opts)` (async) → the ok `Response` (readable `.body`
  SSE). The retry only re-issues the initial POST — never mid-stream. Bound
  the whole request with `opts.signal` (e.g. `AbortSignal.timeout(...)`).
- `parseModelJson(text)` — first balanced JSON object out of prose/fences.
- `toBullets(v, maxChars)` — normalize a model value into capped bullets.
- `userFacingReason(e, detail)` — honest 429 "busy, wait Ns" message from the
  tagged `retryAfter`; `detail` otherwise.
- `normalizeEffort(value, def='low')` — validate an env-configured
  `output_config.effort` level (`low`…`max`).
- `ANTHROPIC_VERSION`, `ANTHROPIC_DEFAULT_MODEL` (+ `DEFAULT_MODEL` alias,
  Surf-Tracker's name) — Opus 4.8; pair with explicit `effort` to stay inside
  a synchronous function's time budget.

## Vendoring into a consumer

Consumer repos don't deploy `node_modules`; they pin this package by full
commit SHA and commit a generated copy under `netlify/functions/`, gated by a
CI drift check. The kit ships its own vendoring CLI (`jfs-netlify-kit-vendor`):

```json
"vendor:sync":  "jfs-netlify-kit-vendor --format esm --out netlify/functions/lib/netlify-kit.js",
"vendor:check": "jfs-netlify-kit-vendor --format esm --out netlify/functions/lib/netlify-kit.js --check"
```

Use `--format cjs` instead when the consumer's functions are CommonJS (it
emits a `module.exports` transform, e.g. market-monitor's
`netlify/functions/utils/netlify-kit.js`). The exported surface is derived
from `index.js`'s own `export` declarations — never a hand-maintained list.

## Test

```bash
npm test     # node test.mjs — node:test, no framework deps
```
