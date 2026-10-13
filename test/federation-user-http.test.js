import assert from 'node:assert/strict';
import test from 'node:test';
import { createFederationUserHttpController } from '../src/federation-user-http.js';

function harness(overrides = {}) {
  const responses = [];
  const controller = createFederationUserHttpController({
    db:overrides.db || { prepare() { throw new Error('unexpected database access'); } },
    media:overrides.media || {},
    queueOnlineSql:'TRUE',
    encodeReference:(nodeId, objectId) => `${nodeId}:${objectId}`,
    decodeReference:overrides.decodeReference || (value => {
      if (value === 'valid-ref') return { nodeId:'fm:trusted-node-001', objectId:'track-1' };
      throw new Error('invalid reference');
    }),
    sourceId:(nodeId, objectId) => `${nodeId}\n${objectId}`,
    removeReplicaFiles:overrides.removeReplicaFiles || (() => {}),
    readJson:overrides.readJson || (async () => ({})),
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses };
}

test('federation user controller ignores unrelated routes', async () => {
  const { controller, responses } = harness();
  const handled = await controller.handle(
    { method:'GET', headers:{} }, {}, new URL('https://music.test/api/tracks'), { id:7 }, '/api/v1',
  );
  assert.equal(handled, false);
  assert.deepEqual(responses, []);
});

test('short federation search returns an empty bounded page without database work', async () => {
  const { controller, responses } = harness();
  await controller.handle(
    { method:'GET', headers:{} }, {}, new URL('https://music.test/api/federation/search?q=x'), { id:7 }, '/api/v1',
  );
  assert.deepEqual(responses[0], {
    status:200,
    value:{ items:[], artists:[], albums:[], total:0, offset:0, limit:30, has_more:false },
  });
});

test('invalid remote reference is rejected before media or database access', async () => {
  const { controller, responses } = harness();
  await controller.handle(
    { method:'GET', headers:{} }, {}, new URL('https://music.test/api/federation/track?ref=broken'), { id:7 }, '/api/v1',
  );
  assert.deepEqual(responses[0], { status:400, value:{ error:'Некорректная ссылка на удалённый трек' } });
});

test('remote stream delegates original quality and byte range unchanged', async () => {
  let input;
  const { controller, responses } = harness({
    media:{ async proxyRemote(_req, _res, value) { input = value; } },
  });
  await controller.handle(
    { method:'GET', headers:{ range:'bytes=10-99' } }, {},
    new URL('https://music.test/api/federation/stream?ref=valid-ref&quality=original'),
    { id:7 }, '/api/v1',
  );
  assert.deepEqual(input, { nodeId:'fm:trusted-node-001', objectId:'track-1', quality:'original', range:'bytes=10-99' });
  assert.deepEqual(responses, []);
});

test('node listing preserves its response envelope', async () => {
  const items = [{ node_id:'fm:trusted-node-001', track_count:12 }];
  const { controller, responses } = harness({
    db:{ prepare() { return { async all() { return items; } }; } },
  });
  await controller.handle(
    { method:'GET', headers:{} }, {}, new URL('https://music.test/api/federation/nodes'), { id:7 }, '/api/v1',
  );
  assert.deepEqual(responses[0], { status:200, value:{ items } });
});
