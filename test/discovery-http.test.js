import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryHttpController } from '../src/discovery-http.js';

function harness({ catalog = {}, db, body = {}, decodeReference, now } = {}) {
  const responses = [];
  const controller = createDiscoveryHttpController({
    catalog,
    db:db || { prepare() { throw new Error('unexpected database access'); } },
    decodeReference:decodeReference || (() => { throw new Error('invalid reference'); }),
    readJson:async () => body,
    sendJson(_res, status, value) { responses.push({ status, value }); },
    now,
  });
  return { controller, responses };
}

test('discovery controller ignores unrelated routes', async () => {
  const { controller, responses } = harness();
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/history'), { id:7 }, '/api/v1'), false);
  assert.deepEqual(responses, []);
});

test('track catalog delegates user, query and API prefix', async () => {
  let input;
  const page = { items:[], total:0 };
  const { controller, responses } = harness({ catalog:{ async listTracks(value) { input = value; return page; } } });
  await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks?limit=50'), { id:7 }, '/api/v1');
  assert.equal(input.userId, 7);
  assert.equal(input.searchParams.get('limit'), '50');
  assert.equal(input.responsePrefix, '/api/v1');
  assert.deepEqual(responses[0], { status:200, value:page });
});

test('empty queue resolution avoids database access', async () => {
  const { controller, responses } = harness({ body:{ ids:['broken', 'broken'] } });
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/tracks/resolve'), { id:7 }, '/api/v1');
  assert.deepEqual(responses[0], { status:200, value:{ items:[] } });
});

test('queue resolution preserves requested order and drops missing tracks', async () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const db = { prepare() { return { async all() { return [{ id:second, title:'Второй', cover_key:null }, { id:first, title:'Первый', cover_key:'covers/a.jpg' }]; } }; } };
  const { controller, responses } = harness({ db, body:{ ids:[first, 'missing', second, first] } });
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/tracks/resolve'), { id:7 }, '/api/v1');
  assert.deepEqual(responses[0].value.items.map(item => item.id), [first, second]);
  assert.equal(responses[0].value.items[0].cover_url, `/api/v1/tracks/${first}/cover`);
});

test('recommendations are stable for a user and calendar day', async () => {
  const tracks = [
    { id:'a', title:'A', artist:'Artist', genre:'Rock', liked:true, play_count:3, created_at:'2026-10-01T00:00:00Z', last_played_at:'2026-10-10T00:00:00Z', cover_key:null },
    { id:'b', title:'B', artist:'Artist', genre:'Rock', liked:false, play_count:0, created_at:'2026-10-02T00:00:00Z', last_played_at:null, cover_key:null },
  ];
  const db = { prepare() { return { async all() { return tracks; } }; } };
  const now = () => new Date('2026-10-13T12:00:00Z');
  const first = harness({ db, now }), second = harness({ db, now });
  await first.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/recommendations'), { id:7 }, '/api/v1');
  await second.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/recommendations'), { id:7 }, '/api/v1');
  assert.equal(first.responses[0].value.generated_for, '2026-10-13');
  assert.deepEqual(first.responses[0].value, second.responses[0].value);
});
