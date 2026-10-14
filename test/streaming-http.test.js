import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamingHttpController } from '../src/streaming-http.js';

function harness({ track = null, ready = null, variant = null, served = true, files=[] } = {}) {
  const responses = [], calls = [], media = [];
  const db = { prepare(sql) { return {
    async get(...params) {
      calls.push({ type:'get', sql, params });
      if (sql.includes('FROM tracks WHERE')) return track;
      return ready;
    },
    async run(...params) { calls.push({ type:'run', sql, params }); },
    async all(...params) { calls.push({type:'all',sql,params});return files.map(file=>({...file})); },
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

test('lossless repaired FLAC plays without replacing the stored original',async()=>{
  const track={id:'track',source_codec:'flac',storage_key:'originals/hybrid.flac',mime_type:'audio/flac'};
  const ready={variant:'normalized_flac',storage_key:'derived/normalized_flac/a.flac',mime_type:'audio/flac'};
  const h=harness({track,ready});
  await h.controller.handle({method:'GET'},{},new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream'));
  assert.equal(h.media[0].variant,'normalized_flac');
  assert.equal(h.media[0].storageKey,ready.storage_key);
  assert.equal(track.storage_key,'originals/hybrid.flac');
  assert.equal(h.calls.some(call=>call.type==='run'),false);
});

test('explicit source download returns exact uploaded bytes rather than a repair',async()=>{
  const track={id:'track',storage_key:'originals/hybrid.flac',mime_type:'audio/flac'};
  const h=harness({track,ready:{variant:'normalized_flac',storage_key:'derived/repaired.flac'}});
  await h.controller.handle({method:'GET'},{},new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream?quality=source'));
  assert.equal(h.media[0].storageKey,track.storage_key);
  assert.equal(h.media[0].variant,'original');
});

test('playback status reports preparation and the strict stream never serves unsupported ALAC',async()=>{
  for(const endpoint of ['playback','stream']){
    const h=harness({track:{id:'track',source_codec:'alac',storage_key:'originals/a.m4a'}});
    await h.controller.handle({method:'GET'},{},new URL(`https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/${endpoint}?codecs=mp3,aac`));
    assert.equal(h.responses[0].status,endpoint==='playback'?200:409);
    assert.equal(h.responses[0].value.status,'preparing');
    assert.equal(h.media.length,0);
    assert.ok(h.calls.some(call=>call.type==='run'&&call.params[1]==='aac_192'));
  }
});

test('failed preparation remains failed until an explicit retry request',async()=>{
  for(const retry of [false,true]){
    const h=harness({track:{id:'track',source_codec:'alac'},files:[{variant:'aac_192',status:'failed'}]});
    await h.controller.handle({method:'GET'},{},new URL(`https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/playback?codecs=aac${retry?'&retry=1':''}`));
    assert.equal(h.responses[0].value.status,retry?'preparing':'failed');
    assert.equal(h.calls.some(call=>call.type==='run'),retry);
  }
});

test('a ready compatible derivative returns a stable stream URL and avoids requeueing',async()=>{
  const file={variant:'aac_192',status:'ready',storage_key:'derived/a.m4a',mime_type:'audio/mp4',size_bytes:12345};
  const h=harness({track:{id:'track',source_codec:'alac'},files:[file]});
  await h.controller.handle({method:'GET'},{},new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/playback?codecs=aac'));
  assert.equal(h.responses[0].value.status,'ready');
  assert.equal(h.responses[0].value.size_bytes,12345);
  assert.equal(h.responses[0].value.stream_url,'/api/v1/tracks/track/stream?quality=aac_192&codecs=aac&variant=aac_192');
  assert.equal(h.calls.some(call=>call.type==='run'),false);
});

test('invalid or unsupported capability declarations never serve media',async()=>{
  for(const codecs of ['unknown','mp3']){
    const h=harness({track:{id:'track',source_codec:'alac'}});
    await h.controller.handle({method:'GET'},{},new URL(`https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream?codecs=${codecs}`));
    assert.equal(h.responses[0].status,codecs==='unknown'?400:415);assert.equal(h.media.length,0);
  }
});

test('a pinned AAC stream never substitutes native bytes into the same cache identity',async()=>{
  const h=harness({track:{id:'track',source_codec:'flac'},files:[{variant:'aac_192',status:'processing'}]});
  await h.controller.handle({method:'GET'},{},new URL('https://music.test/api/tracks/11111111-1111-4111-8111-111111111111/stream?quality=aac_192&codecs=aac,flac&variant=aac_192'));
  assert.equal(h.media.length,0);assert.equal(h.responses[0].status,409);
  assert.equal(h.responses[0].value.error_code,'media_variant_changed');
});
