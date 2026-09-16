import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioMemoryCache } from '../public/audio-cache.js';

function fixture({ maxBytes = 12, maxTrackBytes = 8 } = {}) {
  const requests = [], revoked = [];
  const cache = new AudioMemoryCache({
    maxBytes, maxTrackBytes,
    fetcher: async (source, options) => {
      requests.push({ source, options });
      return { ok: true, headers: { get: () => '5' }, blob: async () => ({ size: 5 }) };
    },
    createUrl: () => `blob:track-${requests.length}`,
    revokeUrl: url => revoked.push(url),
  });
  return { cache, requests, revoked };
}

test('audio cache reuses completed download and sends no-store request', async () => {
  const { cache, requests } = fixture();
  assert.equal(await cache.load('a', '/a'), 'blob:track-1');
  assert.equal(await cache.load('a', '/a'), 'blob:track-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.cache, 'no-store');
});

test('audio cache evicts least recently used track but keeps playing one', async () => {
  const { cache, revoked } = fixture();
  await cache.load('a', '/a');
  cache.pin('a');
  await cache.load('b', '/b');
  await cache.load('c', '/c');
  assert.equal(cache.get('a'), 'blob:track-1');
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('c'), 'blob:track-3');
  assert.deepEqual(revoked, ['blob:track-2']);
});

test('audio cache skips oversized tracks', async () => {
  const { cache, revoked } = fixture({ maxTrackBytes: 4 });
  assert.equal(await cache.load('a', '/a'), null);
  assert.equal(cache.entries.size, 0);
  assert.deepEqual(revoked, []);
});
