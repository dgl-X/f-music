import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { hybridFlacMediaOffset, normalizeHybridFlac } from '../src/audio-normalization.js';

test('hybridFlacMediaOffset detects MP4 after FLAC metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-flac-'));
  const filename = path.join(directory, 'hybrid.flac');
  fs.writeFileSync(filename, Buffer.concat([
    Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 4]), Buffer.alloc(4),
    Buffer.from([0, 0, 0, 32]), Buffer.from('ftyp'), Buffer.alloc(24),
  ]));
  assert.equal(hybridFlacMediaOffset(filename), 12);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('hybridFlacMediaOffset ignores a regular FLAC', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-flac-'));
  const filename = path.join(directory, 'regular.flac');
  fs.writeFileSync(filename, Buffer.concat([
    Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 4]), Buffer.alloc(4), Buffer.alloc(16),
  ]));
  assert.equal(hybridFlacMediaOffset(filename), null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('normalizeHybridFlac losslessly remuxes embedded MP4 FLAC', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-flac-'));
  const media = path.join(directory, 'media.m4a');
  const hybrid = path.join(directory, 'hybrid.flac');
  const generated = spawnSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1',
    '-c:a', 'flac', '-strict', 'experimental', '-f', 'mp4', '-y', media,
  ]);
  assert.ifError(generated.error);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  fs.writeFileSync(hybrid, Buffer.concat([
    Buffer.from('fLaC'), Buffer.from([0x81, 0, 0, 0]), fs.readFileSync(media),
  ]));

  const result = await normalizeHybridFlac(hybrid);
  assert.equal(result.normalized, true);
  const decoded = spawnSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-xerror', '-i', result.output,
    '-map', '0:a:0', '-f', 'null', '-',
  ]);
  assert.ifError(decoded.error);
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.equal(fs.readFileSync(result.output, { encoding: null }).subarray(0, 4).toString(), 'fLaC');
  assert.equal(fs.readFileSync(result.output).includes(Buffer.from('YaMusicPRO')), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
