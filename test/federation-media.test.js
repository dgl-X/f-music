import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFederationRange } from '../src/federation-media.js';

test('federation media range accepts full and bounded requests', () => {
  assert.deepEqual(parseFederationRange('', 1000), { start:0, end:999, status:200 });
  assert.deepEqual(parseFederationRange('bytes=100-199', 1000), { start:100, end:199, status:206 });
  assert.deepEqual(parseFederationRange('bytes=900-', 1000), { start:900, end:999, status:206 });
  assert.deepEqual(parseFederationRange('bytes=-100', 1000), { start:900, end:999, status:206 });
});

test('federation media range rejects malformed and impossible requests', () => {
  assert.equal(parseFederationRange('items=0-1', 1000), null);
  assert.equal(parseFederationRange('bytes=1000-', 1000), null);
  assert.equal(parseFederationRange('bytes=500-100', 1000), null);
  assert.equal(parseFederationRange('bytes=a-b', 1000), null);
});
