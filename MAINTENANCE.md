# Maintaining @jfs/netlify-kit

This kit ships no site, runs no deploy and calls no upstream on its own. Everything
it produces reaches the world as a generated copy inside eight other repos' function
directories, so maintenance here turns on three things a green suite says nothing
about: whether the weekly pin bump is landing (it is, by itself, since 2026-09-23 —
after six straight failures that nobody was told about; see below), whether the
consumers have actually re-vendored the code that was tagged, and whether the figures
this file pins on somebody else's behalf are still true. Those figures used to be the
Anthropic client's — a model id, an API version header, a timeout sized against a
platform ceiling — and since 2026-09-30 nothing in the family calls that client, so
none of them is load-bearing any more (see "What nothing watches").

## What runs by itself

| Automation | Fires | Lands by itself | Leaves for a session | How a failure would be noticed |
| --- | --- | --- | --- | --- |
| `.github/workflows/test.yml` → the family's `family-ci.yml@main` (`verify-kit-pins: true`, `install-command: npm ci`, `prod-audit: true`, `maintenance-check: true`, `version-guard-paths: index.js bin`, `run:` the three gate commands below) | `push` to `main`, every `pull_request`, `workflow_dispatch` | — it *is* the gate | nothing | red on the PR or the commit. The one automation here whose failure appears where somebody is already looking. |
| `.github/workflows/kit-pin-bump.yml` (`41 6 * * 1` — Mondays 06:41 UTC, which GitHub's scheduler has started 20 to 32 minutes late on every scheduled run here) + dispatch | weekly | the one `@jfs` pin, `npm install` so the lockfile follows, the CLAUDE.md and (since vendor-cli 0.22.0) MAINTENANCE.md family blocks, the PR, the squash-merge — by itself since 2026-09-23: #44 from a dispatched run, #45 from the 2026-09-28 scheduled one | nothing, when it works | a red run on its own page — which the family liveness monitor now reads every Monday (below). It failed its first six runs and nobody was told; see below. |
| `.github/workflows/release.yml` (`workflow_run` on `Test` completed, `branches: [main]`) + dispatch | CI green on `main` | the `v<version>` tag and its GitHub release | nothing | **nothing** — but it demonstrably works here: 36 runs by 2026-10-01 (the newest on 2026-09-22 — the bot merges since fire no workflows, so no `Test` and no Release follows them), and `v0.10.0` points at `f4d2347`, the commit that set the version (later commits on `main` left it at 0.10.0, so each re-run was a correct no-op). |
| `.github/workflows/dependabot-merge.yml` (`workflow_run` on `Test` completed) + `.github/dependabot.yml` (npm weekly Tuesday, minor+patch grouped, limit 5; `github-actions` monthly) | on each CI completion | every minor/patch bump, squash-merged on green — it landed #37 on 2026-09-08 and #41 on 2026-09-22. vendor-cli 0.22.0's hold on grouped production bumps never applies here: the one production dependency is the `@jfs/vendor-cli` git pin, which Dependabot does not manage | **every major**, and any PR body it cannot parse | a PR sits open. Nobody is told. `.github/dependabot.yml` has no 7-day `cooldown` yet, which the canonical Dependencies text now asks for — see the deferred table |

There is nothing else: no deploy, no smoke test, no cron but the bump, and no monitor
in this repository. What notices the bump failing is the family liveness check in
vendor-cli (`tools/family-liveness.mjs`, on vendor-cli's `main` since #58) —
scheduled Mondays 08:10 UTC, deliberately ~90 minutes after the bump so it observes
that week's run, reporting on one rolling hub issue (vendor-cli #60) rather than as a
notification in thirteen repos. **It is watching now.** Its first run (2026-09-22)
exited 2 ("could not check") for want of the `FAMILY_READ_TOKEN` secret; the token has
been in place since 2026-09-23, when the first report covering all fourteen repos was
posted, and the 2026-09-28 scheduled report and a 2026-10-01 dispatched one both list
this repo's `kit-pin-bump` as ✓. Since vendor-cli 0.22.0 a healthy run closes the
issue, so an open #60 means a session is needed now; and a pin counts as stale only
when it lacks a kit commit older than that repo's own last bump run, so a consumer
missing a commit that landed after its bump started is "lagging", not reported —
which is why the split described under "Green CI is not delivered" below raises
nothing.

### The weekly bump: six silent failures, then landing by itself (since 2026-09-23)

`kit-pin-bump.yml` has **eight** runs to 2026-10-01 (read from the Actions API that
day). The first six — five `schedule` (2026-08-24 through 09-21) and one
`workflow_dispatch` (2026-09-22) — all failed, for two unrelated causes, and nobody
was told:

- **Runs 1–3** died on `npm error Missing script: "vendor:sync"` at *Re-vendor from
  the bumped pins*, having already resolved the pin. The caller passed only
  `check-command`, so the reusable workflow's defaults ran `npm run vendor:sync` and
  `npm run version:stamp`, which a kit does not have. Fixed by #35 on 2026-09-08
  (`vendor-sync-command: npm install`, `version-bump-command: ''`).
- **Runs 4–6** got through resolve, re-install and the check command, pushed
  `auto/kit-pin-bump`, and failed at the PR step on
  `GitHub Actions is not permitted to create or approve pull requests.` — the per-repo
  setting *Settings → Actions → General → Workflow permissions → Allow GitHub Actions
  to create and approve pull requests*, which no commit can change. On 2026-09-22 a
  session opened #42 by hand from run 6's branch (vendor-cli `276274b` 0.21.3 →
  `3e9e174` 0.21.7) and merged it on green CI.

**The owner turned that setting on by 2026-09-23**, and both runs since have opened
and merged their own PR as `github-actions[bot]`:

| Run | Event | PR | Merged as | `@jfs/vendor-cli` |
| --- | --- | --- | --- | --- |
| 7 | `workflow_dispatch`, 2026-09-23 20:10 UTC | #44 | `09a5e05` | `3e9e174` (0.21.7) → `adcc689` (0.21.8) |
| 8 | `schedule`, 2026-09-28 07:13 UTC | #45 | `96ce1ac` | `adcc689` → `bef0be8` (0.21.10) |

Run 8 was the first here under vendor-cli 0.21.10's two-job split (#63, 2026-09-26 —
the family audit's FAM-1(a)): a `prepare` job holding only a **read** token installs
the bumped tree, re-installs and runs this repo's `check-command` (117/117 that
morning), and hands the result over as a patch; the `bump` job holds the write token
and runs nothing from the repo — it applies the patch, opens the PR and merges it. So
a bump's validation is the `prepare` job's *Run the repo's CI checks against the
bumped tree* step, and nothing else.

