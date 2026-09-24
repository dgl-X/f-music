import test from 'node:test';
import assert from 'node:assert/strict';
import { audioCodec, playbackVariant, requiresCompatibilityVariant } from '../src/audio-compatibility.js';

test('audio codec is read from the first audio stream, not embedded artwork', () => {
  const metadata={streams:[{codec_type:'video',codec_name:'mjpeg'},{codec_type:'audio',codec_name:'ALAC'}]};
  assert.equal(audioCodec(metadata),'alac');
});

test('ALAC original playback selects a compatible AAC derivative', () => {
  assert.equal(requiresCompatibilityVariant('alac'),true);
  assert.equal(playbackVariant('original','alac'),'aac_192');
});

test('compatible originals remain untouched and explicit quality still wins', () => {
  for(const codec of ['mp3','aac','flac','opus',null])assert.equal(playbackVariant('original',codec),null);
  assert.equal(playbackVariant('compact','alac'),'aac_96');
  assert.equal(playbackVariant('high','mp3'),'aac_192');
});
