// ESLint flat config. Goal: catch shadows / unused vars / undefined
// references going forward without forcing a sweeping style cleanup — CI
// should flag real bugs, not stylistic preferences.
//
// A bug here reaches every consumer's vendored copy on their next pin bump,
// and that copy lands as bundler output nobody reads line by line — which is
// why the kits lint at all.
//
// This kit is SERVER-side: Netlify Functions on Node, with the web-platform
// globals (fetch, Request/Response, AbortSignal, URL) built in. It gets the
// Node set plus the browser set for those, and deliberately NOT the DOM-only
// ones a function can never have.
import js from '@eslint/js';
import globals from 'globals';

const rules = {
  'no-shadow': 'error',
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_?$',
  }],
  'no-undef': 'error',
  'no-redeclare': 'error',
  // A deliberate best-effort swallow (a Blobs store that isn't configured, a
  // cache write that fails) is allowed, but should say why.
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-useless-escape': 'off',
  'prefer-const': 'off',
  // OFF, deliberately: the vendor suite matches a known two-space indent in
  // generated output, where `/^  (\w+): /` reads better than `/^ {2}(\w+): /`.
  'no-regex-spaces': 'off',
  // OFF, deliberately: the SSRF and header guards strip control characters,
  // so the rule fires on the security code rather than on a mistake.
  'no-control-regex': 'off',
};

export default [
  js.configs.recommended,
  {
    files: ['index.js', 'bin/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules,
  },
  { ignores: ['node_modules/**'] },
];
