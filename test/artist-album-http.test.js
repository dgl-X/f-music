import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtistAlbumHttpController } from '../src/artist-album-http.js';

function harness({ catalog = {}, db, body = {}, row } = {}) {
  const responses = [], calls = [];
  const database = db || {
    prepare(sql) {
      return {
        async get(...params) { calls.push({ type:'get', sql, params }); return row; },
        async run(...params) { calls.push({ type:'run', sql, params }); },
      };
    },
  };
  const controller = createArtistAlbumHttpController({
    catalog, db:database,
    storageDir:'/tmp/family-music-test-storage', uploadDir:'/tmp/family-music-test-uploads',
    artistDir:'/tmp/family-music-test-artists', albumDir:'/tmp/family-music-test-albums',
    readJson:async () => body, readBytes:async () => Buffer.alloc(0), runProcess:async () => false,
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses, calls };
}

test('artist and album controller ignores unrelated routes', async () => {
  const { controller, responses } = harness();
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/history'), { id:7 }), false);
  assert.deepEqual(responses, []);
});

test('artist lookup keeps query parameters', async () => {
  let query;
  const { controller, responses } = harness({ catalog:{ async lookupArtists({ searchParams }) { query = searchParams.get('q'); return { items:[] }; } } });
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/artists?q=Баста'), { id:7 }), true);
  assert.equal(query, 'Баста');
  assert.deepEqual(responses[0], { status:200, value:{ items:[] } });
});

test('only an administrator may edit an artist card', async () => {
  const { controller, responses } = harness();
  await controller.handle({ method:'PATCH' }, {}, new URL('https://music.test/api/artists/3'), { id:7, is_admin:false });
  assert.equal(responses[0].status, 403);
});

test('album edit checks ownership and administrator rights', async () => {
  let permission;
  const catalog = { async canEditAlbum(input) { permission = input; return false; } };
  const { controller, responses } = harness({ catalog, row:{ id:4, name:'Album' } });
  await controller.handle({ method:'PATCH' }, {}, new URL('https://music.test/api/albums/4'), { id:7, is_admin:false });
  assert.deepEqual(permission, { userId:7, isAdmin:false, albumId:4 });
  assert.equal(responses[0].status, 403);
});

test('album description keeps its public length limit', async () => {
  const catalog = { async canEditAlbum() { return true; } };
  const { controller, responses } = harness({ catalog, row:{ id:4, name:'Album' }, body:{ bio:'x'.repeat(5001) } });
  await controller.handle({ method:'PATCH' }, {}, new URL('https://music.test/api/albums/4'), { id:7, is_admin:false });
  assert.equal(responses[0].status, 400);
  assert.equal(responses[0].value.error, 'Описание слишком длинное');
});

test('album image upload rejects non-image content before reading its body', async () => {
  const catalog = { async canEditAlbum() { return true; } };
  const { controller, responses } = harness({ catalog, row:{ id:4, image_key:null } });
  await controller.handle({ method:'PUT', headers:{ 'content-type':'text/plain' } }, {}, new URL('https://music.test/api/albums/4/image'), { id:7 });
  assert.equal(responses[0].status, 415);
});
