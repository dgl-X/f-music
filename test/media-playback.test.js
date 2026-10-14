import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlaybackCodecs, selectMediaPlayback } from '../src/media-playback.js';

test('playback codec declarations are explicit, bounded and validated',()=>{
  assert.deepEqual(parsePlaybackCodecs(' MP3,flac,mp3 '),['mp3','flac']);
  for(const value of [null,'','mp3,','mp3,unknown','a'.repeat(257)])assert.equal(parsePlaybackCodecs(value),null);
});
test('unsupported ALAC never falls back to a raw file',()=>{
  const state=selectMediaPlayback({sourceCodec:'alac',codecs:['mp3','aac'],files:[]});
  assert.equal(state.status,'preparing');assert.equal(state.variant,'aac_192');
  assert.equal(selectMediaPlayback({sourceCodec:'alac',codecs:['mp3']}).status,'unsupported');
  assert.equal(selectMediaPlayback({sourceCodec:'alac',codecs:['alac']}).variant,'original');
});
test('supported native audio plays immediately while selected AAC is prepared',()=>{
  const state=selectMediaPlayback({requested:'high',sourceCodec:'flac',codecs:['flac','aac']});
  assert.equal(state.status,'ready');assert.equal(state.variant,'original');assert.equal(state.requested_variant,'aac_192');
  assert.equal(state.preparation_status,'preparing');
});
test('repair is selected only if the client actually supports FLAC',()=>{
  const files=[{variant:'normalized_flac',status:'ready'}];
  assert.equal(selectMediaPlayback({sourceCodec:'flac',codecs:['mp3','aac'],files}).status,'preparing');
  assert.equal(selectMediaPlayback({sourceCodec:'flac',codecs:['flac'],files}).variant,'normalized_flac');
});
test('failed preparation is not disguised as readiness or retried by polling',()=>{
  const files=[{variant:'aac_192',status:'failed'}];
  assert.equal(selectMediaPlayback({sourceCodec:'alac',codecs:['aac'],files}).status,'failed');
  assert.equal(selectMediaPlayback({requested:'high',sourceCodec:'flac',codecs:['aac','flac'],files}).preparation_status,'failed');
});
test('ready AAC and exact-source download have distinct playback contracts',()=>{
  const files=[{variant:'aac_192',status:'ready'}];
  assert.equal(selectMediaPlayback({sourceCodec:'alac',codecs:['aac'],files}).variant,'aac_192');
  const source=selectMediaPlayback({requested:'source',sourceCodec:'alac',codecs:['mp3'],files});
  assert.equal(source.variant,'original');assert.equal(source.status,'ready');
});
