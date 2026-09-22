# Maintaining @jfs/netlify-kit

This kit ships no site, runs no deploy and calls no upstream on its own. Everything
it produces reaches the world as a generated copy inside eight other repos' function
directories, so maintenance here turns on three things a green suite says nothing
about: whether the weekly pin bump is landing (it is not — six runs, six failures,
never once green; the pin is current only because a session opened the bump's PR by
hand on 2026-09-22), whether the consumers have actually re-vendored the code
that was tagged, and whether the figures this file pins on somebody else's behalf — a
model id, an API version header, a timeout sized against a platform ceiling — are
still true.

## What runs by itself

| Automation | Fires | Lands by itself | Leaves for a session | How a failure would be noticed |
| --- | --- | --- | --- | --- |
| `.github/workflows/test.yml` → the family's `family-ci.yml@main` (`verify-kit-pins: true`, `install-command: npm ci`, `prod-audit: true`, `maintenance-check: true`, `version-guard-paths: index.js bin`, `run:` the three gate commands below) | `push` to `main`, every `pull_request`, `workflow_dispatch` | — it *is* the gate | nothing | red on the PR or the commit. The one automation here whose failure appears where somebody is already looking. |
| `.github/workflows/kit-pin-bump.yml` (`41 6 * * 1` — Mondays 06:41 UTC, which GitHub's scheduler runs a few minutes late) + dispatch | weekly | *intended*: the one `@jfs` pin, `npm install` so the lockfile follows, the CLAUDE.md conventions block, the PR, the squash-merge | *today*: all of it | **nothing, and it has never succeeded.** See below. |
| `.github/workflows/release.yml` (`workflow_run` on `Test` completed, `branches: [main]`) + dispatch | CI green on `main` | the `v<version>` tag and its GitHub release | nothing | **nothing** — but it demonstrably works here: 35 runs by 2026-09-22, and `v0.10.0` points at `f4d2347`, the commit that set the version (later commits on `main` left it at 0.10.0, so each re-run was a correct no-op). |
| `.github/workflows/dependabot-merge.yml` (`workflow_run` on `Test` completed) + `.github/dependabot.yml` (npm weekly Tuesday, minor+patch grouped, limit 5; `github-actions` monthly) | on each CI completion | every minor/patch bump, squash-merged on green — it landed #37 on 2026-09-08 and #41 on 2026-09-22 | **every major**, and any PR body it cannot parse | a PR sits open. Nobody is told. |

There is nothing else: no deploy, no smoke test, no cron but the bump, and no monitor
in this repository. The only thing that will ever notice the bump failing is the
family liveness check in vendor-cli — scheduled Mondays 08:10 UTC, deliberately ~90
minutes after the bump so it observes that week's run, opening one rolling issue in
the hub rather than a notification in thirteen repos. It is on vendor-cli's `main`
(#58), and it is **not watching yet**: its first run, dispatched 2026-09-22, exited 2
("could not check") because the `FAMILY_READ_TOKEN` secret it needs does not exist,
and opened vendor-cli #60 saying so. Only the owner can create that PAT. Until then a
failed scheduled run here is still seen by nobody.

### The weekly bump has never landed by itself

Verified 2026-09-22 against this repo's own Actions history. `kit-pin-bump.yml` has
**six** runs — five `schedule` (2026-08-24, 08-31, 09-07, 09-14, 09-21) and one
`workflow_dispatch` (2026-09-22 21:53 UTC) — and every one is a `failure`. Two
unrelated causes:

- **Runs 1–3** died on `npm error Missing script: "vendor:sync"` — read from run 3's
  log — at the *Re-vendor from the bumped pins* step, having already resolved the pin
  (`@jfs/vendor-cli: 6ed7817 -> 276274b`). The caller passed only `check-command`, so
  the reusable workflow's defaults ran `npm run vendor:sync` and
  `npm run version:stamp`, which a kit does not have. Fixed by #35 on 2026-09-08
  (`vendor-sync-command: npm install`, `version-bump-command: ''`).
- **Runs 4–6** get all the way through — resolve, re-install, run the check command
  against the bumped tree, push `auto/kit-pin-bump` — and fail at *Open a pull request
  if anything changed*, with
  `GitHub Actions is not permitted to create or approve pull requests.` The merge step
  is skipped. That is a **per-repo setting**, not a code bug: *Settings → Actions →
  General → Workflow permissions*, the "Allow GitHub Actions to create and approve
  pull requests" box. Run 6 was dispatched to check whether it had been flipped, and
  failed the same way; the same failure is live in pwa-kit and fetch-kit and nowhere
  else in the family.

So each Monday the automation does correct, validated work and delivers it nowhere.
On 2026-09-22 a session opened the PR by hand from the branch run 6 pushed (#42,
`@jfs/vendor-cli` `276274b` (0.21.3) → `3e9e174` (0.21.7), `package.json` and
`package-lock.json` only) and merged it on green CI; the branch was deleted with the
merge. The pin is therefore current today — and that says nothing about next week.

Two things make this worse here than in an app. First, `bin/vendor.mjs` is a shim
that runs whatever `@jfs/vendor-cli` resolves from **inside this package**, so this
one pin decides which generator all eight consumers' `jfs-netlify-kit-vendor`
executes — a stale pin here means every consumer re-vendors this kit through a stale
generator. Second, CLAUDE.md already records this exact class of failure once (the
pin sat at 0.8.0 while the family shipped 0.17.0, closed by #29), and it recurred by
a different mechanism, because a fix is not a monitor.

Until the setting is changed, the bump is a manual job: after a Monday run, open a PR
from `auto/kit-pin-bump` (the run has already validated it), dispatch `test.yml` on
the branch, and merge on green — or, if the branch is stale against `main`, run
`npm run kit-pins:bump` locally, then the gate, then a PR by hand.

## The gate

There is no aggregate `npm run check` in this repo, unlike the apps. The gate is the
three commands `test.yml` hands to family-ci, in this order, and a session runs
exactly these before pushing:

```
node --check index.js
npm run lint
npm test
```

| Step | What it is |
| --- | --- |
| `node --check index.js` | parses the one shipped module. Parsing, which is not analysis. |
| `npm run lint` | `eslint .` over `index.js`, `bin/**/*.mjs` and `*.mjs` with the Node globals plus the web-platform ones a function really has, and deliberately not the DOM-only ones |
| `npm test` | `node --test test.mjs test-vendor.mjs test-repo.mjs` — **117 cases** (104 + 9 + 4), all green on 2026-09-22. `test-repo.mjs` holds this repo's cross-file invariants; see below |

`kit-pin-bump.yml`'s `check-command` is exactly these three lines, and `test-repo.mjs`
fails if the two lists ever differ — until 2026-09-22 the bump skipped `npm run lint`,
so a bumped tree was validated by a weaker gate than a pull request.

Four properties of that chain matter more than the list.

**`test-vendor.mjs` drives the pinned generator over this kit's own source**, in the
esm, global and cjs formats, and asserts the emitted surface is all 57 of `index.js`'s
exports. That is why a vendor-cli pin bump is validated here rather than in eight
consumers' `vendor:sync`, and why the bump's own check step passing (it did, against
0.21.6 and again against 0.21.7) is real evidence and not a formality.

**The suite needs no network, and that is recent.** Until 2026-09-22 the
guarded-article-fetch happy paths resolved `example.com` through the real system
resolver (`resolveHostIsPublic` is a live `dns.lookup`, and since 0.10.0
`fetchHtmlGuarded` validates its start URL the same way it validates a hop). Measured
with every lookup forced to fail: five of those tests went red reading like a code
bug, and the oversized-body test passed for the wrong reason — it asserted only that
the call rejected, and the DNS refusal satisfied it. The section now answers
`dns.lookup` from a table (`withDns` in `test.mjs`), which also let the suite drive
the answers a live resolver will not give on demand. That exposed a real gap: the
resolved-IP check on a **redirect hop** — the one that stops a public page 302-ing to
a name whose A record is `169.254.169.254` — was untested; deleting it left all 110
cases green. Three new tests pin it, the start-URL half, and the fail-closed DNS
ladder, and each was checked against a mutation of `index.js` that removes what it
guards. The one real-resolver case left is `localhost is private`, which reads the
hosts file, not the network.

**family-ci adds four checks beyond the three commands**: the kit-pin SHA pre-flight
(`verify-kit-pins: true`), the shipped-dependency audit (`prod-audit: true`, on since
2026-09-22), the CLAUDE.md family-conventions check (on by default), and
`maintenance-check: true`, which verifies both halves of this file. The pre-flight and
the two doc checks run from a checkout of vendor-cli's `main`, not this repo's pin, so
"green locally, red in CI" is most often one of them rather than anything in
`index.js` — an edit to vendor-cli's canonical text reddens this repo with no commit
in it. Locally they are `node <vendor-cli>/bin/check-kit-pins.mjs`,
`node <vendor-cli>/bin/claude-md-sync.mjs --check`,
`node <vendor-cli>/bin/maintenance-sync.mjs --check` and
`node <vendor-cli>/tools/maintenance-doc-check.mjs`, from a vendor-cli checkout.

**The version guard only fires on a real `pull_request` event.** family-ci's
`version-bump` job carries `if: github.event_name == 'pull_request'`, so a
`workflow_dispatch` run on a session branch skips it entirely — and a PR opened with
the default token fires no `pull_request` run at all. For a session-pushed change to
`index.js` or `bin`, nothing checks that the version moved. Check it by hand; the
whole point of the guard is that consumers pin by SHA and releases tag by version, so
an unbumped shipped change puts two different SHAs under one version label. The fix
is family-ci's (the job's `if:`), so it is recorded for vendor-cli, not changed here.

**CI installs with `npm ci`, and audits what ships.** `test.yml` passes
`install-command: npm ci` (family-ci defaults to `npm install`), so a
`package-lock.json` out of step with `package.json` fails the PR instead of the
Monday bump, which installs with `npm ci`. And it passes `prod-audit: true`, because
`dependencies` is not empty: `@jfs/vendor-cli` sits there on purpose and pulls
`esbuild` (0.28.2 under vendor-cli 0.21.7) and its platform binary into every tree
that installs this kit. Both went on 2026-09-22; `npm audit --omit=dev
--audit-level=high` reported 0 vulnerabilities that day.

## This repo's cross-file invariants

| Pair | Gated by | What breaks on drift |
| --- | --- | --- |
| `index.js`'s 57 exports ↔ the emitted esm / global / cjs surface | **gated** — `test-vendor.mjs` derives the surface from the source and asserts every name is exposed | a consumer imports a name the generated copy does not carry: a runtime `ReferenceError` in a deployed function |
| `index.js`'s exports ↔ `test.mjs`'s `import { … } from './index.js'` list | **gated** since 2026-09-22 — `test-repo.mjs`. A floor, not coverage: being imported is not being tested | an export ships with no test and no signal |
| `package.json`'s `files: ["index.js", "bin"]` ↔ `test.yml`'s `version-guard-paths: index.js bin`, and `main` / `exports` / `bin` inside `files` | **gated** since 2026-09-22 — `test-repo.mjs`, set equality in both directions | add a third shipped file to `files` and it sits outside the version guard; a shipped change lands unbumped |
| `package.json` `version` ↔ the provenance header of eight consumers' generated copies ↔ the `v<version>` tag | half gated: family-ci's version guard (PRs only) and `release.yml` | the tag and the header disagree with what shipped |
| `_retryAfterMs` here ↔ `parseRetryAfter` in `@jfs/fetch-kit` | **prose only, and cross-repo** — each comment names the other | the twins drift on the guard that stops a retry storm. They *deliberately* differ: fetch-kit caps at its own constant and clamps to zero, this one returns the raw delta and lets `opts.capMs` cap it. Do not unify them |
| `createResponders({ cors: false })` ↔ `createHandler({ cors: false })` | **gated** — the 429/414 case in `test.mjs` | one path keeps emitting `Access-Control-*` and an endpoint meant to be unreadable cross-origin is readable |
| `README.md`'s `## API` section ↔ the actual export surface | **gated** since 2026-09-22 — `test-repo.mjs` fails on an export the section never names in backticks. Names only: what the README *says* about each export is still prose | an export nobody can discover from the docs |
| `package.json`'s `description` and the README's prose ↔ what the code does | **prose only** | it has drifted in the direction that matters, twice: CLAUDE.md records the description claiming capped *request* body reads for a release before `maxBodyBytes` existed, and until 2026-09-22 the README gave the test command as `node test.mjs` (skipping the vendor suite), called the package "dependency-free at install time" beside a real `dependencies` entry, and named market-monitor's ESM copy as the CJS example |
| `engines.node: ">=18"` ↔ what actually runs it (family-ci's default Node 22; no `.nvmrc` in this repo) ↔ the consumers' function runtimes | **prose only** | the declared floor is never executed by anything, here or downstream |
| `kit-pin-bump.yml`'s `check-command` ↔ `test.yml`'s `run` block | **gated** since 2026-09-22 — `test-repo.mjs` requires the same command lines | the two diverge — as they did until that day, when the bump skipped `npm run lint` — and a bump is validated by a weaker gate than a PR is |

There is **no `@jfs-sanitizer-policy:` region in `index.js`** (measured: zero), so the
vendoring generator's policy gate is a no-op for this kit. Do not add a marker
expecting a check to arm itself; the gate belongs to news-kit.

**The mechanization backlog.** Three invariants went into `test-repo.mjs` on
2026-09-22, covering four rows of the table above — `files` ↔ the version guard (with
`main` / `exports` / `bin` inside `files`), the bump's check-command ↔ CI's `run`, and
the export surface ↔ both the README's API section and `test.mjs`'s imports — each a
small read of two files that throws rather than passes when it cannot find what it
compares. What is left: the fetch-kit `Retry-After` twin, which nothing local can
gate (it needs a family-level check, or it stays a comment); `engines.node` against a
runtime nothing here executes (see the deferred table — there is nothing to compare
it to until a `.nvmrc` exists); and the README's *prose* about each export, which no
test can read.

## What nothing watches

| Thing | Whose it is | How it fails | Watched by |
| --- | --- | --- | --- |
| `DEFAULT_MODEL = 'claude-opus-4-8'` | Anthropic's model roster | silently, until the model is retired and every call 4xx's | nothing but the monthly sweep. 2026-09-22: listed **Active** in the Claude API model reference (a cached copy dated 2026-06-24, not a live probe — this repo holds no key and calls no endpoint), with two newer Opus generations above it |
| `ANTHROPIC_VERSION = '2023-06-01'` | Anthropic's API versioning | silently — a dropped version answers with an error the consumer renders as degraded mode | nothing but the monthly sweep. 2026-09-22: still the header every example in the same reference sends |
| `DEFAULT_ANTHROPIC_TIMEOUT_MS = 25_000` | Netlify's synchronous-function ceiling (~26 s), which the comment sizes it against | silently: if the platform lowers the ceiling, this default stops being the binding limit and a stalled SSE runs to the invocation limit again | nothing |
| The public CORS proxies `raceProxyHtml` races | third parties | loudly per attempt, silently in aggregate | nothing here. The proxy **list** lives in each consumer; only the racing lives in this kit |
| Whether the consumers have re-vendored | the consumers | silently | nothing. See below |

`DEFAULT_MODEL` is live, not decorative: Surf-Tracker's `resolveModel()` (in
`netlify/functions/lib/ai-view.js`, used by its `summarize` and `summary-chat`
functions) falls back to this kit's constant when `VIEW_SUMMARY_MODEL` and
`SUMMARY_MODEL` are both unset (re-read on 2026-09-22: `resolveModel()` still ends in
`|| DEFAULT_MODEL`). market-monitor's `analyze.mjs` names its own model instead. So a
deprecation announcement that nobody here reads takes out one consumer's two AI
endpoints, and the change would be made in this file. Moving the default to a newer
model is **not** a maintenance edit: it changes the tier and the bill of every
consumer that leans on it, and a newer Opus can reject request shapes this one
accepts (thinking and `tool_choice` rules differ between generations) — so it is a
product decision for the owner, taken with Surf-Tracker's summary prompts in hand.

**"Green CI is not delivered" has a kit-specific shape: the tag is not the delivery,
the re-vendor is.** Until 2026-09-22 `v0.10.0` was tagged and seven consumers pinned
`f4d2347` while **JFS-Sports pinned `9a5a74e`**, four commits and one minor version
behind, because its own weekly bump was broken for an unrelated reason — so the
0.10.0 `Retry-After` parse fix (the one that stops a `1.5` or `-5` header collapsing
the backoff to zero and firing every retry at once) was written, tested, tagged, and
not running in the one consumer that calls `fetchWithRetry` fourteen times. That
closed the same day: JFS-Sports' fixed bump merged (its #720) and pins `eb93e04`,
whose `index.js` is 0.10.0's byte for byte. Checked on each sibling's `origin/main`
that day: all eight consumers' generated copies carry the `v0.10.0` provenance header
and the 0.10.0 body. Nothing in this repository can see that. The check is a grep
across the siblings' `package.json` for the `@jfs/netlify-kit` pin, plus the first
line of each generated copy, and it belongs in the monthly sweep.

Also not this repo's to fix, but visible in every one of its bump runs (run 6
included): `peter-evans/create-pull-request@84ae59a` inside the shared workflow
targets Node 20, and the runner warns on every run that it is being forced onto Node
24. The fix is vendor-cli's open Dependabot PR #49 (create-pull-request 8.1.1), a
major bump waiting on a review there.

## Cost and quota exposure

This repo spends nothing at runtime. Its only recurring cost is GitHub Actions
minutes for four workflows, and the weekly bump currently burns about twenty seconds
a week to fail. `npm ci` (CI's install since 2026-09-22, and the bump's) installs one
git dependency and prints `skipping integrity check for git dependency` — expected
for a SHA pin, not a finding.

Everything else this kit costs is spent on somebody else's behalf, which is the
reason to be careful in a file that looks free to edit:

- `DEFAULT_MODEL` sets the tier of Surf-Tracker's Anthropic bill whenever its env
  knobs are unset, and Opus is the priciest tier — which is why the comment tells
  callers to pair it with an explicit `effort`.
- `fetchWithRetry`'s defaults decide how many times a per-query-billed upstream is
  called. `opts.retries: 0` performing **exactly one attempt**, and `429` being
  retried only under `retryOn429`, are the two guards that keep a billed call from
  multiplying; `attemptTimeoutMs` bounds the single attempt instead.
- The two rate limiters bound eight consumers' public endpoints. A bug that makes
  `checkRateLimitDistributed` allow instead of deny raises every consumer's
  invocation count, which is why exhausted CAS conflicts **deny** rather than permit,
  while a store *read* error falls back to the in-memory limiter unless the caller
  passes `failClosed` — two different failures, two different answers, both tested.
- `raceProxyHtml` issues N third-party requests per extract and aborts the losers
  once a winner is known. Removing that abort is a quiet bandwidth and
  goodwill charge against proxies nobody pays.

## Generated and baked

Nothing in this repository is generated. There is no version stamper, no stamped
constant, no vendored copy of another kit, no baked dataset — this kit's version
reaches the world only through the provenance header the generator writes into
consumers' copies, and through the `v<version>` tag.

What must never be hand-edited lives **downstream**: the eight generated copies, each
regenerated by that consumer's own `vendor:sync` and gated by its `vendor:check`.
They are `netlify/shared/netlify-kit.js` in Art-Gallery-,
`netlify/functions/lib/netlify-kit.js` in BearsMockDraft, FlightCheck, Surf-Tracker
and John's News, `netlify/functions/lib/netlify-kit.mjs` in JFS-Sports and Weather,
and `netlify/functions/utils/netlify-kit.mjs` in market-monitor — three of them cjs,
five esm. A **full surface is never tree-shaken**, so every copy is `index.js`
verbatim under a seven-line header: that is why re-pinning vendor-cli is not a
re-vendor event for any consumer, and why a version bump here is the only thing that
changes their bytes. `package-lock.json` is committed and is the bump's to rewrite.

## Deferred and stuck

| Item | Current → target | Verdict | Why | What would change the answer |
| --- | --- | --- | --- | --- |
| `@jfs/vendor-cli` pin | `3e9e174` (0.21.7) — vendor-cli `main` on 2026-09-22 | **current, by hand; the automation is still blocked** | landed by a hand-opened PR (#42) from the branch the bump pushed; next Monday's bump will again validate, push, and fail to open its PR | the "create and approve pull requests" permission (owner only). Until then: a manual PR from `auto/kit-pin-bump` after each Monday run |
| `engines.node` | `>=18` → `>=22` | hold, but decide it deliberately | nothing executes 18: CI rides family-ci's default 22 and this repo has no `.nvmrc` to point `node-version-file` at. `index.js` uses no builtin above 18 (measured: no `Object.groupBy`, `Promise.withResolvers`, `toSorted`, `structuredClone`, `findLast`), so raising the floor buys nothing today | an `index.js` change that wants a newer builtin, or a consumer's function runtime moving — then raise it in the same commit |
| npm majors | none open | — | zero open PRs on 2026-09-22 (the day's minor bump, #41, merged itself), `npm outdated` is empty, and the three devDependencies are on their registry latest (`eslint` 10.11.0, `globals` 17.12.0, `@eslint/js` 10.0.1) | Dependabot opening one. Then use the classes-of-proof table in the family block below: this kit's suite stubs `globalThis.fetch` and injects `fetchFn` / `fetchImpl` everywhere, so an HTTP-client major is proved by reading call sites, not by a green run |

One defect is documented and deliberately **not** fixed, and CLAUDE.md says why:
`looksLikeNumericIp`'s short-form IPv4 hole (`127.1`, `10.0.1`) is unreachable,
because `parseSafeHttpsUrl` runs `new URL()` first and the WHATWG parser normalizes
every numeric host form it accepts to dotted-decimal and refuses the rest. A test
pins the parser's behavior instead. Adding the "missing" final-label check would be
dead code. CLAUDE.md names no other outstanding follow-up, and neither does the code.

## What looks like cruft and is load-bearing

- **`isSafeHttpsUrl` has no consumer outside this file** and reads like a retirement
  candidate. `raceProxyHtml` has called it since 0.10.0 — it is the string-level guard
  on a caller-supplied target that is about to be handed to a third party's egress.
  Leave it exported; check internal callers before retiring any export here.
- **The two `createHandler` orderings.** The 405 runs *before* the limiter so a
  rejected verb never spends a caller's rate-limit budget; the 413 runs *after* it so
  a flood of oversized bodies is still rate-limited. Both are stated in the source.
- **`raceProxyHtml` refuses with a rejected promise, never a synchronous throw.**
  Every other path returns a promise, so a `.catch()`-style caller would never see a
  throw that happened before the chain was built. A test asserts `doesNotThrow`,
  which looks like a weak assertion and is the point.
- **The letter test before `Date.parse` in `_retryAfterMs`.** V8 reads `1.5` as
  January 2001 and `-5` as May 2001 — both past, so the delay clamps to zero and
  every retry fires at once. Deleting the test reinstates the storm the header exists
  to prevent.
- **A base64-transported request body is measured decoded.** Its string form is ~4/3
  the payload, so measuring the string rejects uploads a third under the cap.
- **`jsonResponse` / `textResponse` dispatch on `typeof firstArg === 'number'`.** That
  overload is a compatibility superset for two apps' existing call sites, and it means
  a bare numeric *payload* dispatches as a *status*. Do not "clean up" the overload;
  point new call sites at `jsonBodyResponse` / `jsonStatusResponse`.
- **`CORS_ORIGIN` is read once, at module scope**, and frozen into `corsHeaders`. That
  is why changing the env var needs a redeploy in every consumer, and why an endpoint
  goes CORS-free through `createResponders({ cors: false })` rather than through the
  environment. Moving the read inside the responders would look like a fix and would
  change eight repos' behavior at once.
- **The fail-closed DNS ladder** distinguishes `dns-unavailable` / `dns-failed` /
  `dns-empty` from `private-ip`. "Could not check" must never read as "public".
- **`no-control-regex` and `no-regex-spaces` are off** in `eslint.config.mjs`: the
  first fires on the SSRF and header guards that strip control characters — the kit's
  whole job — and the second on the vendor suite's deliberate two-space match against
  generated output. Keep the list this short.
- **The `bare`-format case in `test-vendor.mjs` asserts a refusal**, of a format
  vendor-cli removed in 0.19.0. It reads as a stale test and is the opposite: it pins
  that an unknown format fails loudly.
- **`@netlify/blobs` is not a dependency here, not even a dev one.** Both Blobs paths
  are dynamic imports that degrade to a no-op, and the suite exercises them against
  injected fakes. Do not add the package to "test it properly" without deciding what
  that would prove; John's News keeps it installed for a vite transform reason that
  does not apply to a `node --test` suite.

## Diagnosis — it is broken and I do not know why

In this order, fastest-resolving first.

1. **Is `main` green and tagged?** Compare the newest tag against the version:
   `git ls-remote --tags origin | tail -1` and
   `node -p "require('./package.json').version"`. Today: `v0.10.0` and `0.10.0`.
   A version on `main` with no tag means `release.yml`'s `workflow_run` gate never
   fired (a push made with the default token creates no runs); `workflow_dispatch` on
   Release is the backfill path.
2. **Did the weekly bump run, and where did it fail?** Open the `kit-pin-bump.yml`
   workflow page in this repo's Actions tab and read the **scheduled** run, not
   `main`'s colour. If the failing step is *Open a pull request if anything changed*,
   it is the repo setting under Settings → Actions → General, and no code change will
   help.
3. **Is work stranded?** `git ls-remote --heads origin 'refs/heads/auto/*'` against
   the open PR list. A branch with commits and no PR means the automation worked and
   could not deliver.
4. **Is the pin current?** `npx --no-install jfs-check-kit-pins` proves it *resolves*,
   not that it is current — it prints `all 1 kit pin(s) resolve.` either way. For
   currency, compare
   `node -p "require('./package.json').dependencies['@jfs/vendor-cli']"` against
   vendor-cli's `main` HEAD. `npm run kit-pins:bump` does the bump locally.
5. **Lint dies with `ERR_MODULE_NOT_FOUND ... '@eslint/js'`** — that is a missing or
   partial `node_modules`, not a config bug. `npm ci`.
6. **A guarded-article-fetch test is red with `redirect resolves to a private
   host`** (the DNS half of `assertSafePublicUrl`, as opposed to `unsafe redirect
   target`, which is the string half). Since 2026-09-22 that section's lookups come
   from `withDns`'s table, not the network, so this is no longer a resolver problem:
   either the test's table does not name the host the code now looks up, or the code
   really refused. Read the `asked` list the test records. The one test that still
   uses the real resolver is `resolveHostIsPublic: localhost is private`; if only it is
   red, check the runner's hosts file:
   `node -e "import('./index.js').then(m=>m.resolveHostIsPublic('localhost')).then(console.log)"`.
7. **A consumer broke after a re-vendor.** The copy is `index.js` verbatim under a
   header, so regenerate one locally and diff it before suspecting the generator:
   `node bin/vendor.mjs --format esm --out /tmp/probe.js` (or `--format cjs`). If the
   surface is right and the behavior is wrong, the consumer is on an older pin — read
   its `package.json`.
8. **Nothing in this repo can tell you a consumer is stale.** Grep the siblings'
   `package.json` for the `@jfs/netlify-kit` pin and compare against `main`.

## Run log

| Date | Cadence | Found / done |
| --- | --- | --- |
| 2026-09-22 | Weekly + monthly sweep | **Weekly.** Kit-pin bump: last scheduled run (09-21) and the day's dispatch (run 6) both `failure` at *Open a pull request* — the repo setting, unchanged; the orchestrator opened #42 by hand from the branch run 6 pushed and it merged at `e399e37`, so the vendor-cli pin is `3e9e174` (0.21.7) = vendor-cli `main`, and `auto/kit-pin-bump` is gone with the merge. No stranded `auto/*` branch; one stale non-bot branch, `claude/family-review-3urdej` at `414cf2f`, is an ancestor of `main` with nothing unique on it (owner may delete it; a session may not). Test, Release and Dependabot merge green on `main`; no open PRs, no bot PR older than a week. **Baseline gate** clean on `e399e37`: `node --check`, lint, 110/110, `maintenance-doc-check`, both sync checks, kit-pin pre-flight, prod audit 0. **Found and fixed:** (1) the bump's `check-command` omitted `npm run lint` — added, and `test-repo.mjs` now fails if it differs from `test.yml`'s `run`; (2) `prod-audit` was off with a real prod tree (vendor-cli → esbuild 0.28.2) — on; (3) CI installed with `npm install` while the bump uses `npm ci` and the bump's comment claimed CI did too — `install-command: npm ci`; (4) the suite needed live DNS: with lookups forced to fail, 5 guarded-fetch tests went red and the oversized-body test passed for the wrong reason — the section now answers `dns.lookup` from a table, and doing so showed that deleting the resolved-IP check on a redirect HOP left all 110 tests green; three new tests pin the hop, the start URL and the fail-closed ladder, each checked against a mutation of `index.js`; (5) three mechanized invariants in the new `test-repo.mjs` (`files` ↔ version guard plus entry points, bump ↔ CI commands, exports ↔ README API names and `test.mjs` imports); (6) false docs: README test command, "dependency-free at install time", the CJS example naming market-monitor's ESM copy, and "cached" DNS lookup in README and CLAUDE.md. 117/117 after. No `index.js`/`bin` change, so no version bump. **Monthly.** `npm outdated` empty, no majors open, audit 0. Upstreams: this kit owns no probe; read `DEFAULT_MODEL` (`claude-opus-4-8`, Active in the cached model reference, still Surf-Tracker's live fallback) and `ANTHROPIC_VERSION` — both recorded, neither changed (a model change is the owner's). Delivery: all eight consumers' `origin/main` copies carry v0.10.0 — JFS-Sports' bump (#720) closed the one gap this file recorded. **Left open:** the Actions PR-permission setting (owner); vendor-cli's `FAMILY_READ_TOKEN` (owner, vendor-cli #60); family-ci's version guard never runs on a dispatched branch (vendor-cli's); `index.js`'s own "cached DNS lookup" comment (fix with the next version-bumping change, not alone); the fetch-kit twin and `engines.node` stay prose. |
| 2026-09-22 | plan written | Wrote this file and turned on family-ci's `maintenance-check`. Gate verified green by hand: `node --check index.js`, `eslint .` clean, 110/110 tests. Confirmed from Actions history that `kit-pin-bump.yml` has **never** succeeded — 5 scheduled runs, 5 failures; runs 1–3 on `Missing script: "vendor:sync"` (fixed by #35), runs 4–5 on `GitHub Actions is not permitted to create or approve pull requests` at the PR step, with steps 1–10 including the bumped-tree CI check green. The bump it cannot deliver is on `origin/auto/kit-pin-bump` (`9c82a23`): vendor-cli 0.21.3 → 0.21.6. Found that JFS-Sports is the one consumer still pinning `9a5a74e`, so 0.10.0's `Retry-After` fix is tagged but not running where `fetchWithRetry` is called 14 times. Also recorded: the version guard never runs on a dispatched branch; the bump's check-command omits `npm run lint`; `prod-audit` is off although this kit has a real prod dependency tree; the suite needs working DNS for the guarded-article-fetch happy paths; and `DEFAULT_MODEL` is Surf-Tracker's live fallback. No code changed. |

<!-- maintenance-check:allow
npm run check          # named only to record that this kit has no aggregate gate script, unlike the apps
npm run vendor:sync    # named only to record its absence — this kit vendors nothing, which is why the bump passes `npm install` instead
npm run version:stamp  # named only to record its absence — no stamped constant here, which is why the bump passes version-bump-command: ''
-->

<!-- jfs-family-maintenance:start — managed by jfs-maintenance-sync; edit family/maintenance.md in @jfs/vendor-cli -->

## Family maintenance protocol

This section is identical across every repo in the @jfs family. It is managed
by `jfs-maintenance-sync` (@jfs/vendor-cli) and checked by family CI — edit
`family/maintenance.md` in the vendor-cli repo, not here.

It covers what is true of **every** repo. What is true of THIS one — its
automation inventory, its upstreams, its invariants, its diagnosis ladder — is
the repo-specific half of this file, above.

### What the automation does, and what it deliberately leaves

Four reusable workflows in `@jfs/vendor-cli` carry the whole family's upkeep.
A repo calls the ones that apply to it:

| Workflow | Fires | Lands by itself | Leaves for a session |
| --- | --- | --- | --- |
| `family-ci.yml` | every push, every PR, `workflow_dispatch` | — it *is* the gate | nothing |
| `dependabot-merge.yml` | when CI completes on a Dependabot PR | every bump that is minor or patch, squash-merged on green | **every major**, and any PR body it can't parse |
| `kit-pin-bump.yml` | weekly, Mondays ~06:41 UTC | the `@jfs/*` pins, the re-vendor, the CLAUDE.md conventions block, the version bump | nothing, when it works |
| `release.yml` | CI green on `main` | the `v<version>` tag and its GitHub release | nothing |

Three gaps follow from that table and they are the whole reason this protocol
exists. They are not oversights; each is a deliberate refusal to automate a
judgement call, and each therefore needs a cadence instead.

**1. Majors accumulate, and the backlog is not inert.** A major is a
judgement, not a merge, so `dependabot-merge.yml` leaves it open. Nothing
schedules the session that makes the judgement, and `.github/dependabot.yml`
caps open PRs. Once the cap is full of unreviewed majors, the weekly
minor/patch PR — the one the automation *does* land — stops being opened at
all. The backlog turns from a to-do list into a block on the working half of
the pipeline.

**2. CI cannot check prose, or anything whose halves live in different
files.** Every repo's gate parses what it ships, lints it, regenerates the
vendored copies, checks the version stamp and runs the suite. None of that
notices that CLAUDE.md describes a module that moved, or that a value added to
one file has no matching entry in the two others that must agree with it. The
family's answer is the same every time and it is worth repeating: **an
invariant whose halves live in different files belongs in a test, not a
comment.** Prose does not hold. Where a cross-file rule is still only written
down, the monthly sweep is what checks it, and mechanizing it is the standing
work.

**3. Nothing watches the upstreams.** Every feed, API, scraped page and
published dataset belongs to somebody else, and these apps fail soft by
design: an upstream that 404s, moves, rate-limits the deploy's egress IP or
starts answering with a bot wall yields less content, one line in a
diagnostics payload, and a green CI run. The only way to notice is to look.

And one standing limitation that applies to every repo here: **the suites fake
the network.** That is what makes them fast, offline and safe to run
air-gapped, and it is exactly why a breaking change in a client library or an
upstream's payload shape ships green. A green suite is evidence about this
repo's code. It is never evidence about its dependencies' behaviour, and never
evidence that the deploy works.

### Who watches the watchers

The automation above is what makes fourteen repos maintainable with the owner
away, which makes a silent failure *in the automation* the highest-severity
failure mode in the family — and until this protocol existed, nothing watched
it at all.

The failure is not hypothetical and it is not rare. A `workflow_run` that
fails on a schedule produces no issue, no comment and no message anyone reads;
it leaves a red mark on a page nobody opens. Measured on 2026-09-22: the
weekly kit-pin bump had failed on **every** scheduled run for four to five
weeks in four repos, from two unrelated causes, with no signal of any kind.
Three of them had pushed a correct bump to an `auto/kit-pin-bump` branch that
no pull request was ever opened for. One patch release of the vendoring
generator had gone unvendored family-wide as a result — the same class of
failure the vendor-cli notes already record happening once before, fixed at
the source, and recurred by a different mechanism.

So the weekly check below is not optional hygiene. It is the one cadence that
protects every other cadence, and it asks four questions:

1. **Did each scheduled workflow's last run succeed?** Not "is `main` green" —
   a scheduled run fails on its own page. Check the run, not the branch.
2. **Is there a stranded `auto/*` branch?** A branch with commits and no open
   PR means the automation did its work and could not deliver it. On any repo:
   `git ls-remote --heads origin 'refs/heads/auto/*'` against the open PR list.
3. **Are the `@jfs/*` pins actually current?** A repo whose pins sit behind
   every sibling's is a repo whose bump is not landing, whatever its workflow
   page says. Compare the pins across repos, not against hope.
4. **Is any bot PR older than seven days, red, or conflicted?**

A clean week needs no action. Say so and stop.

### The cadences

#### Every change — before the push

These are the existing rules, restated so the protocol is complete in one
place:

- Run the repo's own gate command — the same steps CI runs, so the two cannot
  drift. Push only once it is clean.
- Bump the version and run the stamper whenever a **shipped asset** changes.
  Every app here serves its shell from a versioned service-worker cache, so a
  missed bump leaves returning visitors on the stale build — the exact failure
  the family flow exists to prevent. A change that never reaches the browser
  needs no bump.
- Never hand-edit generated output: a vendored kit copy, a stamped constant, a
  baked dataset. Bump the pin and re-run the generator; the copies are
  reviewed as bundler output, not as source.
- A new external resource changes the CSP, in **every** file that declares one.
- Docs change in the commit that makes them wrong, not in a later sweep.
- Open the PR ready for review, dispatch CI, and merge on green — a
  session-pushed branch fires no `pull_request` workflows, so a dispatched run
  on the head commit is the only gate there is.

#### Weekly — pipeline hygiene (~10 minutes)

The four questions under "Who watches the watchers". Nothing else.

#### Monthly — the sweep (~1 hour)

Work the sections in this order, because each one's output feeds the next:

1. **Cross-file drift** — fix first. A failure means two files that must agree
   no longer do, and where the check is gated, CI is already red.
2. **Dependency currency** — every outstanding major goes through the triage
   below. Record the verdict; do not re-derive last month's no.
3. **Advisories** — a high or critical in a *shipped* dependency already has
   CI red where the prod-audit gate is on. When no version bump resolves it —
   an upstream pinning a vulnerable transitive exactly — an `overrides` entry
   is the family's escape hatch.
4. **Upstreams** — probe the ones this repo owns a probe for, and read the
   result against its documented caveats. A datacenter IP gets a correct 403
   from Cloudflare-fronted hosts; the probe reports it and cannot tell you
   which it is.
5. **Delivery** — confirm the version being served is the one that shipped.
   See "Green CI is not delivered".
6. Add a row to the run log at the bottom of this file.

#### Quarterly, or whenever a signal says so

- **Runtime floor.** `engines.node` (or the language equivalent) against what
  upstream still supports and against the floors the outstanding majors
  demand. This is the single decision that most often unblocks a stuck major
  backlog, and it is a runtime decision before it is a dependency one.
- **Platform.** The function runtime, the bundler, the header set, the actions
  pinned by SHA — a pinned third-party action ages into a deprecated runner.
- **Security re-read.** The SSRF guards, the rate limits, the origin gates,
  what the public diagnostics endpoint discloses, and whether every key is
  still scoped, spend-limited and rotatable.
- **Upstream inventory.** Not "does it answer" but "is it still the right
  source" — a feed that died, a sanctioned route that now exists where a proxy
  was used, a pinned figure that has rotted.

### Major-bump triage

"Does CI pass?" is the wrong question for a major, because the suite fakes the
network. Work these in order and stop at the first step that says hold.

**1. Inventory the call sites.** Grep the import; read every use. Most majors
turn out not to touch the API this repo actually calls. Write down what you
depend on before reading a single release note.

**2. Check the engine floor** against the runtimes that really execute the
code — not only the declared floor, but the function runtime, the build image
and whatever the local entry point runs. A major that raises the floor is a
runtime decision first. Decide the floor, then come back.

**3. Prove it, at the bar the dependency's class demands.**

| Class | What counts as proof |
| --- | --- |
| Pure JS the suite really exercises | the repo's gate command |
| Native module | a scratch script reproducing this repo's *exact* usage against the new version — and whether it installed a prebuilt binary or compiled from source, which changes CI time and can fail on the build image |
| A client the suite **fakes** | nothing the suite can say. Diff the real export surface between the versions and read the call sites by hand |
| Browser-shipped | whatever gate executes the real module graph — a link error is invisible to a linter and arrives as `undefined` under a bundler-transformed test runner |

**4. Land it.** One major per PR unless they are genuinely independent and all
trivially verified. Bump the version only if a shipped asset changed — a
dependency bump that touches nothing shipped must not churn the
service-worker cache name.

**5. Or hold it — visibly.** A major that should not land gets a row in this
file's deferred table, with the reason and **the condition that would change
the answer**. The bot keeps the PR open either way; the table is what stops
the next session spending an hour re-deriving the same no.

### Green CI is not delivered

CI going green means the code is sound. It does not mean anyone received it.
The deploy is a second gate, it runs after CI, and it can fail on its own —
and when it does, nothing breaks and nothing says so: the platform keeps
serving the last good build, the stamped version never moves, no update pill
ever appears, and the change is simply absent for everyone. That is the same
shape as a stale dataset — every automated check green, the product quietly
not doing the new thing.

So after a merge, confirm that the build being served is the one that shipped:
compare the version in the repo against the version the live site reports and
against the one its service worker carries. Three agreeing numbers is delivery
confirmed. The last two lagging the first means the deploy failed or has not
finished.

### What a maintenance session must not do

- **Do not "clean up" a load-bearing irregularity.** Every repo here carries
  measured numbers, deliberate fallback orderings and odd-looking guards that
  encode a bug already paid for. Each repo lists its own above; the rule is
  that an oddity with a comment recording a measurement is evidence, not
  cruft. Simplify the interior freely. Before simplifying anything that
  touches a boundary, make sure that boundary's checks exist and pass.
- **Do not weaken a gate to make it pass.** A skipped test, a loosened
  assertion and a silenced linter rule all read as green. If a check is wrong,
  fix or delete it deliberately and say why; if it is right, fix the code.
- **Do not let a check pass quietly when it could not run.** "Could not check"
  must never be reportable as "fine" — the one failure mode that makes a
  monitor worse than no monitor. Keep the exit codes distinct.
- **Do not extract a kit to solve a duplication.** The bar is a third
  consumer *and* drift that has already caused a real bug or a manual
  reconciliation. Prefer growing an existing kit.

### The run log

Every sweep ends with a row in the repo-specific run log: the date, the
cadence, and what was actually found and done — including "clean". A sweep
that leaves no trace is a sweep the next session will repeat from scratch, and
the log is the only record of why a held major is still held.

<!-- jfs-family-maintenance:end -->
