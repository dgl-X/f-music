import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiRoute } from '../src/routing.js';

test('v1 routes are normalized without losing query parameters', () => {
  const route = resolveApiRoute('https://music.example/api/v1/tracks?liked=1');
  assert.equal(route.url.pathname, '/api/tracks');
  assert.equal(route.url.searchParams.get('liked'), '1');
  assert.equal(route.prefix, '/api/v1');
  assert.equal(route.legacy, false);
});

test('legacy API remains available and is marked legacy', () => {
  const route = resolveApiRoute('/api/health');
  assert.equal(route.url.pathname, '/api/health');
  assert.equal(route.prefix, '/api');
  assert.equal(route.legacy, true);
});

test('static and unknown version paths are not treated as API v1', () => {
  assert.equal(resolveApiRoute('/'), null);
  assert.equal(resolveApiRoute('/api-v1/tracks'), null);
});
