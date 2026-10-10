import assert from 'node:assert/strict';
import test from 'node:test';
import { FEDERATION_QUEUE_ONLINE_SQL, createFederationAvailabilityService, federationCircuitDelay, federationHealthDelay, federationPeerAvailability } from '../src/federation-availability.js';

test('federation circuit opens after repeated failures and stays bounded', () => {
  assert.equal(federationCircuitDelay(1), 0);
  assert.equal(federationCircuitDelay(2), 30);
  assert.equal(federationCircuitDelay(3), 60);
  assert.equal(federationCircuitDelay(20), 900);
});

test('federation health checks back off without polling dead nodes continuously', () => {
  assert.equal(federationHealthDelay(1), 30);
  assert.equal(federationHealthDelay(2), 60);
  assert.equal(federationHealthDelay(20), 900);
});

test('health check restores only the expected peer identity', async () => {
  const updates = [];
  const peers = [
    { node_id:'fm:expected', endpoint:'https://one.example', health_failures:2 },
    { node_id:'fm:other', endpoint:'https://two.example', health_failures:0 },
  ];
  const db = { prepare(sql) { return {
    all: async () => peers,
    run: async (...params) => { updates.push({ sql, params }); return { changes:1 }; },
  }; } };
  const service = createFederationAvailabilityService({ db });
  await service.check(async endpoint => ({ node_id:endpoint.includes('one') ? 'fm:expected' : 'fm:wrong' }));
  assert.match(updates[0].sql, /health_failures=0/);
  assert.deepEqual(updates[0].params, ['fm:expected']);
  assert.match(updates[1].sql, /health_failures=\?/);
  assert.equal(updates[1].params.at(-1), 'fm:other');
});

test('manual peer check validates identity and queues catalog sync', async () => {
  const updates = [];
  const peer = { node_id:'fm:expected-node-1234', endpoint:'https://peer.example', health_failures:1 };
  const db = { prepare(sql) { return {
    get: async () => peer,
    run: async (...params) => { updates.push({ sql, params }); return { changes:1 }; },
  }; } };
  const service = createFederationAvailabilityService({ db });
  const result = await service.checkPeer(peer.node_id, async () => ({ node_id:peer.node_id }));
  assert.equal(result.ok, true);
  assert.equal(result.node_id, peer.node_id);
  assert.equal(result.sync_queued, true);
  assert.match(updates[0].sql, /next_sync_at=LEAST/);
});

test('manual peer check rejects an unknown peer', async () => {
  const db = { prepare() { return { get: async () => undefined }; } };
  const service = createFederationAvailabilityService({ db });
  assert.equal(await service.checkPeer('fm:missing-node-1234', async () => ({})), null);
});

test('queue availability requires fresh sync and a closed stream circuit', () => {
  assert.match(FEDERATION_QUEUE_ONLINE_SQL, /last_synced_at>=CURRENT_TIMESTAMP/);
  assert.match(FEDERATION_QUEUE_ONLINE_SQL, /stream_unavailable_until/);
  const now = Date.parse('2026-09-26T10:00:00Z');
  const peer = { status:'compatible', last_synced_at:'2026-09-26T09:55:00Z' };
  assert.equal(federationPeerAvailability(peer, now), 'online');
  assert.equal(federationPeerAvailability({ ...peer, last_synced_at:'2026-09-26T09:40:00Z' }, now), 'offline');
  assert.equal(federationPeerAvailability({ ...peer, stream_unavailable_until:'2026-09-26T10:01:00Z' }, now), 'offline');
  assert.equal(federationPeerAvailability({ ...peer, revoked_at:'2026-09-26T09:00:00Z' }, now), 'revoked');
});
