# @jfs/netlify-kit — working notes for Claude

Shared, dependency-free Netlify Functions primitives (CORS + preflight,
JSON/text/error responses, capped body reads, input validation, SSRF
guards, retry-with-backoff fetch, per-IP rate limiting, a Blobs store
opener + short-TTL cache, a `createHandler` boundary, and a hardened
Anthropic Messages-API client) extracted from the JFS family of buildless
static sites. Consumers vendor this kit via its own CLI rather than
installing it at runtime, so a change here reaches an app only once that
app bumps its pin and re-runs `vendor:sync`.

## Pull requests

Open pull requests **ready for review — never as drafts.** This applies to
PRs opened by automated Claude Code sessions too: some hosted environments
default to creating drafts, so mark the PR ready as part of opening it
rather than leaving it for a follow-up.
