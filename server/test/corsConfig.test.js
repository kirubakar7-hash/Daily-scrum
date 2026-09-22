import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCorsOrigin } from '../src/lib/corsConfig.js';

// The bug this fixes: production used to hard-refuse to start (process.exit(1)) whenever CORS_ORIGIN was
// unset, even though this app's supported production deployment (Vercel) is single-origin and same-origin
// requests never go through CORS at all. These tests cover the corrected contract directly, without
// needing to spin up the whole app (env vars baked in at import time would make that awkward to vary).

test('resolveCorsOrigin — same-origin production (CORS_ORIGIN unset) does not fail, and does not open wide', () => {
  const result = resolveCorsOrigin(undefined, 'production');
  assert.equal(result, false, 'unset in production must refuse cross-origin, never crash and never default to wide-open');
});

test('resolveCorsOrigin — an explicitly configured production origin is honored exactly, not widened', () => {
  const result = resolveCorsOrigin('https://app.example.com', 'production');
  assert.deepEqual(result, ['https://app.example.com']);
});

test('resolveCorsOrigin — multiple comma-separated production origins are all honored', () => {
  const result = resolveCorsOrigin('https://a.example.com, https://b.example.com', 'production');
  assert.deepEqual(result, ['https://a.example.com', 'https://b.example.com']);
});

test('resolveCorsOrigin — never returns a bare wildcard, configured or not', () => {
  assert.notEqual(resolveCorsOrigin(undefined, 'production'), '*');
  assert.notEqual(resolveCorsOrigin('https://app.example.com', 'production'), '*');
});

test('resolveCorsOrigin — unset in local dev stays open for convenience (Vite runs on a different port)', () => {
  assert.equal(resolveCorsOrigin(undefined, 'development'), true);
  assert.equal(resolveCorsOrigin(undefined, undefined), true);
});

test('resolveCorsOrigin — an explicit origin is still honored even outside production', () => {
  assert.deepEqual(resolveCorsOrigin('http://localhost:5173', 'development'), ['http://localhost:5173']);
});
