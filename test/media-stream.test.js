import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseByteRange, resolveStoredMedia } from '../src/media-stream.js';

test('media ranges support full, partial and suffix requests', () => {
  assert.deepEqual(parseByteRange('',100),{start:0,end:99,status:200});
  assert.deepEqual(parseByteRange('bytes=10-19',100),{start:10,end:19,status:206});
  assert.deepEqual(parseByteRange('bytes=-25',100),{start:75,end:99,status:206});
  assert.equal(parseByteRange('bytes=100-101',100),null);
  assert.equal(parseByteRange('bytes=20-10',100),null);
});

test('media storage resolver blocks traversal and missing files', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-media-'));
  const file=path.join(root,'track.mp3');fs.writeFileSync(file,'audio');
  assert.equal(resolveStoredMedia(root,'track.mp3'),file);
  assert.equal(resolveStoredMedia(root,'../outside.mp3'),null);
  assert.equal(resolveStoredMedia(root,'missing.mp3'),null);
  fs.rmSync(root,{recursive:true,force:true});
});
