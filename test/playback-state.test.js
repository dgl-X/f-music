import assert from 'node:assert/strict';
import test from 'node:test';
import { savePlaybackState } from '../src/playback-state.js';

const input = db => ({ db, userId: 2, trackId: 'track-1', remoteTrackRef: null, decodedRemote: null,
  position: 12, queue: ['track-1'], shuffle: true, repeatMode: 'all', queueSource: 'Library' });

test('playback state locks the current track before writing it', async () => {
  const calls = [];
  const tx = { prepare(sql) { return {
    async get(...params) { calls.push({ type: 'get', sql, params }); return { id: 'track-1' }; },
    async run(...params) { calls.push({ type: 'run', sql, params }); },
  }; } };
  const db = { async transaction(callback) { return callback(tx); } };
  assert.equal(await savePlaybackState(input(db)), true);
  assert.match(calls[0].sql, /FOR KEY SHARE/);
  assert.match(calls[1].sql, /INSERT INTO playback_state/);
  assert.deepEqual(calls[1].params.slice(0, 4), [2, 'track-1', null, 12]);
});

test('playback state rejects a track deleted before the transaction lock', async () => {
  let writes = 0;
  const tx = { prepare() { return { async get() { return undefined; }, async run() { writes += 1; } }; } };
  const db = { async transaction(callback) { return callback(tx); } };
  assert.equal(await savePlaybackState(input(db)), false);
  assert.equal(writes, 0);
});
