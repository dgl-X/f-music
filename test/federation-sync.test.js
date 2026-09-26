import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createFederationSyncService, federationRetryDelay } from '../src/federation-sync.js';

test('federation retry backoff is bounded and supports deterministic jitter', () => {
  assert.equal(federationRetryDelay(1, 0), 15);
  assert.equal(federationRetryDelay(2, 0.99), 39);
  assert.equal(federationRetryDelay(20, 0.99), 3609);
});

test('catalog delta keeps cursor, page limit and signed v1 envelope', async () => {
  const calls = [];
  const rows = [
    { revision: 4, event_type:'track.upsert.v1', object_id:'track-1', payload_json:{ title:'One' }, occurred_at:'2026-01-01T00:00:00Z', current_album:'' },
    { revision: 5, event_type:'track.delete.v1', object_id:'track-2', payload_json:{}, occurred_at:'2026-01-01T00:00:01Z', current_album:null },
  ];
  const db = { prepare(sql) { return { async all(...params) { calls.push({ sql, params }); return rows; } }; } };
  const federation = { async exportSettings() { return { export_policy:'all', selected_albums:[], selected_track_ids:[] }; } };
  const service = createFederationSyncService({ db, federation });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const identity = { node_id:'fm:test-node', private_key_pem:privateKey.export({ type:'pkcs8', format:'pem' }) };
  const result = await service.delta({ peerNodeId:'fm:peer', identity, cursor:'', limit:1 });
  const envelope = JSON.parse(result.body.toString('utf8'));
  assert.equal(envelope.protocol_version, 1);
  assert.equal(envelope.items.length, 1);
  assert.equal(envelope.items[0].object_id, 'track-1');
  assert.equal(envelope.has_more, true);
  assert.equal(typeof result.headers['x-family-music-response-signature'], 'string');
  assert.deepEqual(calls[0].params, [0, 2]);
});

test('catalog notify validates revision before scheduling peer sync', async () => {
  const writes = [];
  const db = { prepare(sql) { return { async run(...params) { writes.push({ sql, params }); return { changes:1 }; } }; } };
  const service = createFederationSyncService({ db, federation:{} });
  assert.deepEqual(await service.acceptNotification('fm:peer', '42'), { accepted:true, latest_revision:42 });
  assert.deepEqual(writes[0].params, [42, 'fm:peer']);
  await assert.rejects(() => service.acceptNotification('fm:peer', '-1'), error => error.code === 'invalid_revision');
  await assert.rejects(() => service.acceptNotification('fm:peer', '1.5'), error => error.code === 'invalid_revision');
});
