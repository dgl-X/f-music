import assert from 'node:assert/strict';
import test from 'node:test';
import { createFederationAdminHttpController } from '../src/federation-admin-http.js';

function harness(overrides = {}) {
  const responses = [];
  const federation = overrides.federation || {
    async settings() { return { enabled:false, endpoints:[] }; },
    async listInvitations() { return []; },
    async listPeers() { return []; },
  };
  const controller = createFederationAdminHttpController({
    db:overrides.db || { prepare() { throw new Error('unexpected database access'); } },
    federation,
    availability:overrides.availability || {},
    pairing:overrides.pairing || {},
    loadIdentity:overrides.loadIdentity || (() => null),
    ensureIdentity:overrides.ensureIdentity || (() => null),
    validateEndpoints:value => value,
    parseSettingList:value => JSON.parse(value),
    decodeInvitationCode:overrides.decodeInvitationCode || (() => null),
    encodeInvitationCode:() => 'code',
    probeEndpoint:overrides.probeEndpoint || (async () => ({})),
    randomId:() => '00000000-0000-4000-8000-000000000001',
    randomToken:() => 'secret',
    tokenHash:value => `hash:${value}`,
    appendVisibilityEvents:async () => {},
    appendTrackRefreshEvents:async () => {},
    readJson:overrides.readJson || (async () => ({})),
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses };
}

test('federation administration stays unavailable to regular users', async () => {
  const { controller, responses } = harness();
  const handled = await controller.handle(
    { method:'GET' }, {}, new URL('https://music.test/api/admin/federation/peers'),
    { id:7, is_admin:false },
  );
  assert.equal(handled, true);
  assert.deepEqual(responses[0], { status:403, value:{ error:'Доступно только администратору' } });
});

test('federation admin controller ignores unrelated routes', async () => {
  const { controller, responses } = harness();
  const handled = await controller.handle(
    { method:'GET' }, {}, new URL('https://music.test/api/tracks'),
    { id:1, is_admin:true },
  );
  assert.equal(handled, false);
  assert.deepEqual(responses, []);
});

test('peer listing preserves its response envelope', async () => {
  const peer = { node_id:'fm:trusted-node-001', status:'compatible' };
  const { controller, responses } = harness({
    federation:{ async listPeers() { return [peer]; } },
  });
  await controller.handle(
    { method:'GET' }, {}, new URL('https://music.test/api/admin/federation/peers'),
    { id:1, is_admin:true },
  );
  assert.deepEqual(responses[0], { status:200, value:{ items:[peer] } });
});

test('invitation creation requires enabled federation identity', async () => {
  const { controller, responses } = harness();
  await controller.handle(
    { method:'POST' }, {}, new URL('https://music.test/api/admin/federation/invitations'),
    { id:1, is_admin:true },
  );
  assert.deepEqual(responses[0], { status:409, value:{ error:'Сначала создайте identity и включите федерацию' } });
});

test('endpoint check keeps probe errors stable', async () => {
  const { controller, responses } = harness({
    readJson:async () => ({ url:'https://offline.test', scope:'public' }),
    probeEndpoint:async () => { throw Object.assign(new Error('Нода недоступна'), { code:'connect_failed' }); },
  });
  await controller.handle(
    { method:'POST' }, {}, new URL('https://music.test/api/admin/federation/check-endpoint'),
    { id:1, is_admin:true },
  );
  assert.deepEqual(responses[0], { status:422, value:{ error:'Нода недоступна', code:'connect_failed' } });
});
