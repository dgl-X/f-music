import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrackManagementHttpController } from '../src/track-management-http.js';

function harness({ rows = [], row = null, body = {}, catalog = {} } = {}) {
  const responses = [], calls = [];
  const db = {
    prepare(sql) { return {
      async get(...params) { calls.push({ type:'get', sql, params }); return row; },
      async all(...params) { calls.push({ type:'all', sql, params }); return rows; },
      async run(...params) { calls.push({ type:'run', sql, params }); },
    }; },
    async transaction(callback) { return callback(this); },
  };
  const controller = createTrackManagementHttpController({
    catalog, db, storageDir:'/tmp/fm-storage', uploadDir:'/tmp/fm-upload', coverDir:'/tmp/fm-covers',
    readJson:async () => body, readBytes:async () => Buffer.alloc(0), runProcess:async () => false,
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses, calls };
}

test('track management ignores unrelated routes', async () => {
  const h = harness();
  assert.equal(await h.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/history'), { id:7 }), false);
  assert.deepEqual(h.responses, []);
});

test('empty batch metadata request is rejected before database access', async () => {
  const h = harness({ body:{ items:[{ id:'invalid' }] } });
  assert.equal(await h.controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/tracks/batch'), { id:7 }), true);
  assert.equal(h.responses[0].status, 400);
  assert.deepEqual(h.calls, []);
});

test('track edit remains owner scoped', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const h = harness({ row:{ id, owner_id:8 } });
  await h.controller.handle({ method:'PATCH' }, {}, new URL(`https://music.test/api/tracks/${id}`), { id:7, is_admin:false });
  assert.equal(h.responses[0].status, 403);
});

test('track edit validates required title and artist', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const h = harness({ row:{ id, owner_id:7 }, body:{ title:'', artist:'Artist' } });
  await h.controller.handle({ method:'PATCH' }, {}, new URL(`https://music.test/api/tracks/${id}`), { id:7 });
  assert.equal(h.responses[0].status, 400);
});

test('artist credits require a primary artist', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const h = harness({ row:{ id, owner_id:7 }, body:{ items:[{ name:'Guest', role:'featured' }] } });
  await h.controller.handle({ method:'PUT' }, {}, new URL(`https://music.test/api/tracks/${id}/artists`), { id:7 });
  assert.equal(h.responses[0].status, 400);
});

test('like mutation is scoped to an existing track and current user', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const h = harness({ row:{ id } });
  await h.controller.handle({ method:'PUT' }, {}, new URL(`https://music.test/api/tracks/${id}/like`), { id:7 });
  assert.deepEqual(h.responses[0], { status:200, value:{ liked:true } });
  assert.ok(h.calls.some(call => call.type === 'run' && call.params[0] === 7 && call.params[1] === id));
});

test('batch cover rejects non-image requests before database access', async () => {
  const h = harness();
  await h.controller.handle({ method:'PUT', headers:{ 'content-type':'text/plain' } }, {}, new URL('https://music.test/api/tracks/batch-cover'), { id:7 });
  assert.equal(h.responses[0].status, 415);
  assert.deepEqual(h.calls, []);
});
