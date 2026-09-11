# @jfs/netlify-kit — working notes for Claude

Shared, dependency-free Netlify Functions primitives (CORS + preflight,
JSON/text/error responses, capped body reads — the response half is
`readTextCapped`, the REQUEST half is `createHandler`'s `maxBodyBytes`, which
the description claimed for a release before it existed — input validation,
SSRF guards, the guarded article fetch behind the family's reader extract
functions — per-hop-revalidated redirects + the CORS-proxy race —
retry-with-backoff fetch, per-IP rate limiting, a Blobs store
opener + short-TTL cache, a `createHandler` boundary, and a hardened
Anthropic Messages-API client) extracted from the JFS family of buildless
static sites. Consumers vendor this kit via its own CLI rather than
installing it at runtime, so a change here reaches an app only once that
app bumps its pin and re-runs `vendor:sync`.

## The guards that hold 0.10.0's hardening

Four of these landed because a reviewer walked the file, not because anything
broke in production — which is the only time to make them, since a consumer
picks them up on a pin bump and can't see the diff.

- **`fetchHtmlGuarded` validates its own `startUrl`.** It used to guard only
  the hops it DISCOVERED, documenting the start URL as the caller's job — so
  the one URL an attacker actually supplies was the only one the function took
  on trust, and a consumer that forgot had no guard at all. `assertSafePublicUrl`
  is idempotent, so a caller that already checked pays one cached DNS lookup.
  The call sits BEFORE the AbortController, so a refusal leaves no timer behind.
- **`raceProxyHtml` string-guards its `target`.** The proxies fetch from their
  own egress, which is why the resolved-IP half doesn't apply — but a
  caller-supplied `file:`/`http:`/internal-host target still went straight into
  a third party's fetch. Refusal is a REJECTED PROMISE, never a synchronous
  throw: every other path returns a promise, and a `.catch()`-style caller
  would never see a throw that happened before the chain was built.
  **This is what makes `isSafeHttpsUrl` load-bearing** — it had zero consumers
  family-wide and read like a retirement candidate. It is an internal caller
  now; leave it exported.
- **`Retry-After` needs a letter before it can be a date.** `Date.parse` in V8
  reads `1.5` as Jan 2001 and `-5` as May 2001 — both PAST, so the delay
  clamps to 0 and every retry fires at once, which is the storm the header
  exists to prevent. Same guard, same reason, as @jfs/fetch-kit's
  `parseRetryAfter`; the two twins should keep agreeing.
- **`openAnthropicStream` defaults its signal** to
  `AbortSignal.timeout(DEFAULT_ANTHROPIC_TIMEOUT_MS)` — the ceiling
  `callAnthropic` already applied to itself. It was the one entry point with no
  deadline of its own, so an upstream that accepted the POST and then stalled
  mid-SSE ran to the platform's invocation limit.
