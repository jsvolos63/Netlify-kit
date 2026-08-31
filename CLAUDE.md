# @jfs/netlify-kit — working notes for Claude

Shared, dependency-free Netlify Functions primitives (CORS + preflight,
JSON/text/error responses, capped body reads, input validation, SSRF
guards, the guarded article fetch behind the family's reader extract
functions — per-hop-revalidated redirects + the CORS-proxy race —
retry-with-backoff fetch, per-IP rate limiting, a Blobs store
opener + short-TTL cache, a `createHandler` boundary, and a hardened
Anthropic Messages-API client) extracted from the JFS family of buildless
static sites. Consumers vendor this kit via its own CLI rather than
installing it at runtime, so a change here reaches an app only once that
app bumps its pin and re-runs `vendor:sync`.

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

<!-- jfs-family-conventions:end -->
