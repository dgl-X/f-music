import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUploadProcessor } from '../src/upload-processor.js';

function fixture(t, overrides = {}) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-processor-'));
  const uploadDir = path.join(storageDir, 'uploads'), originalDir = path.join(storageDir, 'originals');
  fs.mkdirSync(uploadDir); fs.mkdirSync(originalDir);
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const calls = [];
  const connection = { prepare(sql) { return {
    async get() { calls.push({ type: 'get', sql, params: [...arguments] }); return null; },
    async run(...params) { calls.push({ type: 'run', sql, params }); return { changes: 1 }; },
  }; } };
  const db = { ...connection, async transaction(callback) { return await callback(connection); } };
  const dependencies = {
    db, uploadDir, originalDir, storageDir,
    async inspectAudio() { return { format_name: 'mp3', duration: 5, tags: { title: 'Song', artist: 'Artist' }, streams: [] }; },
    async sha256File() { return 'hash'; }, async validateAudioDecode() { return { valid: true }; },
    async extractCover() { return null; }, async normalizeHybridFlac() { return { normalized: false }; },
    normalizedTags(metadata) { return { title: metadata.tags.title, artist: metadata.tags.artist, album: '', genre: '', year: null, trackNumber: null, discNumber: null }; },
    audioCodec() { return 'mp3'; }, async recognitionSettings() { return { enabled: false, clientKey: '' }; },
    requiresCompatibilityVariant() { return false; }, randomUUID() { return 'aa000000-0000-0000-0000-000000000001'; },
    ...overrides,
  };
  return { storageDir, uploadDir, calls, processor: createUploadProcessor(dependencies) };
}

test('processor rejects an unrecognized file and removes its temporary data', async t => {
  const setup = fixture(t, { async inspectAudio() { return null; } });
  const source = path.join(setup.uploadDir, 'upload-1.part'); fs.writeFileSync(source, 'broken');
  const result = await setup.processor.process({ id: 'upload-1', user_id: 2, filename: 'broken.bin', mime_type: 'application/octet-stream' });
  assert.deepEqual(result, { status: 'rejected', error: 'Файл не распознан как аудио' });
  assert.equal(fs.existsSync(source), false);
  assert.match(setup.calls.at(-1).sql, /uploads SET status='failed'/);
});

test('processor links a byte-identical upload to the existing track', async t => {
  const setup = fixture(t);
  const source = path.join(setup.uploadDir, 'upload-1.part'); fs.writeFileSync(source, 'audio');
  const getCall = setup.calls;
  const db = {
    prepare(sql) { return {
      async get() { getCall.push({ type: 'get', sql }); return sql.includes('sha256') ? { id: 'existing-track' } : null; },
      async run(...params) { getCall.push({ type: 'run', sql, params }); return { changes: 1 }; },
    }; },
    async transaction(callback) { return await callback(this); },
  };
  const processor = createUploadProcessor({
    db, uploadDir:setup.uploadDir, originalDir:path.join(setup.storageDir,'originals'), storageDir:setup.storageDir,
    async inspectAudio() { return { format_name:'mp3',duration:5,tags:{},streams:[] }; }, async sha256File() { return 'hash'; },
    async validateAudioDecode() { return { valid:true }; }, async extractCover() { return null; }, async normalizeHybridFlac() { return { normalized:false }; },
    normalizedTags() { return {}; }, audioCodec() { return 'mp3'; }, async recognitionSettings() { return {}; }, requiresCompatibilityVariant() { return false; },
    randomUUID() { return 'aa000000-0000-0000-0000-000000000001'; },
  });
  assert.deepEqual(await processor.process({ id:'upload-1',user_id:2,filename:'song.mp3',mime_type:'audio/mpeg' }), { status:'duplicate',duplicateId:'existing-track' });
  assert.equal(fs.existsSync(source), false);
  assert.ok(getCall.some(call => call.type === 'run' && call.sql.includes("status='duplicate'")));
});

test('processor stores the original and creates secondary jobs atomically', async t => {
  const setup = fixture(t, {
    async recognitionSettings() { return { enabled:true,clientKey:'configured' }; },
    requiresCompatibilityVariant() { return true; },
  });
  const source = path.join(setup.uploadDir, 'upload-1.part'); fs.writeFileSync(source, 'audio-data');
  const result = await setup.processor.process({ id:'upload-1',user_id:2,filename:'song.mp3',mime_type:'audio/mpeg',candidate_track_id:'aa000000-0000-0000-0000-000000000001' });
  assert.deepEqual(result, { status:'ready',trackId:'aa000000-0000-0000-0000-000000000001' });
  assert.equal(fs.readFileSync(path.join(setup.storageDir,'originals','aa','aa000000-0000-0000-0000-000000000001.mp3'),'utf8'), 'audio-data');
  assert.ok(setup.calls.some(call => call.sql.startsWith('INSERT INTO tracks')));
  assert.ok(setup.calls.some(call => call.sql.includes('INSERT INTO loudness_jobs')));
  assert.ok(setup.calls.some(call => call.sql.includes('INSERT INTO track_files')));
});