Two things make a stuck bump worse here than in an app, and both still hold. First,
`bin/vendor.mjs` is a shim that runs whatever `@jfs/vendor-cli` resolves from
**inside this package**, so this one pin decides which generator all eight consumers'
`jfs-netlify-kit-vendor` executes — a stale pin here means every consumer re-vendors
this kit through a stale generator. Second, CLAUDE.md already records this exact
class of failure once (the pin sat at 0.8.0 while the family shipped 0.17.0, closed
by #29), and it recurred by a different mechanism, because a fix is not a monitor.
The monitor exists now (above); it is what would report the next silent failure.

If a run goes red again, read which job failed. A red `prepare` job is this repo's
problem — the install, the bump, or the check command against the bumped tree. A red
*Open a pull request* step in the `bump` job with the permissions message means the
setting was switched off again (owner only); meanwhile open a PR by hand from
`auto/kit-pin-bump` (`prepare` already validated it), dispatch `test.yml` on the
branch and merge on green — or, if the branch is stale against `main`, run
`npm run kit-pins:bump` locally, then the gate, then a PR by hand.

### The red `Test` run on every bump PR is not the validation

Every bot pin-bump PR also gets a `pull_request` run of `Test`, by
`github-actions[bot]`, with **zero jobs**: #100 on #44 and #101 on #45 both concluded
`failure` within a second of being created (fetch-kit's #84, on its #33, sits at
`action_required` instead). Once expired, the run page says "This workflow run
required approval but was not approved before it expired". Each run was created
within a second after its PR had merged (#44 at 20:10:46 UTC, #100 at 20:10:47). It
runs nothing and proves nothing either way — the bump's validation
is the `prepare` job above — but an unfiltered list of `Test` runs shows it as the
newest run, in red, and it reads like a broken bump. It is not. Read health from
`Test` on `main` with event `push` or `workflow_dispatch` (the API's
`actions/workflows/test.yml/runs?branch=main&event=push`) plus the bump's own run, and
remember that a bot merge fires no workflows, so `main`'s HEAD after a bump
legitimately has no `Test` run: `09a5e05` and `96ce1ac` have none, and the newest
`Test` on `main` is #99 on `5cc51ee`. Approving or re-running it after the fact would
validate a PR that has already merged.

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
| `npm test` | `node --test test.mjs test-vendor.mjs test-repo.mjs` — **121 cases** (107 + 10 + 4), all green on 2026-10-07. `test-repo.mjs` holds this repo's cross-file invariants; see below |

`kit-pin-bump.yml`'s `check-command` is exactly these three lines, and `test-repo.mjs`
fails if the two lists ever differ — until 2026-09-22 the bump skipped `npm run lint`,
so a bumped tree was validated by a weaker gate than a pull request.

Four properties of that chain matter more than the list.

**`test-vendor.mjs` drives the pinned generator over this kit's own source**, in the
esm, global and cjs formats, and asserts the emitted surface is all 57 of `index.js`'s
exports. That is why a vendor-cli pin bump is validated here rather than in eight
consumers' `vendor:sync`, and why the bump's own check step passing (it did, against
0.21.6, 0.21.7, 0.21.8 and 0.21.10) is real evidence and not a formality. Since
2026-10-01 the file is fetch-kit's copy byte for byte — it derives the package name
and the export surface from the kit, so nothing in it is kit-specific: every refusal
case matches the CLI's stderr reason, not just a non-zero exit, and an esm `--pick`
case checks the narrowed surface and that the body actually shrinks. Before that, two
cases here (`--name is required and validated` and the then-named `--pick outside
global`) passed with **no CLI installed at all**: measured by moving `node_modules`
aside, the old file kept both green, while every CLI-driving case in the new one
fails. Keep new cases that way; an exit-code-only assertion on this CLI cannot tell
"refused for the right reason" from "never ran".

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

**The version guard runs on dispatched runs too, since vendor-cli 0.21.8.** Until
#61 (2026-09-23) family-ci's `version-bump` job ran on `pull_request` only, so the
`workflow_dispatch` run a session's PR is merged on skipped it, and an unbumped change
to `index.js` or `bin` could merge on an entirely green run. It now also runs on
`workflow_dispatch`, diffing the branch against the default branch from the
merge-base (three-dot), so a dispatched run does check that a shipped change moved the
version. A bot pin bump still gets no guard run (its PR fires no real CI), which is
harmless: a bump touches only `package.json` and `package-lock.json`. The guard
matters because consumers pin by SHA and releases tag by version, so an unbumped
shipped change puts two different SHAs under one version label.

**CI installs with `npm ci`, and audits what ships.** `test.yml` passes
`install-command: npm ci` (family-ci defaults to `npm install`), so a
`package-lock.json` out of step with `package.json` fails the PR instead of the
Monday bump, which installs with `npm ci`. And it passes `prod-audit: true`, because
`dependencies` is not empty: `@jfs/vendor-cli` sits there on purpose and pulls
`esbuild` (0.28.2, under vendor-cli 0.21.7 and still under 0.21.10) and its platform
binary into every tree that installs this kit. Both went on 2026-09-22; `npm audit
--omit=dev --audit-level=high` reported 0 vulnerabilities that day and again on
2026-10-01.

## This repo's cross-file invariants

| Pair | Gated by | What breaks on drift |
| --- | --- | --- |
| `index.js`'s 57 exports ↔ the emitted esm / global / cjs surface | **gated** — `test-vendor.mjs` derives the surface from the source and asserts every name is exposed | a consumer imports a name the generated copy does not carry: a runtime `ReferenceError` in a deployed function |
| `index.js`'s exports ↔ `test.mjs`'s `import { … } from './index.js'` list | **gated** since 2026-09-22 — `test-repo.mjs`. A floor, not coverage: being imported is not being tested | an export ships with no test and no signal |
| `package.json`'s `files: ["index.js", "bin"]` ↔ `test.yml`'s `version-guard-paths: index.js bin`, and `main` / `exports` / `bin` inside `files` | **gated** since 2026-09-22 — `test-repo.mjs`, set equality in both directions | add a third shipped file to `files` and it sits outside the version guard; a shipped change lands unbumped |
| `package.json` `version` ↔ the provenance header of eight consumers' generated copies ↔ the `v<version>` tag | half gated: family-ci's version guard (pull requests, and since vendor-cli 0.21.8 dispatched runs) and `release.yml` | the tag and the header disagree with what shipped |
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
| The Anthropic client's pinned figures: `DEFAULT_MODEL`, `ANTHROPIC_VERSION`, and the private `DEFAULT_ANTHROPIC_TIMEOUT_MS` (25 s, sized against Netlify's ~26 s synchronous-function ceiling) | Anthropic's model roster and API versioning; Netlify's function ceiling | **harmlessly, since 2026-09-30**: nothing in the family calls the client (see below), so a retired model or a dropped version header would break no deployed endpoint | nothing, on purpose. The monthly sweep read the first two against the Claude API model reference until 2026-09-22 (both current then); with no caller left there is nothing for that read to protect. Re-arm these rows if a consumer ever adopts the client again |
| The public CORS proxies `raceProxyHtml` races | third parties | loudly per attempt, silently in aggregate | nothing here. The proxy **list** lives in each consumer; only the racing lives in this kit. Whether they answer with redirects is the open question behind NK-3 (see "Audit items") |
| Whether the consumers have re-vendored | the consumers | silently | nothing in this repo. See below |
| The per-repo "Allow GitHub Actions to create and approve pull requests" setting | the owner | silently in the setting, loudly in the bump: switched off, the next bump goes red at its PR step (as runs 4–6 did) | the bump run's own colour, which the family liveness monitor reports. Repo settings are not in git, so no gate in any repo can see the setting itself |

**The Anthropic client has had no caller since 2026-09-30.** `DEFAULT_MODEL` was live
until then: Surf-Tracker's `resolveModel()` fell back to it for its `summarize` and
`summary-chat` functions whenever its two model env vars were unset. Surf-Tracker
removed its AI summary feature in its #292 and market-monitor dropped its Claude
fallback for a Gemini-only `analyze` in its #455, both merged 2026-09-30. A GitHub
code search across every `jsvolos63` repository on 2026-10-01 for `callAnthropic`,
`openAnthropicStream` and `DEFAULT_MODEL`, cross-checked with a grep of each app's
`origin/main` outside its vendored copy, finds them only in this repository and in the
eight vendored copies — which are the definition, not a use. The one other hit is a
reason string in market-monitor's `tests/env-example.test.js` that names
`openAnthropicStream` as the reader of `ANTHROPIC_BASE_URL`. `normalizeEffort`,
`parseModelJson`, `toBullets` and `ANTHROPIC_VERSION` have no caller either.
**`userFacingReason` still does**: market-monitor's Gemini `analyze.mjs` imports it to
word an upstream 429, and since it reads only the `.status` / `.retryAfter` tags it is
provider-neutral in fact, if not in name. So the client is retained but unused, and it
still ships in every consumer's copy — 12,732 of `index.js`'s 69,949 bytes, verbatim,
because a full surface is never shaken. Removing it is a deferred item (below), not a
maintenance edit: it is an export removal, so a minor release that all eight
consumers re-vendor.

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

Re-checked 2026-10-01 on each sibling's `origin/main`: seven consumers pin `09a5e05`
(#44) and market-monitor pins `96ce1ac` (#45). Both commits change only
`package.json` and `package-lock.json`, so all eight copies still carry v0.10.0's
`index.js` under the `v0.10.0` header, and every consumer vendors the full surface (five
esm, three cjs; none passes `--pick`). The split is the same-cron race news-kit
recorded: on 2026-09-28 the consumers' bumps — scheduled like this one's, `41 6 * * 1` —
started between 07:12:18 and 07:13:03 UTC and resolved this repo's HEAD before #45
merged at 07:13:36, and market-monitor, which now bumps monthly, caught up with its
2026-10-01 run (its #460). The two pins differ only in which vendor-cli the shim
resolves (0.21.8 or 0.21.10), and a full surface is verbatim source under either, so
nothing shipped differs. It heals on the first Monday this repo has no bump of its own;
see the deferred table for the fix news-kit took.

Resolved since the last sweep: the shared bump workflow's
`peter-evans/create-pull-request` was pinned at a SHA targeting Node 20, and every
bump run carried the runner's warning that it was being forced onto Node 24. vendor-cli
#61 (2026-09-23) moved it to v8.1.1 (`5f6978f`), and run 8's log has no such warning.

## Cost and quota exposure

This repo spends nothing at runtime. Its only recurring cost is GitHub Actions
minutes for four workflows; the weekly bump takes about 36 seconds when it lands a
bump (run 8: two jobs, 07:13:05 to 07:13:41 UTC) and less when there is nothing to
bump. `npm ci` (CI's install since 2026-09-22, and the bump's) installs one
git dependency and prints `skipping integrity check for git dependency` — expected
for a SHA pin, not a finding.

Everything else this kit costs is spent on somebody else's behalf, which is the
reason to be careful in a file that looks free to edit:

- The Anthropic client bills nobody since 2026-09-30, because nothing calls it.
  While Surf-Tracker did, `DEFAULT_MODEL` set the tier of its Anthropic bill whenever
  its env knobs were unset — which is why the comment tells callers to pair it with
  an explicit `effort`. A consumer adopting the client again inherits that default.
- `fetchWithRetry`'s defaults decide how many times a per-query-billed upstream is
  called. `opts.retries: 0` performing **exactly one attempt**, and `429` being
  retried only under `retryOn429`, are the two guards that keep a billed call from
  multiplying; `attemptTimeoutMs` bounds the single attempt's wait for headers instead (the
  body is the caller's to bound — README).
- The two rate limiters bound eight consumers' public endpoints — the in-memory one
  per container, which against a parallel client is hardly a bound at all (FAM-3,
  under "Audit items"). A bug that makes
  `checkRateLimitDistributed` allow instead of deny raises every consumer's
  invocation count, which is why exhausted CAS conflicts **deny** rather than permit,
  while a store *read* error, or a *thrown* write, falls back to the in-memory limiter
  unless the caller passes `failClosed` — two different failures, two different
  answers. Tested since 2026-10-07 so each can fail: the failClosed case uses a fresh
  address the fallback would admit, a thrown-write case pins "never blanket-allow",
  and five barrier-synchronised readers pin the conditional write (each of the
  mutants — failClosed ignored, a thrown write returning allow, `onlyIfMatch` /
  `onlyIfNew` dropped — fails a case; before, all passed).
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

## Audit items filed against this kit

This repo has no `SECURITY_AUDIT.md`. The family security audit of 2026-09-26 lives
in each app's copy — the "Family-wide findings" table in market-monitor's
`SECURITY_AUDIT.md`, for one — and cites this kit's findings as `NK-n`: NK-1 in John's
News's JN-4 row, NK-5 in its JN-5, and NK-2, NK-3, NK-5 and NK-6 inside FAM-3, FAM-5
and FAM-6. The family-wide report that numbers them is in no repository (and no app
copy cites an NK-4), so the rows below are rebuilt from those references and from the
code, and kept here so an ID an app cites resolves to a status. A fix marked "version
bump" changes `index.js`, which all eight consumers then re-vendor (server-only
copies, so no site version bump on their side).

| ID | Audit finding | Status |
| --- | --- | --- |
| **NK-1** | SSRF time-of-check/time-of-use: `assertSafePublicUrl` vets a host with one `dns.lookup`, then `fetch()` resolves it again, so a rebinding DNS answer can differ between the check and the connection. JN-4's fix: pin the vetted address | **Open — needs a design, not a one-liner.** Global `fetch` takes no `lookup` hook and `index.js` imports nothing, so pinning means either a `node:https` request with a `lookup` that returns the vetted address (re-implementing `fetchHtmlGuarded`'s manual-redirect loop and its capped read over it) or an undici `dispatcher`, which needs the `undici` package. Bounded meanwhile, per the audit: an attacker has to control the DNS of a host a consumer fetches and win the race, and the function runtime exposes no metadata service. It applies to the start URL and to every hop |
| **NK-2** | Whether a spoofed `x-nf-client-connection-ip` lets a caller mint fresh rate-limit buckets (raised inside FAM-3) | **Undetermined; nothing to change here yet.** The audit could not tell it apart from FAM-3's baseline. `clientIp()` trusts that header first, which is right only because Netlify sets it itself — market-monitor's audit lists the inbound copy being stripped as a verified control. Revisit if a probe ever shows a caller-supplied value surviving |
| **NK-3** / FAM-5 | `raceProxyHtml` fetches each proxy with `redirect: 'follow'`, so a proxy's 3xx is followed unvetted. FAM-5's fix: `redirect: 'error'`, one line | **Open — measure first.** One line, but a version bump, and a proxy that legitimately answers with a redirect (to its own canonical host, say) would then lose every race silently, thinning the field. Before changing it, measure from Netlify's egress — not a dev box — whether corsproxy.io, api.allorigins.win and api.codetabs.com (the lists live in market-monitor, John's News and Surf-Tracker) ever answer 3xx. If one does, `redirect: 'manual'` plus `isSafeHttpsUrl` on each hop keeps it and still refuses an unsafe target |
| **NK-5** | The Blobs-backed limiter's key is `rl:${ip}:${windowStart}` (`checkRateLimitDistributed`), with no per-handler namespace, so every `distributed: true` endpoint on a site shares one bucket per IP. John's News's JN-5 waits on it, and market-monitor keeps its `/prefs` reads on the in-memory limiter for the same reason | **Open — a minor release.** An optional namespace in the key (for instance `createHandler`'s existing `name`). FAM-3's "make the distributed limiter the default" depends on it: as a default today, one endpoint's traffic would spend every other endpoint's budget. A changed key resets live counters once, which is harmless |
| **NK-6** / FAM-6 | `X-Content-Type-Options: nosniff` on every kit response shape | **Partly in place** (every shape built and inspected on 2026-10-01, under both `cors` settings). Present on the body-first JSON forms (`jsonBodyResponse`, the body-first `jsonResponse`, `ok`), on every error shape (`errorResponse` and its sugar, `upstreamError`), and on everything `createHandler` emits itself (405, 413, 429, 414, 500). **Missing** on the status-first JSON forms (`jsonStatusResponse`, the numeric-first `jsonResponse`) and on `textResponse`, under either setting. The bodiless 204s (`preflightResponse`, and `createHandler`'s OPTIONS answer under `cors: false`) carry none, which matters little with nothing to sniff. The fix is one header in two builders — a version bump |
| FAM-3 | The in-memory per-container limiter does not stop a parallel client — measured: 90 parallel requests to a 60/min endpoint, zero 429s, because Netlify spreads them over containers | **Open, and mostly the consumers'.** Kit-side: make the distributed limiter `createHandler`'s default — after NK-5, and as a deliberate release, because it puts a Blobs read and a conditional write on every request of every consumer endpoint. Until then each consumer opts its billed or keyed endpoints in (`distributed: true`) and adds per-upstream budgets, which is not this repo's to do |
| FAM-1(a) | The weekly bump ran unreviewed kit code under a write token | **Done in vendor-cli 0.21.10** (#63, 2026-09-26): the read-only `prepare` job and the write-scoped `bump` job described above. This repo's run 8 was the first under it |
| FAM-1(b) | `main` is not branch-protected on this public kit | **Owner setting, open.** The API reports `protected: false` for `main` on 2026-10-01. Protecting it needs a decision on how bot bump PRs satisfy a required check: they merge seconds after opening, and the `Test` run they get has no jobs (above) |

## Deferred and stuck

| Item | Current → target | Verdict | Why | What would change the answer |
| --- | --- | --- | --- | --- |
| `@jfs/vendor-cli` pin | `bef0be8` (0.21.10) → `692b387` (0.22.0, vendor-cli `main` since 2026-10-01) | **one behind, by cadence; the bump lands it** | run 8 (#45, the 2026-09-28 scheduled run) took it to 0.21.10, after run 7 (#44) took it from 0.21.7 to 0.21.8; vendor-cli #64 (0.22.0) merged three days later | nothing to do: next Monday's bump takes it. If that run goes red instead, the liveness monitor reports it |
| The Anthropic client — `callAnthropic`, `openAnthropicStream`, `normalizeEffort`, `parseModelJson`, `toBullets`, `ANTHROPIC_VERSION`, `DEFAULT_MODEL` (and the private `DEFAULT_ANTHROPIC_TIMEOUT_MS`) | retained, unused → removed | **deferred** | no first-party caller since 2026-09-30 (see "What nothing watches"), but it is an export removal: a minor release (0.11.0) that all eight consumers re-vendor, with the README's API section and `test.mjs`'s imports dropping the names in the same commit (`test-repo.mjs` fails otherwise). **Keep `userFacingReason`**: market-monitor's `analyze.mjs` calls it — at most give it a provider-neutral name behind an alias | re-run the code search for every name, and confirm that no consumer's `vendor:sync` passes a `--pick` naming any of them (on 2026-10-01 none passes `--pick` at all). Then remove it in a minor release, folding in the `index.js` comment fix CLAUDE.md defers, so the consumers re-vendor once |
| `kit-pin-bump.yml`'s schedule | `41 6 * * 1`, the minute every consumer's bump fires too | **hold** (the 2026-10-01 pass changed no workflow) | the same-cron race (see "Green CI is not delivered") leaves consumers one commit behind whenever this repo bumps itself — harmlessly here: a full surface is verbatim, so the lag changes only which vendor-cli the shim resolves, and the liveness monitor reads it as lagging, not stale | a lagging pin that matters (a generator fix a consumer needs that week): move this cron 30 minutes earlier, to Mondays 06:11 UTC, as news-kit did on 2026-10-01 |
| `.github/dependabot.yml` cooldown | none → `cooldown: default-days: 7` on both entries | **owner** | the canonical Dependencies text asks for it since vendor-cli 0.22.0 (FAM-4: a version update is proposed only once the release is 7 days old; security updates are never delayed). The 2026-10-01 session was not permitted to change the Dependabot configuration, so it is left for the owner; no CI check enforces it | the owner adding it — news-kit's `.github/dependabot.yml` has the shape |
| `claude/family-review-3urdej` (at `414cf2f`) | on the remote → deleted | **owner cleanup** | fully merged: GitHub's compare puts it 0 ahead and 7 behind `main` on 2026-10-01. Sessions do not delete branches | the owner deleting it |
| `engines.node` | `>=18` → `>=22` | hold, but decide it deliberately | nothing executes 18: CI rides family-ci's default 22 and this repo has no `.nvmrc` to point `node-version-file` at. `index.js` uses no builtin above 18 (measured: no `Object.groupBy`, `Promise.withResolvers`, `toSorted`, `structuredClone`, `findLast`), so raising the floor buys nothing today | an `index.js` change that wants a newer builtin, or a consumer's function runtime moving — then raise it in the same commit |
| npm majors | none open | — | zero open PRs on 2026-10-01. `npm outdated` lists one minor, `globals` 17.12.0 → 17.13.0, published that morning, which Dependabot's next Tuesday run proposes; `eslint` 10.11.0 and `@eslint/js` 10.0.1 are on their registry latest | Dependabot opening one. Then use the classes-of-proof table in the family block below: this kit's suite stubs `globalThis.fetch` and injects `fetchFn` / `fetchImpl` everywhere, so an HTTP-client major is proved by reading call sites, not by a green run |

One defect is documented and deliberately **not** fixed, and CLAUDE.md says why:
`looksLikeNumericIp`'s short-form IPv4 hole (`127.1`, `10.0.1`) is unreachable,
because `parseSafeHttpsUrl` runs `new URL()` first and the WHATWG parser normalizes
every numeric host form it accepts to dotted-decimal and refuses the rest. A test
pins the parser's behavior instead. Adding the "missing" final-label check would be
dead code. The one other follow-up CLAUDE.md names — `index.js`'s comment still
calling the start-URL DNS lookup "cached" — waits for the next version-bumping change
(the Anthropic removal above is the natural one); the code names none.

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
   `git ls-remote --tags --sort=v:refname origin | tail -1` and
   `node -p "require('./package.json').version"`. Today: `v0.10.0` and `0.10.0`.
   Keep the `--sort`: without it the tags sort as text and `tail -1` returns
   `v0.9.2` (this step said so until 2026-10-01). A version on `main` with no tag
   means `release.yml`'s `workflow_run` gate never fired (a push made with the
   default token creates no runs); `workflow_dispatch` on Release is the backfill
   path. Health is `Test` on `main` with event `push` or `workflow_dispatch` — the
   newest `Test` run overall is often a bump PR's zero-job red one, which is not a
   failure of anything (see "The red `Test` run on every bump PR").
2. **Did the weekly bump run, and where did it fail?** Open the `kit-pin-bump.yml`
   workflow page in this repo's Actions tab and read the **scheduled** run (or a
   later dispatch of it), not `main`'s colour. Since vendor-cli 0.21.10 the run has
   two jobs: a red `prepare` is this repo's — the install, the bump, or the check
   command against the bumped tree; a red *Open a pull request* step in `bump` with
   `not permitted to create or approve pull requests` is the repo setting under
   Settings → Actions → General, and no code change will help.
3. **Is work stranded?** `git ls-remote --heads origin 'refs/heads/auto/*'` against
   the open PR list. A branch with commits and no PR means the automation worked and
   could not deliver.
4. **Is the pin current?** `npx --no-install jfs-check-kit-pins` proves it *resolves*,
   not that it is current — it prints `all 1 kit pin(s) resolve.` either way. For
   currency, compare
   `node -p "require('./package.json').dependencies['@jfs/vendor-cli']"` against
   vendor-cli's `main` HEAD — and a commit newer than this repo's last bump run is
   the cadence, not a fault. `npm run kit-pins:bump` does the bump locally.
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
| 2026-10-07 | Family robustness evaluation | **Tests that could not fail, fixed (test.mjs only):** (1) the LRU-eviction regression test for SECURITY fix #12 flooded 5,100 keys before the active counter existed, so the pre-fix `buckets.clear()` wiped the map mid-flood and the test still passed against it (measured at `6cead82^`); the flood now stays under the cap, and a probe asserts the oldest idle key really was evicted. (2) The distributed limiter's `failClosed` read-error case reused an address the fallback had already limited, so it passed with `failClosed` ignored; it now uses a fresh address at max 60. (3) New cases for a thrown write ("never blanket-allow") and for the conditional write (five readers synchronised before any write; exactly `max` admitted). Each mutant — `clear()` back, `failClosed` ignored, a thrown write returning allow, `onlyIfMatch`/`onlyIfNew` dropped — fails a case now; before, all four passed the suite. **README:** `attemptTimeoutMs` bounds the wait for the HEADERS (its timer clears when `fetch` resolves, and with it set an `init.signal` budget stops reaching the body); the bullet said "bound the one attempt". A pin test holds the README to that. Changing the behaviour is a re-vendor in eight consumers for no current caller (none passes both) — left for the deferred minor release. IPv6 /64 bucket keying considered and not done: FC-1/FAM-3 already record that per-IP keying never bounds spend under address rotation, and /64 keying would put two dual-stack devices on one home network into one bucket. 121 cases (107 + 10 + 4). No `index.js` change, no version bump, nothing re-vendored. |
| 2026-10-01 | Docs and test drift pass | **Weekly, from the Actions API:** kit-pin bump runs 7 (2026-09-23, dispatched) and 8 (2026-09-28, scheduled) green — the first two of eight to deliver, each opening and merging its own PR as `github-actions[bot]` (#44 → `09a5e05`, vendor-cli 0.21.7 → 0.21.8; #45 → `96ce1ac`, → 0.21.10), so the owner turned the Actions PR-permission setting on by 2026-09-23. Each bump PR also left a zero-job `Test` run that failed within a second (#100, #101): not the validation, now documented. Newest `Test` on `main` green (#99, `5cc51ee`); the bot merges have none, as expected. No open PR, no `auto/*` branch; `claude/family-review-3urdej` (`414cf2f`) is still on the remote, fully merged — owner cleanup. The liveness monitor is watching (its token since 2026-09-23); its 2026-09-28 and 2026-10-01 reports list this repo ✓. **Fixed:** (1) `test-vendor.mjs` is fetch-kit's copy byte for byte, the parity fetch-kit's 2026-09-22 sweep asked for: stderr-matched refusals plus an esm `--pick` case. With `node_modules` moved aside the old file kept two cases green; the new one fails every CLI-driving case. 118/118 (104 + 10 + 4). (2) This file brought to current truth: the bump history and its two-job split, the bot PR's `Test` run, the liveness monitor, the version guard now running on dispatched runs (vendor-cli 0.21.8), the create-pull-request Node 20 warning (gone since vendor-cli #61), and diagnosis step 1's tag command, which sorted as text and returned `v0.9.2`. (3) The Anthropic client has no first-party caller since 2026-09-30 (Surf-Tracker #292, market-monitor #455) — GitHub code search plus a grep of every app's `origin/main`. `userFacingReason` is the exception (market-monitor's Gemini `analyze.mjs`). Its upstream-watch rows are retired, README and CLAUDE.md now say "retained, unused", and removal is a deferred minor release. (4) New "Audit items filed against this kit" section: NK-1, NK-2, NK-3 / FAM-5, NK-5, NK-6 / FAM-6 (every response shape inspected), FAM-3, FAM-1(a) done, FAM-1(b) owner. (5) The CLAUDE.md and MAINTENANCE.md family blocks re-synced to vendor-cli 0.22.0 (`692b387`) with the sync bins. **Not done:** the 7-day Dependabot cooldown the new canonical Dependencies text asks for — the session was not permitted to change `.github/dependabot.yml`, so it is the owner's (deferred table). **Delivery:** all eight consumers carry v0.10.0 (esm copies verbatim, cjs copies byte-identical to a fresh generation); seven pin `09a5e05` and market-monitor `96ce1ac` — the same-cron race, harmless for a full surface, recorded with news-kit's fix as the option. **Gate:** `node --check`, lint, 118/118, kit-pin pre-flight, both sync checks, `maintenance-doc-check`, prod audit 0. No `index.js` or `bin` change, so no version bump. |
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
| `dependabot-merge.yml` | when CI completes on a Dependabot PR | every bump that is minor or patch, squash-merged on green — except a grouped version update of a direct production dependency (a security update, which arrives ungrouped, still lands) | **every major**, **every grouped npm version update bumping a direct production dependency**, and any PR it can't parse |
| `kit-pin-bump.yml` | weekly, Mondays ~06:41 UTC — or the longer cadence a repo records in its half of this file | the `@jfs/*` pins, the re-vendor, the CLAUDE.md and MAINTENANCE.md family blocks, the version bump where the caller's command makes one | nothing, when it works |
| `release.yml` | CI green on `main` | the `v<version>` tag and its GitHub release | nothing |

Three gaps follow from that table and they are the whole reason this protocol
exists. They are not oversights; each is a deliberate refusal to automate a
judgement call, and each therefore needs a cadence instead.

**1. Majors and production bumps accumulate, and the backlog is not
inert.** A major is a judgement, not a merge, so `dependabot-merge.yml` leaves
it open. So is a minor or patch version update of a direct production
dependency: it deploys into the runtime that holds the keys, and the suites
fake the network, so green CI says nothing about what the release does — a
session reads it first. (A security update is not held: it arrives outside
the groups, and a published fix should not wait.) Nothing schedules the session that makes the judgement, and
`.github/dependabot.yml` caps open PRs. Once the cap is full of unreviewed
PRs, the development minor/patch PR — the one the automation *does* land —
stops being opened at all. The backlog turns from a to-do list into a block on
the working half of the pipeline.

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
   a scheduled run fails on its own page. Check the run, not the branch. A
   dispatch of the same workflow on the default branch since then is the
   same automation run by hand, and counts.
2. **Is there a stranded `auto/*` branch?** A branch with commits and no open
   PR means the automation did its work and could not deliver it. On any repo:
   `git ls-remote --heads origin 'refs/heads/auto/*'` against the open PR list.
3. **Are the `@jfs/*` pins actually current?** A pin that lacks a kit commit
   older than the repo's own last bump run is a bump that is not landing,
   whatever the workflow page says. A commit newer than that run is the
   cadence — a repo that bumps monthly lags its kits for up to a month by
   design. Compare against the run, not against hope.
4. **Is any bot PR older than seven days, red, or conflicted?** A production
   dependency's minor/patch PR that `dependabot-merge.yml` left open is the
   week's work, not a hold: read each package's release notes and what changed
   between the versions, then squash-merge it once CI is green. A bot PR held
   on PURPOSE — a major the triage below said to hold — carries the label
   `hold` AND is named as `#<number>` in this file's repo-specific half, with
   the reason and the condition that would lift it; the family monitor lists
   such a PR as held instead of reporting it. A `hold` label the file does not
   record is itself a finding, and mutes nothing.

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

The four questions under "Who watches the watchers" — question 4 includes
merging, after reading, the production bumps the merge workflow left open.
Nothing else.

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
the answer**, naming the PR as `#<number>` — and the PR gets the label `hold`.
The bot keeps the PR open either way; the table is what stops the next session
spending an hour re-deriving the same no, and the label plus the number is
what lets the family monitor tell a decision from a forgotten PR.

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
