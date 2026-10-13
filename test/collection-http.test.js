import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectionHttpController } from '../src/collection-http.js';

function harness(catalog = {}, overrides = {}) {
  const responses = [];
  const controller = createCollectionHttpController({
    catalog,
    db:overrides.db || { prepare() { throw new Error('unexpected database access'); } },
    encodeReference:(nodeId, objectId) => `${nodeId}.${objectId}`,
    decodeReference:overrides.decodeReference || (() => { throw new Error('invalid reference'); }),
    readJson:overrides.readJson || (async () => ({})),
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses };
}

test('collection controller ignores unrelated routes', async () => {
  const { controller, responses } = harness();
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks'), { id:7 }, '/api/v1'), false);
  assert.deepEqual(responses, []);
});

test('playlist list stays scoped to the current user', async () => {
  let input;
  const page = { items:[], total:0 };
  const { controller, responses } = harness({ async listPlaylists(value) { input = value; return page; } });
  await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/playlists?limit=20'), { id:7 }, '/api/v1');
  assert.equal(input.userId, 7);
  assert.equal(input.searchParams.get('limit'), '20');
  assert.deepEqual(responses[0], { status:200, value:page });
});

test('playlist creation preserves validation errors', async () => {
  const { controller, responses } = harness(
    { async createPlaylist() { return { status:'invalid' }; } },
    { readJson:async () => ({ title:' ' }) },
  );
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/playlists'), { id:7 }, '/api/v1');
  assert.deepEqual(responses[0], { status:400, value:{ error:'Введите название плейлиста' } });
});

test('history records only existing local tracks', async () => {
  const { controller, responses } = harness(
    { async recordHistory() { return false; } },
    { readJson:async () => ({ track_id:'missing' }) },
  );
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/history'), { id:7 }, '/api/v1');
  assert.deepEqual(responses[0], { status:404, value:{ error:'Трек не найден' } });
});

test('remote playlist rejects an invalid reference before database mutation', async () => {
  const { controller, responses } = harness({ async getOwnedPlaylist() { return { id:'playlist-1' }; } });
  await controller.handle(
    { method:'POST' }, {}, new URL('https://music.test/api/playlists/abc/remote?ref=broken'),
    { id:7 }, '/api/v1',
  );
  assert.deepEqual(responses[0], { status:400, value:{ error:'Некорректная ссылка на удалённый трек' } });
});
