import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamingHttpController } from '../src/streaming-http.js';

function harness({ track = null, ready = null, variant = null, served = true } = {}) {
  const responses = [], calls = [], media = [];
  const db = { prepare(sql) { return {
    async get(...params) {
      calls.push({ type:'get', sql, params });
      if (sql.includes('FROM tracks WHERE')) return track;
      return ready;
    },
    async run(...params) { calls.push({ type:'run', sql, params }); },
  }; } };
  const controller = createStreamingHttpController({
    db, storageDir:'/storage', xAccelRedirect:true,
    playbackVariant(requested, codec) { calls.push({ type:'variant', requested, codec }); return variant; },
    serveStoredMedia(_req, _res, options) { media.push(options); return served; },
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses, calls, media };
}

test('streaming controller ignores unrelated routes and methods', async () => {
  const first = harness(), second = harness();
  assert.equal(await first.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks')), false);
  assert.equal(await second.controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream')), false);
});

test('missing track returns the compatible not-found response', async () => {
  const h = harness();
  assert.equal(await h.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream')), true);
  assert.deepEqual(h.responses[0], { status:404, value:{ error:'Трек не найден' } });
});

test('original starts immediately while missing AAC variant is queued', async () => {
  const track = { id:'track', source_codec:'flac', storage_key:'originals/a.flac', mime_type:'audio/flac' };
  const h = harness({ track, variant:'aac_192' });
  await h.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream?quality=high'));
  assert.ok(h.calls.some(call => call.type === 'run' && call.params[1] === 'aac_192' && call.params[2] === 192000));
  assert.deepEqual(h.media[0], { storageDir:'/storage', storageKey:'originals/a.flac', mimeType:'audio/flac', variant:'original', xAccelRedirect:true });
});

test('ready AAC variant is served instead of the original', async () => {
  const track = { id:'track', source_codec:'flac', storage_key:'originals/a.flac', mime_type:'audio/flac' };
  const ready = { id:3, storage_key:'derived/a.m4a', mime_type:'audio/mp4', variant:'aac_96' };
  const h = harness({ track, ready, variant:'aac_96' });
  await h.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream?quality=compact'));
  assert.equal(h.media[0].storageKey, 'derived/a.m4a');
  assert.equal(h.media[0].variant, 'aac_96');
  assert.equal(h.calls.some(call => call.type === 'run'), false);
});

test('prepare parameter queues only supported AAC variants', async () => {
  const track = { id:'track', source_codec:'mp3', storage_key:'originals/a.mp3', mime_type:'audio/mpeg' };
  const h = harness({ track });
  await h.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream?prepare=aac_96'));
  assert.ok(h.calls.some(call => call.type === 'run' && call.params[1] === 'aac_96' && call.params[2] === 96000));
});

test('missing storage file is reported after media selection', async () => {
  const track = { id:'track', source_codec:'mp3', storage_key:'missing.mp3', mime_type:'audio/mpeg' };
  const h = harness({ track, served:false });
  await h.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream'));
  assert.deepEqual(h.responses[0], { status:404, value:{ error:'Файл не найден' } });
});
