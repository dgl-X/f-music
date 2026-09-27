import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOpenVkRange, normalizeOpenVkSourceId, sanitizeOpenVkTrack, validateOpenVkMediaUrl } from '../src/openvk-provider.js';

test('OpenVK source IDs are strict owner and audio pairs', () => {
  assert.equal(normalizeOpenVkSourceId('27717_5'),'27717_5');
  assert.equal(normalizeOpenVkSourceId('-7_12'),'-7_12');
  assert.equal(normalizeOpenVkSourceId('1_2_extra'),null);
});

test('OpenVK results expose metadata without source URLs', () => {
  const track=sanitizeOpenVkTrack({owner_id:27717,id:5,artist:'Баста',title:'ЧП',duration:315,url:'https://cdn.openvk.org/private.mp3'});
  assert.deepEqual(track,{source_id:'27717_5',title:'ЧП',artist:'Баста',album:'',genre:'',duration_seconds:315,explicit:false});
  assert.equal('url' in track,false);
});

test('OpenVK media import only accepts the fixed HTTPS CDN', () => {
  assert.equal(validateOpenVkMediaUrl('https://cdn.openvk.org/audio/file.mp3')?.hostname,'cdn.openvk.org');
  assert.equal(validateOpenVkMediaUrl('http://cdn.openvk.org/audio/file.mp3'),null);
  assert.equal(validateOpenVkMediaUrl('https://cdn.openvk.org.evil.test/file.mp3'),null);
  assert.equal(validateOpenVkMediaUrl('https://127.0.0.1/file.mp3'),null);
});

test('OpenVK preview forwards only a single valid byte range', () => {
  assert.equal(normalizeOpenVkRange('bytes=0-65535'),'bytes=0-65535');
  assert.equal(normalizeOpenVkRange('bytes=1024-'),'bytes=1024-');
  assert.equal(normalizeOpenVkRange('bytes=-4096'),'bytes=-4096');
  assert.equal(normalizeOpenVkRange(undefined),null);
  assert.equal(normalizeOpenVkRange('bytes=0-1,4-8'),undefined);
  assert.equal(normalizeOpenVkRange('items=0-10'),undefined);
});
