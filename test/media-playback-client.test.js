import assert from 'node:assert/strict';
import test from 'node:test';
import { browserPlaybackCodecs, MediaPlaybackClient, mediaCacheKey, mediaPlaybackLabel, PlaybackRequestGate } from '../public/media-playback-client.js';

const track={id:'track'};
const ready={status:'ready',variant:'aac_192',stream_url:'/api/v1/tracks/track/stream?quality=aac_192&codecs=aac&variant=aac_192'};
test('browser declares only codecs its audio element reports',()=>{
  assert.deepEqual(browserPlaybackCodecs({canPlayType:type=>type==='audio/flac'?'probably':''}),['flac']);
});
test('preparation waits for readiness without starting unsupported audio',async()=>{
  let calls=0;const states=[];
  const client=new MediaPlaybackClient({api:async()=>++calls===1?{status:'preparing',retry_after_ms:1500}:ready,codecs:['aac'],sleep:async()=>{}});
  const selection=await client.resolve(track,{onStatus:state=>states.push(state)});
  assert.equal(selection.cache_key,'track:aac_192');assert.deepEqual(states,['preparing','ready']);
});
test('a superseded preparation cannot return a source even if its response arrives late',async()=>{
  let complete;const gate=new PlaybackRequestGate(),request=gate.begin();
  const client=new MediaPlaybackClient({api:()=>new Promise(resolve=>{complete=resolve;}),codecs:['aac']});
  const pending=client.resolve(track,{signal:request.signal});gate.begin();complete(ready);
  await assert.rejects(pending,{name:'AbortError'});assert.equal(request.current(),false);
});
test('preloading does not occupy a worker waiting for a derivative',async()=>{
  const client=new MediaPlaybackClient({api:async()=>({status:'preparing'}),codecs:['aac'],sleep:async()=>assert.fail('Prefetch waited')});
  assert.equal(await client.resolve(track,{waitForReady:false}),null);
});
test('only a missing endpoint enables legacy behavior; network and auth failures do not',async()=>{
  for(const status of [401,403,404,500]){
    const client=new MediaPlaybackClient({api:async()=>{throw Object.assign(new Error('failure'),{status});},codecs:['aac']});
    await assert.rejects(client.resolve(track));
  }
  const client=new MediaPlaybackClient({api:async()=>{throw Object.assign(new Error('Маршрут не найден'),{status:404});},codecs:['aac']});
  assert.equal((await client.resolve(track)).variant,'legacy');
});
test('cache identities differ for lossless repair, original and AAC',()=>{
  assert.equal(new Set(['original','normalized_flac','aac_192'].map(variant=>mediaCacheKey(track,variant))).size,3);
});
test('malformed or cross-origin stream URL is rejected',async()=>{
  for(const stream_url of ['https://external.test/file','/api/v1/tracks/another/stream']){
    const client=new MediaPlaybackClient({api:async()=>({...ready,stream_url}),codecs:['aac']});
    await assert.rejects(client.resolve(track),/Некорректный ответ/);
  }
});
test('failed preparation never falls back to unsupported original',async()=>{
  const client=new MediaPlaybackClient({api:async()=>({status:'failed',error_code:'media_preparation_failed'}),codecs:['aac']});
  await assert.rejects(client.resolve(track),{code:'media_preparation_failed'});
});

test('preparation polling has a finite deadline',async()=>{
  let clock=0,calls=0;
  const client=new MediaPlaybackClient({codecs:['aac'],now:()=>clock,timeoutMs:1000,api:async()=>{calls++;return{status:'preparing'};},sleep:async ms=>{clock+=ms;}});
  await assert.rejects(client.resolve(track),{code:'media_preparation_timeout'});
  assert.equal(calls,2);
});

test('a stream URL with another representation cannot use the declared cache key',async()=>{
  const client=new MediaPlaybackClient({codecs:['aac'],api:async()=>({...ready,stream_url:'/api/v1/tracks/track/stream?quality=original&variant=original'})});
  await assert.rejects(client.resolve(track),/Некорректный вариант/);
});

test('player labels distinguish lossless repair from lossy compatible AAC',()=>{
  assert.equal(mediaPlaybackLabel({variant:'normalized_flac'}),'FLAC · без перекодирования');
  assert.match(mediaPlaybackLabel({variant:'aac_192'}),/AAC 192/);
  assert.equal(mediaPlaybackLabel({variant:'original'}),'');
});

test('a failed native decoder is excluded for only that track',async()=>{
  const requests=[];
  const client=new MediaPlaybackClient({codecs:['aac','flac'],api:async url=>{requests.push(url);const id=url.includes('/another/')?'another':'track';return{...ready,stream_url:ready.stream_url.replace('/track/','/'+id+'/')};}});
  assert.equal(client.rejectCodec('track','flac'),true);assert.equal(client.rejectCodec('track','flac'),false);
  await client.resolve(track);await client.resolve({id:'another'});
  assert.match(requests[0],/codecs=aac$/);assert.match(requests[1],/codecs=aac%2Cflac$/);
});

test('explicit retry is sent once, not on every preparation poll',async()=>{
  const requests=[];
  const client=new MediaPlaybackClient({codecs:['aac'],sleep:async()=>{},api:async url=>{requests.push(url);return requests.length===1?{status:'preparing'}:ready;}});
  await client.resolve(track,{retry:true});
  assert.match(requests[0],/retry=1/);assert.equal(requests[1].includes('retry='),false);
});
