import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUploadService, sanitizeUploadFilename, validateUploadCreation, validateUploadPart } from '../src/upload-service.js';

test('upload creation sanitizes names and enforces configured size', () => {
  assert.equal(sanitizeUploadFilename('../folder/song\u0000.mp3'), 'song.mp3');
  assert.deepEqual(validateUploadCreation({ filename: '../song.mp3', size: 12, mime_type: 'audio/mpeg' }, 20), {
    filename: 'song.mp3', totalBytes: 12, mimeType: 'audio/mpeg',
  });
  assert.equal(validateUploadCreation({ filename: '', size: 12 }, 20), null);
  assert.equal(validateUploadCreation({ filename: 'song.mp3', size: 21 }, 20), null);
});

test('upload part validation keeps resumable offset contract', () => {
  const upload = { total_bytes: 10, received_bytes: 4 };
  assert.equal(validateUploadPart({ contentRange: 'bytes 4-7/10', contentLength: '4', upload }).status, 'ok');
  assert.deepEqual(validateUploadPart({ contentRange: 'bytes 0-3/10', contentLength: '4', upload }), {
    status: 'offset_mismatch', expectedOffset: 4,
  });
  assert.deepEqual(validateUploadPart({ contentRange: 'bytes 4-7/10', contentLength: '3', upload }), { status: 'length_mismatch' });
});

test('upload service writes an exact part and queues a completed file', async t => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-upload-'));
  t.after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
  const writes = [], queued = [];
  const db = { prepare(sql) { return {
    async run(...params) { writes.push({ sql, params }); return { changes: 1 }; },
    async get() { return null; }, async all() { return []; },
  }; } };
  const service = createUploadService({
    db, uploadDir, maxUploadBytes: 100,
    uploadJobs: { async enqueue(value) { queued.push(value); } },
  });
  const created = await service.create({ userId: 2, input: { filename: 'song.mp3', size: 6, mime_type: 'audio/mpeg' } });
  const upload = { id: created.id, status: 'uploading', total_bytes: 6, received_bytes: 0 };
  async function* chunks() { yield Buffer.from('abc'); yield Buffer.from('def'); }
  const result = await service.writePart({ upload, contentRange: 'bytes 0-5/6', contentLength: '6', chunks: chunks() });
  assert.deepEqual(result, { status: 'accepted', offset: 6, complete: true, processing: true });
  assert.equal(fs.readFileSync(path.join(uploadDir, `${created.id}.part`), 'utf8'), 'abcdef');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].uploadId, created.id);
  assert.match(queued[0].candidateTrackId, /^[0-9a-f-]{36}$/);
  assert.ok(writes.some(call => call.sql.startsWith('UPDATE uploads SET received_bytes=')));
});

test('incomplete upload part never changes the target or database offset', async t => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-upload-'));
  t.after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(uploadDir, 'upload-1.part'), '');
  const writes = [];
  const db = { prepare(sql) { return { async run(...params) { writes.push({ sql, params }); return { changes: 1 }; } }; } };
  const service = createUploadService({ db, uploadDir, maxUploadBytes: 100, uploadJobs: { async enqueue() {} } });
  async function* chunks() { yield Buffer.from('abc'); }
  const result = await service.writePart({
    upload: { id: 'upload-1', status: 'uploading', total_bytes: 6, received_bytes: 0 },
    contentRange: 'bytes 0-5/6', contentLength: '6', chunks: chunks(),
  });
  assert.deepEqual(result, { status: 'incomplete' });
  assert.equal(fs.statSync(path.join(uploadDir, 'upload-1.part')).size, 0);
  assert.equal(writes.length, 0);
});
