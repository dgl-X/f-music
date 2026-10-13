import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibraryHttpController } from '../src/library-http.js';

function harness({ rows = [], total = rows.length, onSql } = {}) {
  const responses = [];
  const db = {
    prepare(sql) {
      onSql?.(sql);
      return {
        async get() { return { count:total }; },
        async all() { return rows; },
      };
    },
  };
  const controller = createLibraryHttpController({
    db,
    queueOnlineSql:'peer_is_online = TRUE',
    encodeReference:(nodeId, objectId) => `${nodeId}.${objectId}`,
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses };
}

test('library controller ignores unrelated routes and methods', async () => {
  const { controller, responses } = harness();
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks'), { id:7 }, '/api/v1'), false);
  assert.equal(await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/library'), { id:7 }, '/api/v1'), false);
  assert.deepEqual(responses, []);
});

test('local library item keeps versioned cover and bounded pagination', async () => {
  const row = { kind:'local', id:'track-1', title:'Песня', liked:true, cover_key:'covers/a.jpg' };
  const { controller, responses } = harness({ rows:[row], total:2 });
  await controller.handle(
    { method:'GET' }, {}, new URL('https://music.test/api/library?scope=local&limit=999&offset=1'),
    { id:7 }, '/api/v1',
  );
  assert.deepEqual(responses[0], {
    status:200,
    value:{
      items:[{ id:'track-1', title:'Песня', liked:true, cover_url:'/api/v1/tracks/track-1/cover' }],
      total:2, limit:200, offset:1, has_more:false, scope:'local',
    },
  });
});

test('remote favorite exposes replica playback while its peer is offline', async () => {
  const row = {
    kind:'remote', id:'object-1', origin_node_id:'fm:node-1', title:'Удалённая',
    peer_status:'compatible', last_synced_at:null, sync_error:'offline',
    replica_status:'ready', label:'Дом', endpoint:'https://node.test',
  };
  const { controller, responses } = harness({ rows:[row] });
  await controller.handle(
    { method:'GET' }, {}, new URL('https://music.test/api/favorites'),
    { id:7 }, '/api/v1',
  );
  const item = responses[0].value.items[0];
  assert.equal(item.id, 'remote:fm:node-1.object-1');
  assert.equal(item.liked, true);
  assert.equal(item.availability, 'offline');
  assert.equal(item.stream_available, true);
  assert.equal(item.source_label, 'Дом');
});

test('queue request applies online filter and permits a ten-thousand item page', async () => {
  const statements = [];
  const { controller, responses } = harness({ onSql:sql => statements.push(sql) });
  await controller.handle(
    { method:'GET' }, {}, new URL('https://music.test/api/library?scope=remote&queue=1&limit=10000'),
    { id:7 }, '/api/v1',
  );
  assert.equal(responses[0].value.limit, 10000);
  assert.equal(statements.some(sql => sql.includes('peer_is_online = TRUE')), true);
  assert.equal(statements.some(sql => sql.includes("FROM tracks WHERE TRUE")), false);
});

test('invalid scope falls back to the combined library', async () => {
  const statements = [];
  const { controller, responses } = harness({ onSql:sql => statements.push(sql) });
  await controller.handle(
    { method:'GET' }, {}, new URL('https://music.test/api/library?scope=unknown'),
    { id:7 }, '/api/v1',
  );
  assert.equal(responses[0].value.scope, 'all');
  assert.equal(statements.some(sql => sql.includes('UNION ALL')), true);
});
