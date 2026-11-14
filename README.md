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

Pure ESM, and `index.js` **imports nothing at runtime** — a consumer's
vendored copy carries no dependency at all. The package's one `dependencies`
entry is `@jfs/vendor-cli` (with esbuild behind it), which only the
`jfs-netlify-kit-vendor` bin uses: the bin resolves the CLI from inside this
package, so this pin decides which generator every consumer vendors through.
The one optional runtime integration — Netlify Blobs for distributed rate
limiting and the TTL cache — is reached through a dynamic
`import('@netlify/blobs')` that degrades to a no-op / the in-memory limiter
when the package (or a configured store) isn't present.

## Compatibility superset

The sibling apps grew slightly different signatures for the same idea
(market-monitor's `jsonResponse(body, cacheControl, extraHeaders)` returns 200;
Surf-Tracker's `jsonResponse(statusCode, obj, opts)` takes an explicit status).
So apps can adopt the kit by **only changing import paths** — not call sites —
`jsonResponse` / `textResponse` detect the convention from their first argument
(a **number** ⇒ status-first form, anything else ⇒ body-first form). Since
0.8.0 the two JSON forms share one header **shape** (capitalized names,
`charset=utf-8` on the content-type) while keeping each form's original cache
semantics (body-first: no `Cache-Control` unless asked; status-first:
`no-store` by default); new code should prefer the unambiguous named forms
`jsonBodyResponse` / `jsonStatusResponse` — a bare numeric payload passed to
the `jsonResponse` overload dispatches as a **status code**, not a body. The
consolidated sources:

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

**API response headers** (0.11.0, NK-6) — `API_RESPONSE_HEADERS`:
`X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
'none'; frame-ancestors 'none'; sandbox`, `Referrer-Policy: no-referrer`.
Netlify never applies `netlify.toml`'s `[[headers]]` to a function's response,
so these ride on **every** shape the kit builds: every responder below, every
`createHandler` short-circuit (preflight, 405, 413, 414, 429, 500), whatever
`handle` / `onError` return, and every `toWebHandler` answer. A header the
response already sets is never overwritten (case-insensitive), so a function
with its own CSP stays the authority. `addApiHeaders(response)` applies them to
a hand-built Lambda-shaped response (returns a new object).

**Responses**
- `JSON_HEADERS` — `Content-Type: application/json; charset=utf-8` + CORS.
- `jsonBodyResponse(body, cacheControl?, extraHeaders?)` — 200, no
  `Cache-Control` unless asked (CDN TTLs are opt-in per call).
- `jsonStatusResponse(statusCode, obj, opts?)` — explicit status,
  `Cache-Control: no-store` by default (`opts.cacheControl` overrides).
- `jsonResponse(...)` — delegating overload over the two named forms above,
  dispatching on `typeof firstArg === 'number'` — see *Compatibility
  superset* (and its numeric-payload hazard there).
- `errorResponse(statusCode, error, extraHeaders?)` — `{ error }` body.
- `textResponse(statusCode, body, opts?)`.
- `ok`, `badRequest`, `notFound`, `methodNotAllowed`, `serverError`,
  `badGateway`, `upstreamError(status, err, extraHeaders?)` — named sugar.
- `createResponders({ cors? })` — the full helper set above as a configured
  bundle. Default (`cors: true`) is byte-identical to the module-level exports;
  `createResponders({ cors: false })` returns the same shapes with **zero
  `Access-Control-*` headers** — for endpoints that must stay unreadable to
  cross-origin scripts (per-query-billed upstream proxies, e.g. FlightCheck's
  AeroAPI/Maps functions, which previously re-implemented every helper plus a
  `stripCors()` scrubber). Status/body/content-type/`nosniff`/cache-control/
  extraHeaders behavior is unchanged; the status-first `jsonResponse` /
  `textResponse` forms still honor an explicit per-call `opts.corsOrigin`.
- `errorMessage(err, max=200)` — bounded stringification.
- `checkResponseSize(response, headers?)` — pre-read 502 guard from
  `content-length`. **Not a cap on its own** (FAM-8): a chunked upstream sends
  no length, passes it, and a following `response.text()` / `.json()` buffers
  everything. `readTextCapped(res, maxBytes = MAX_RESPONSE_BYTES)` — streamed
  UTF-8 read that throws `.tooLarge` past the cap; since 0.11.0 an omitted cap
  means 5 MB (it used to mean none) and a cap that is not a non-negative finite
  number throws `TypeError`. `readJsonCapped(res, maxBytes?)` — the capped
  `response.json()`; a non-JSON body throws `.notJson`. `MAX_RESPONSE_BYTES`
  (5 MB).

**Validation** — `SYMBOL_RE`, `FRED_ID_RE`, `UNIX_TS_RE`, `isValidDate`,
`isValidTimestamp`.

**SSRF guards** — `parseSafeHttpsUrl(input)` → `{ ok, url, error }` (HTTPS only,
no port/credentials, and no IP literals — including non-dotted-decimal encodings
like `2130706433` / `0x7f000001` / `0177.0.0.1` — no `localhost`/`.internal`/
`.local`/`.lan`, trailing dot normalized), `isSafeHttpsUrl`,
`resolveHostIsPublic(hostname)` (fail-closed DNS check that blocks the
`169.254.169.254` metadata trick), `isPrivateIPv4` / `isPrivateIPv6` /
`isPrivateAddress`.

**Guarded article fetch** (0.9.0) — the shared halves of the family's
article-reader extract functions: `assertSafePublicUrl(candidate)` (both SSRF
guards on one URL, throws or returns the normalized string),
`fetchHtmlGuarded(startUrl, { headers, timeoutMs, maxBytes, maxRedirects })`
(manual redirect handling with BOTH guards re-run on every hop **and on
`startUrl` itself** since 0.10.0 — the guard is idempotent, so a caller that
already checked pays one more DNS lookup (the kit keeps no cache of its own)
rather than owning the contract;
byte-capped read; never hand a URL to a library that follows redirects itself
— fetch here, give it HTML), `raceProxyHtml(target, proxies, parse, opts)`
(race public CORS proxies, status/size/shape-checked, first result the
caller's `parse(html, target)` accepts wins; rejects with `AggregateError`
when all fail). Since 0.10.0 `raceProxyHtml` also runs the string-level guard
on `target` before building any proxy URL — it is a caller-supplied URL going
to a third party's egress — and refuses with a rejected promise.

**Retry** — `fetchWithRetry(url, init, opts)` (exp backoff + full jitter;
retries network errors + 502/503/504, 429 only with `retryOn429`; a
`Retry-After` header on a retryable response sets the delay — capped at
`opts.capMs`, never negative, jittered backoff when absent/unparseable (a
value with no letter in it is never read as an HTTP-date, so `1.5` and `-5`
can't parse as past dates and collapse the backoff to zero);
injectable `fetchFn`/`sleepFn`/`rng`), `RETRYABLE_STATUSES`.
- `opts.retries: 0` performs **exactly one attempt** (no backoff machinery),
  and `opts.attemptTimeoutMs` gives **each attempt its own AbortSignal
  deadline** — distinct from an overall budget passed as `init.signal` (e.g.
  `AbortSignal.timeout(...)`, which spans all attempts and aborts terminally).
  A fired per-attempt deadline throws a retryable Error tagged
  `name: 'TimeoutError'` / `.timedOut = true` (with `retries: 0` it surfaces
  immediately); a caller-signal abort stays terminal. Together they cover the
  billed-upstream shape (never retry a per-query-billed request, but bound the
  one attempt's wait for its headers — FlightCheck's `fetchWithTimeout`), while
  omitting `attemptTimeoutMs` leaves existing callers byte-identical.
  **The per-attempt deadline ends when `fetch` resolves — at the response
  headers, not the body.** Its timer is cleared once the attempt returns, and
  with `attemptTimeoutMs` set the request carries the kit's own signal, so an
  `init.signal` budget reaches it only until the headers arrive: a body that
  stalls after them is bounded by neither. (Without `attemptTimeoutMs`, an
  `init.signal` budget does cover the body.) A caller that reads the body under
  a deadline ties the request to a whole-request signal through `fetchFn` —
  `fetchFn: (u, i) => fetch(u, { ...i, signal: i?.signal ? AbortSignal.any([i.signal, budget]) : budget })`,
  the pattern Weather's nowcast/airnow and Art-Gallery-'s proxy already use.

**Rate limiting**

> **The in-memory limiter is per container and is not a cost control
> (FAM-3).** Netlify spreads concurrent requests over containers: measured
> 2026-09-26, 90 parallel requests to a 60/min endpoint drew zero 429s. It
> slows a single sequential client and nothing else. An endpoint that spends
> a key, a quota or money wants the distributed limiter **and** a global
> `spendDailyBudget` on the upstream it calls.

- `checkRateLimit(event, max, windowMs, opts?)` / `checkRateLimitDistributed(...)`
  (async, Netlify Blobs with in-memory fallback) — return a ready 429/414
  response or `null`. `opts.cors: false` strips the `Access-Control-*` headers
  off the 429/414 shapes (matching `createResponders`); `Retry-After` and
  `nosniff` survive. `MAX_QUERY_LENGTH`.
  - `opts.namespace` (0.11.0, NK-5) — `[A-Za-z0-9_.-]{1,64}`; the bucket key
    becomes `rl:${namespace}:${ip}:${window}`. Omitted → the old shared
    `rl:${ip}:${window}`, the same bucket for every endpoint that omits it.
  - The Blobs store is opened on **every** call (0.11.0): a modern function's
    Blobs token is per invocation, and the old container-lifetime cache kept a
    warm instance on the first invocation's token after it lapsed.
  - `_resetStoreCache()` / `_setBlobsModuleForTest(mod)` test seams.
- `spendDailyBudget(name, max, { now?, cost?, store?, failOpen?, retries? })`
  (async, 0.11.0) — a **global** per-UTC-day ceiling for a billed or keyed
  upstream, counted across every caller and container with the limiter's
  compare-and-set; resolves `{ ok, used, max, resetAt, reason? }`. Fails
  **closed** (`reason: 'unavailable'`) when Blobs is down unless `failOpen`.
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

**Handler** — `createHandler({ name, methods, maxBodyBytes, rateLimit,
distributed, cors, handle, onError })`.

- `distributed: true` namespaces its bucket by `rateLimit.namespace`, else by
  `name` (0.11.0, NK-5), so two endpoints no longer spend one bucket; give
  them the same `namespace` to share one on purpose. The namespace must be a
  valid key part, checked when the handler is built.
- Whatever `handle` / `onError` return gets the API response headers where
  absent (0.11.0).

- `methods` (0.10.0, optional) — array of allowed HTTP methods, e.g.
  `['GET', 'HEAD']`, matched case-insensitively. Anything else is refused with
  a 405 carrying an `Allow` header listing exactly these methods, **before**
  the limiter runs, so a rejected verb never spends a caller's rate-limit
  budget. The OPTIONS short-circuit is unchanged and still answers preflights
  whether or not OPTIONS is in the list. Omitted → no restriction.
- `maxBodyBytes` (0.10.0, optional) — cap on the request body. A larger
  `event.body` is refused with a 413 before `handle` runs, so a handler never
  parses an unbounded string; a base64-transported body is measured **decoded**
  (its string form is ~4/3 the payload). Omitted → uncapped.
- `cors: false` (default `true`) makes every response the wrapper itself emits
  CORS-free: the OPTIONS short-circuit becomes a bare 204, and the 405, the
  413, the limiter's 429/414 plus the catch-all 500 use the no-CORS shapes —
  pair it with `createResponders({ cors: false })` inside `handle` for a fully
  CORS-free endpoint.

**Modern (web-Request) functions** (0.11.0) — `toWebHandler(handler, { cors? })`
serves any Lambda-shaped handler (createHandler's included) as a modern
function's default export: `export default toWebHandler(handler)`. Only a
modern function gets a per-invocation Blobs context (so the distributed limiter
and `spendDailyBudget` work) and only a modern function can carry an edge
`config.rateLimit`. It replaces five drifted consumer adapters and is
FlightCheck's `toV2`, in production since 2026-09-23: the limiter keys on the
runtime's `context.ip` and a caller-sent `x-nf-client-connection-ip` is deleted
first (NK-2: one consumer's copy kept it, so a rotating spoofed value minted a
fresh bucket per request); query and header maps are own data (`?constructor=1`
is a value, not a prototype lookup); a repeated key joins with `, `; `rawQuery`
is filled; binary bodies arrive base64; a throw is a bare no-store
`500 {"error":"Internal error"}` that says nothing of the error; HEAD and
101/204/205/304 send no body; `multiValueHeaders` win; every answer carries the
API headers. Its halves are exported as `toLambdaEvent(request, context)` and
`toWebResponse(result, method)`.

**Anthropic (Claude) client — retained, unused since 2026-09-30.** No consumer
calls it: Surf-Tracker removed its AI summaries and market-monitor its Claude
fallback that day, so this section documents shipped surface, not a live
integration. The exception is `userFacingReason`, which reads only the
`.status`/`.retryAfter` tags and which market-monitor's Gemini `analyze.mjs`
still uses. Removal is a deferred minor release (see MAINTENANCE.md); until then
every consumer's copy carries it. Hardened Messages-API call machinery,
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
  the whole request with `opts.signal` (e.g. `AbortSignal.timeout(...)`);
  since 0.10.0 an omitted signal defaults to `AbortSignal.timeout(25_000)`,
  the same ceiling `callAnthropic` applies to its own budget, so a stalled
  SSE can no longer run to the platform's invocation limit.
- `parseModelJson(text)` — first balanced JSON object out of prose/fences.
- `toBullets(v, maxChars)` — normalize a model value into capped bullets.
- `userFacingReason(e, detail)` — honest 429 "busy, wait Ns" message from the
  tagged `retryAfter`, and a plain "unavailable" line for a 5xx/529; `detail`
  otherwise. Provider-neutral in practice — any status-tagged error works.
- `normalizeEffort(value, def='low')` — validate an env-configured
  `output_config.effort` level (`low`…`max`).
- `ANTHROPIC_VERSION`, `DEFAULT_MODEL` — the API-version header and the default
  model id; pair the model with an explicit `effort` to stay inside a synchronous
  function's time budget.

## Vendoring into a consumer

Consumer repos don't deploy `node_modules`; they pin this package by full
commit SHA and commit a generated copy under `netlify/functions/`, gated by a
CI drift check. The kit ships its own vendoring CLI (`jfs-netlify-kit-vendor`):

```json
"vendor:sync":  "jfs-netlify-kit-vendor --format esm --out netlify/functions/lib/netlify-kit.js",
"vendor:check": "jfs-netlify-kit-vendor --format esm --out netlify/functions/lib/netlify-kit.js --check"
```

Use `--format cjs` instead when the consumer's functions are CommonJS (it
emits a `module.exports` transform, e.g. Surf-Tracker's
`netlify/functions/lib/netlify-kit.js`). The exported surface is derived
from `index.js`'s own `export` declarations — never a hand-maintained list.

## Test

```bash
npm test     # node --test test.mjs test-vendor.mjs test-repo.mjs — node:test, no framework deps
```

`test.mjs` is the API suite, `test-vendor.mjs` drives the pinned vendoring
CLI over this kit's own source (esm — full and `--pick`-narrowed — global and
cjs, with every refusal matched on its stderr reason), and `test-repo.mjs`
holds this repository's cross-file invariants (every export documented here
and imported by the suite, the shipped `files` under CI's version guard, the
monthly bump running the same checks as a pull request). The suite needs no
network access: the guarded fetch's DNS half is answered from a table, and
the one real-resolver case looks up `localhost`.
