import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCoverExtractor, runProcess, sha256File } from '../src/media-tools.js';

test('media file hashing streams the complete file', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-media-tools-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'audio.bin'), bytes = Buffer.from('family music');
  fs.writeFileSync(file, bytes);
  assert.equal(await sha256File(file), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('process runner returns status without exposing child process errors', async () => {
  assert.equal(await runProcess(process.execPath, ['-e', 'process.exit(0)']), true);
  assert.equal(await runProcess(process.execPath, ['-e', 'process.exit(2)']), false);
});

test('cover extractor uses a sharded private path', async t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-cover-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const coverDir = path.join(storageDir, 'covers');
  let command, args;
  const extractCover = createCoverExtractor({
    coverDir, storageDir,
    async execute(nextCommand, nextArgs) {
      command = nextCommand; args = nextArgs;
      fs.writeFileSync(nextArgs.at(-1), 'jpeg');
      return true;
    },
  });
  const key = await extractCover('/tmp/source.mp3', 'ab000000-0000-0000-0000-000000000001');
  assert.equal(key, path.join('covers', 'ab', 'ab000000-0000-0000-0000-000000000001.jpg'));
  assert.equal(command, 'ffmpeg');
  assert.equal(args.at(-1), path.join(storageDir, key));
  assert.equal(fs.readFileSync(path.join(storageDir, key), 'utf8'), 'jpeg');
});

test('cover extractor removes an incomplete ffmpeg output', async t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-cover-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const extractCover = createCoverExtractor({
    coverDir:path.join(storageDir,'covers'), storageDir,
    async execute(_command, args) { fs.writeFileSync(args.at(-1), 'partial'); return false; },
  });
  assert.equal(await extractCover('/tmp/source.mp3', 'cd000000-0000-0000-0000-000000000001'), null);
  assert.equal(fs.existsSync(path.join(storageDir,'covers','cd','cd000000-0000-0000-0000-000000000001.jpg')), false);
});
