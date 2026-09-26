import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFederationService,
  decodeFederationInvitationCode,
  encodeFederationInvitationCode,
  externalFederationRequestUri,
  parseFederationSettingList,
  validateFederationEndpoints,
} from '../src/federation-service.js';

test('federation invitation code round-trips and rejects malformed envelopes', () => {
  const invitation = { version: 1, invitation_id: 'invite-1', secret: 'secret', expires_at: '2030-01-01T00:00:00.000Z' };
  assert.deepEqual(decodeFederationInvitationCode(encodeFederationInvitationCode(invitation)), invitation);
  assert.equal(decodeFederationInvitationCode('not-an-invitation'), null);
  assert.equal(decodeFederationInvitationCode(`fm-invite-v1:${'a'.repeat(17000)}`), null);
});

test('federation endpoint settings accept bounded HTTPS addresses only', () => {
  assert.deepEqual(validateFederationEndpoints([
    { url: 'https://music.example.test/', scope: 'public' },
    { url: 'https://10.20.30.40:8096', scope: 'private', priority: 5000 },
  ]), [
    { url: 'https://music.example.test', scope: 'public', priority: 0 },
    { url: 'https://10.20.30.40:8096', scope: 'private', priority: 1000 },
  ]);
  assert.throws(() => validateFederationEndpoints([{ url: 'http://music.example.test' }]), /HTTPS/);
  assert.throws(() => validateFederationEndpoints([{ url: 'https://user:pass@music.example.test' }]), /логин/);
  assert.throws(() => validateFederationEndpoints(Array.from({ length: 9 }, () => ({ url: 'https://music.example.test' }))), /не более 8/);
});

test('federation request URI trusts only the first forwarded authority', () => {
  const req = { headers: {
    host: 'internal.example.test',
    'x-forwarded-proto': 'https, http',
    'x-forwarded-host': 'music.example.test, proxy.internal',
  } };
  const url = new URL('http://local/federation/v1/catalog/delta?cursor=abc');
  assert.equal(externalFederationRequestUri(req, url), 'https://music.example.test/federation/v1/catalog/delta?cursor=abc');
});

test('federation settings normalize malformed and oversized stored values', async () => {
  const rows = [
    { key: 'federation_enabled', value: 'true' },
    { key: 'federation_endpoints', value: '[{"url":"https://music.example.test"}]' },
    { key: 'federation_export_policy', value: 'unexpected' },
    { key: 'federation_export_albums', value: JSON.stringify(['album-1', ...Array.from({ length: 1001 }, (_, index) => `album-${index + 2}`), 42]) },
    { key: 'federation_export_collections', value: 'invalid-json' },
  ];
  const db = { prepare() { return { async all() { return rows; } }; } };
  const settings = await createFederationService({ db }).settings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.export_policy, 'none');
  assert.equal(settings.selected_albums.length, 1000);
  assert.equal(settings.selected_albums[0], 'album-1');
  assert.deepEqual(settings.selected_collections, []);
  assert.deepEqual(parseFederationSettingList('{}'), []);
});

test('peer export policy and replay nonce stay behind the federation service', async () => {
  const calls = [];
  const db = { prepare(sql) { return {
    async all(...params) {
      calls.push({ method: 'all', sql, params });
      if (sql.includes('app_settings')) return [
        { key: 'federation_enabled', value: 'true' },
        { key: 'federation_export_policy', value: 'all' },
      ];
      if (sql.includes('export_collection_tracks')) return [{ track_id: 'track-1' }];
      return [];
    },
    async get(...params) {
      calls.push({ method: 'get', sql, params });
      if (sql.includes('export_rules')) return { policy: 'collections', selected_albums_json: '[]', selected_collections_json: '["mix"]' };
      if (sql.includes('federation_peers')) return { node_id: params[0], public_key: 'public-key' };
      return null;
    },
    async run(...params) {
      calls.push({ method: 'run', sql, params });
      return { changes: sql.startsWith('INSERT INTO federation_nonces') ? 1 : 0 };
    },
  }; } };
  const service = createFederationService({ db });
  const selected = await service.exportSettings('node-1');
  assert.equal(selected.export_policy, 'collections');
  assert.deepEqual(selected.selected_track_ids, ['track-1']);
  assert.deepEqual(await service.trustedPeer('node-1'), { node_id: 'node-1', public_key: 'public-key' });
  assert.equal(await service.consumeNonce('node-1', 'nonce-1', 1_700_000_000), true);
  const nonceInsert = calls.find(call => call.sql.startsWith('INSERT INTO federation_nonces'));
  assert.equal(nonceInsert.params[2], '2023-11-14T22:23:20.000Z');
});

test('pairing persistence consumes invitations and revokes trust exactly once', async () => {
  const calls = [];
  let consumeChanges = 1;
  let revokeInvitationChanges = 1;
  let revokePeerChanges = 1;
  const db = { prepare(sql) { return {
    async get(...params) {
      calls.push({ method: 'get', sql, params });
      if (sql.includes('FROM federation_invitations')) return { id: params[0], endpoint: 'https://peer.example.test' };
      return null;
    },
    async all() { return []; },
    async run(...params) {
      calls.push({ method: 'run', sql, params });
      if (sql.startsWith('UPDATE federation_invitations SET used_at')) return { changes: consumeChanges-- };
      if (sql.startsWith('UPDATE federation_invitations SET revoked_at')) return { changes: revokeInvitationChanges-- };
      if (sql.startsWith('UPDATE federation_peers SET status')) return { changes: revokePeerChanges-- };
      return { changes: 1 };
    },
  }; } };
  const service = createFederationService({ db });
  assert.equal((await service.invitation('invite-1', 'hash')).id, 'invite-1');
  assert.equal(await service.consumeInvitation('invite-1'), true);
  assert.equal(await service.consumeInvitation('invite-1'), false);
  await service.savePeer({ nodeId: 'fm:peer', label: 'Peer', publicKey: 'key', endpoint: 'https://peer.example.test', status: 'compatible', protocolMinor: 1, capabilities: { 'pairing.v1': 1 } });
  const peerWrite = calls.find(call => call.sql.startsWith('INSERT INTO federation_peers'));
  assert.equal(peerWrite.params[0], 'fm:peer');
  assert.equal(peerWrite.params[1], 'Peer');
  assert.equal(await service.revokeInvitation('invite-1'), true);
  assert.equal(await service.revokeInvitation('invite-1'), false);
  assert.equal(await service.revokePeer('fm:peer'), true);
  assert.equal(await service.revokePeer('fm:peer'), false);
});
