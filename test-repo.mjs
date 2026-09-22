// Cross-file invariants of THIS repository: pairs whose two halves live in
// different files, which MAINTENANCE.md held as prose until 2026-09-22. Prose
// did not hold them — when they were written down, the weekly bump was
// validating a bumped tree with two of the three commands a pull request
// runs, and the README described a test command that skipped a whole suite.
//
// Every reader here THROWS when it cannot find what it compares: a check that
// quietly passes on a renamed key or a reshaped workflow is worse than no
// check at all, because it reads as a guarantee.
//
// Unlike test-vendor.mjs, which is the same file in every @jfs kit, this one
// is specific to this repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kit from './index.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(DIR, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

const TEST_YML = '.github/workflows/test.yml';
const BUMP_YML = '.github/workflows/kit-pin-bump.yml';

/** The value a workflow passes for `key` under `with:`. A `|` block scalar
 *  comes back as its non-blank, non-comment lines, trimmed; a plain scalar as
 *  its text. Throws unless the key appears exactly once, so a rename or a
 *  duplicate fails the test rather than satisfying it. */
function workflowInput(file, key) {
  const lines = read(file).split('\n');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp(`^(\\s*)${escaped}:\\s*(.*?)\\s*$`);
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(keyRe);
    if (m) hits.push({ i, indent: m[1].length, value: m[2] });
  });
  if (hits.length !== 1) {
    throw new Error(`${file}: expected exactly one "${key}:" line, found ${hits.length}`);
  }
  const { i, indent, value } = hits[0];
  if (value !== '|') return value.replace(/^(['"])(.*)\1$/, '$2');
  const block = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    const cmd = line.trim();
    if (!cmd.startsWith('#')) block.push(cmd);
  }
  if (block.length === 0) throw new Error(`${file}: "${key}: |" has an empty block`);
  return block;
}

test('the weekly bump validates a bumped tree with exactly the commands CI runs on a pull request', () => {
  // kit-pin-bump.yml's check step is the ONLY gate a bump gets: a PR opened
  // with the default token fires no pull_request run. When the two lists
  // diverged, a bump skipped `npm run lint` that every PR had to pass.
  const ci = workflowInput(TEST_YML, 'run');
  const bump = workflowInput(BUMP_YML, 'check-command');
  assert.ok(ci.includes('npm test'), `${TEST_YML} no longer runs npm test — the reader is misparsing`);
  assert.deepEqual(bump, ci, `${BUMP_YML} check-command must match ${TEST_YML} run`);
});

test('every file the package ships sits under the version guard, and nothing else does', () => {
  // Consumers pin by SHA and releases tag by version, so a shipped change with
  // no bump puts two different SHAs under one version label. The guard only
  // knows the paths it is handed; a third entry added to `files` would sit
  // outside it and ship unbumped.
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json has no `files` list');
  const guarded = workflowInput(TEST_YML, 'version-guard-paths').split(/\s+/).filter(Boolean);
  assert.deepEqual([...guarded].sort(), [...pkg.files].sort());
});

test('every entry point package.json names is inside a shipped path', () => {
  const shipped = (p) => {
    const rel = p.replace(/^\.\//, '');
    return pkg.files.some((f) => rel === f || rel.startsWith(`${f}/`));
  };
  const entries = [pkg.main, ...Object.values(pkg.exports || {}), ...Object.values(pkg.bin || {})];
  assert.ok(entries.length >= 3, 'expected main, an export and a bin');
  for (const entry of entries) assert.ok(shipped(entry), `${entry} is not covered by package.json files`);
});

test('every export is documented in the README API section and imported by the suite', () => {
  const names = Object.keys(kit);
  assert.ok(names.length > 0, 'index.js exports nothing — the import failed to resolve');

  // The README's `## API` section, up to the next second-level heading.
  const readme = read('README.md');
  const from = readme.indexOf('\n## API\n');
  assert.ok(from !== -1, 'README.md has no "## API" section');
  const next = readme.indexOf('\n## ', from + 1);
  const api = readme.slice(from, next === -1 ? undefined : next);
  const undocumented = names.filter((n) => !new RegExp('`' + n + '(?![A-Za-z0-9_$])').test(api));
  assert.deepEqual(undocumented, [], 'exports missing from the README API section');

  // test.mjs's import list from './index.js'. Being imported is a floor, not a
  // proof of coverage — but an export nobody even imports has no test at all.
  const suite = read('test.mjs');
  const m = suite.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/index\.js';/);
  assert.ok(m, "test.mjs has no `import { … } from './index.js'` block");
  const imported = new Set(m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
  const untested = names.filter((n) => !imported.has(n));
  assert.deepEqual(untested, [], 'exports test.mjs does not import');
});
