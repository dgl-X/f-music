import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateAudioDecode, validateDecodedDuration } from '../src/audio-validation.js';

test('decoded duration rejects a materially truncated stream',()=>{
  assert.equal(validateDecodedDuration(180,179),true);
  assert.equal(validateDecodedDuration(180,120),false);
  assert.equal(validateDecodedDuration(0,3),true);
});

test('full decode rejects damaged MP3 frames and truncated duration',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-validation-'));
  const good=path.join(directory,'good.mp3'),corrupt=path.join(directory,'corrupt.mp3'),truncated=path.join(directory,'truncated.mp3');
  const generated=spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=3','-c:a','libmp3lame','-b:a','128k','-y',good]);
  assert.ifError(generated.error);assert.equal(generated.status,0,generated.stderr?.toString());
  fs.copyFileSync(good,corrupt);const descriptor=fs.openSync(corrupt,'r+');fs.writeSync(descriptor,Buffer.alloc(5000),0,5000,5000);fs.closeSync(descriptor);
  fs.copyFileSync(good,truncated);fs.truncateSync(truncated,12000);
  assert.equal((await validateAudioDecode(good,3.03)).valid,true);
  assert.equal((await validateAudioDecode(corrupt,3.03)).valid,false);
  assert.equal((await validateAudioDecode(truncated,3.03)).valid,false);
  fs.rmSync(directory,{recursive:true,force:true});
});