- **`createHandler` gained `methods` and `maxBodyBytes`**, both optional and
  both undefined by default, so every existing consumer's behaviour is
  byte-identical. Two orderings are deliberate: the 405 runs BEFORE the limiter
  (a rejected verb must not spend a caller's rate-limit budget) and the 413
  runs AFTER it (a flood of oversized bodies should still be rate-limited). A
  base64-transported body is measured DECODED — its string form is ~4/3 the
  payload, so measuring the string rejects uploads a third under the cap.

Not done, and worth not "fixing" later: `looksLikeNumericIp`'s short-form IPv4
hole (`127.1`, `10.0.1`) is not reachable. `parseSafeHttpsUrl` runs `new URL()`
first, and the WHATWG parser normalizes every numeric host form it accepts to
dotted-decimal (`127.1` → `127.0.0.1`, caught by the dotted-quad regex) and
refuses the rest (`foo.123` → `invalid-url`). A test pins that behaviour,
since it belongs to the URL parser rather than to anything in this file.

## Lint

`npm run lint` (ESLint flat config, `eslint.config.mjs`); CI runs it. Every
APP in the family already linted; none of the kits did — which left the
widest-blast-radius code with no second reader, since a bug here lands in
every consumer's vendored copy as bundler output nobody reads line by line.

Three findings, all fixed rather than silenced:

- Two dead initializers in `checkRateLimitDistributed` — `let data = null` /
  `let etag = null` are declared INSIDE the retry loop and reassigned in the
  `try`, whose `catch` returns, so no path ever reads the `null`. Now bare
  `let`. Not a bug; the point of fixing rather than disabling
  `no-useless-assignment` is that the rule DOES catch real
  computed-then-overwritten values, and this kit is where that matters.
- A `fakeAnthropicResponse({ ok })` parameter in the suite shadowing the
  kit's own imported `ok()` responder. Destructured as `okFlag` — the emitted
  property has to stay `ok` to mirror a real `Response`, so the fake's API is
  unchanged.

Two rules are off, both because they fire on what this kit is FOR:
`no-control-regex` (the SSRF and header guards strip control characters) and
`no-regex-spaces` (the vendor suite matches a known two-space indent in
generated output).

Re-vendoring this kit does not need a consumer site version bump — it is
server-only everywhere it is used — but it IS version-guarded here, so an
`index.js` change still needs a bump in this repo.

<!-- jfs-family-conventions:start — managed by jfs-claude-md-sync; edit family/family-conventions.md in @jfs/vendor-cli -->

## Family conventions

These conventions are identical across every repo in the @jfs family. The
section is managed by `jfs-claude-md-sync` (@jfs/vendor-cli) and checked by
family CI — edit `family/family-conventions.md` in the vendor-cli repo, not
here.

### Pull requests

Open pull requests **ready for review — never as drafts.** This applies to
PRs opened by automated Claude Code sessions too: some hosted environments
default to creating drafts, so mark the PR ready as part of opening it
rather than leaving it for a follow-up.

### Session autonomy

These repos are worked by automated Claude Code sessions with the owner
away, so a session that stops to ask has usually failed at the task. Every
repo's `.claude/settings.json` carries the family allowlist and
`acceptEdits`, so the ordinary tools of the job — reads, edits, git, the
npm scripts, the GitHub API — run without a permission prompt. Use them.

Ask a follow-up question only when proceeding either way would be wrong: a
genuine product decision, or an ambiguity whose two readings produce
materially different work. Routine calls — naming, file placement, patch
vs. minor, which helper to extract — belong to the session: pick the
obvious one, say so in the PR body, and keep going.

Merging is the session's job too. Open the PR ready for review, dispatch
CI, and squash-merge it once that run is green on the head commit. A
finished, green PR left open for a human to click is the outcome this
section exists to prevent. The gate itself does not move: green CI on the
head commit is still the precondition for every merge, and a red run means
fix it and re-dispatch — never merge anyway, and never park it and ask.

### Kit extraction bar

Extract shared code into a NEW `@jfs/*` kit only when both hold: a third
repo needs the same code, AND drift between the existing copies has already
caused a real bug or a manual reconciliation. Until then, copy-pasting
between two repos is cheaper than a new repo's permanent CI, pin, and
vendoring overhead. Prefer growing an existing kit over minting a new one.

### CI on automated pull requests

A push from an automated session does not fire `pull_request` workflows, so
a session-opened PR starts with no CI run of its own. Every repo's CI
workflow carries `workflow_dispatch:` so the session can run the same checks
by hand: dispatch CI on the branch, and do not merge until that run is green
on the head commit. A merge with no CI run defeats every gate the family
maintains.

### Look & feel baseline

These are mechanical UI rules, not a shared design system — each app keeps
its own look. They exist because each was violated in at least one family
repo and shipped as a real defect.

1. `env(safe-area-inset-*)` and `viewport-fit=cover` travel together — using
   one without the other is a bug (the insets resolve to 0 without it, and
   `black-translucent` status bars need it).
2. Every app has a global `:focus-visible` rule and sets
   `-webkit-tap-highlight-color` deliberately.
3. The `theme-color` meta, the manifest `theme_color`, the manifest
   `background_color`, and the app's `--bg` all agree (with a dark variant
   where the app has a light mode).
4. The version badge lives in the header and is rendered from build config,
   never hand-typed in HTML.
5. Webfonts are either self-hosted (subset, preloaded, `font-display: swap`)
   or absent — a font-family the page doesn't load must not be named first
   in a stack.

### Service-worker updates

A new build is never applied under the reader mid-session: no reload, no
swap of the controlling worker while a page is open. The worker registers,
the page shows a "new version" pill, and the new build takes over on a
gesture (the pill) or on the next launch. Two mechanisms satisfy that and
each app picks ONE: a worker that WAITS (no `skipWaiting()` in install; the
pill posts `SKIP_WAITING` and reloads on `controllerchange`) or a worker that
activates on install but never `clients.claim()`s (the pill just reloads).
Never mix them — a pill that posts `SKIP_WAITING` at a worker that already
activated has nothing to wait for and strands on "Updating…", which shipped
once.

### Dependencies

Every npm repo carries `.github/dependabot.yml` (weekly npm, minor and patch
grouped into one PR; monthly `github-actions`) and calls the family's
`dependabot-merge.yml` reusable workflow, which squash-merges a Dependabot PR
once the repo's CI is green on it and every bump in it is minor or patch. A
MAJOR bump is left open for a session or a human. Dependabot never touches
the `@jfs/*` git pins; the weekly kit-pin bump owns those. First-party
`actions/*` are referenced by major tag; every other action is pinned by
full SHA.

<!-- jfs-family-conventions:end -->
