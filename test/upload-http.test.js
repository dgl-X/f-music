import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadHttpController } from '../src/upload-http.js';

function harness(uploads, body = {}) {
  const responses = [];
  const controller = createUploadHttpController({
    uploads,
    async readJson() { return body; },
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses };
}

test('upload list stays scoped to the current user', async () => {
  let userId;
  const { controller, responses } = harness({ async list(input) { userId = input.userId; return { items:[] }; } });
  await controller.handle({ method:'GET', headers:{} }, {}, new URL('https://music.test/api/uploads'), { id:7 });
  assert.equal(userId, 7);
  assert.deepEqual(responses[0], { status:200, value:{ items:[] } });
});

test('unknown or foreign upload is hidden as not found', async () => {
  const { controller, responses } = harness({ async get() { return null; } });
  await controller.handle({ method:'GET', headers:{} }, {}, new URL('https://music.test/api/uploads/abc-def'), { id:7 });
  assert.deepEqual(responses[0], { status:404, value:{ error:'Загрузка не найдена' } });
});

test('upload HEAD exposes resumable offsets without a body', async () => {
  const output = { status:null, headers:null, ended:false };
  const res = { writeHead(status, headers) { output.status = status; output.headers = headers; }, end() { output.ended = true; } };
  const uploads = { async get() { return { received_bytes:12, total_bytes:20, status:'uploading' }; } };
  const { controller } = harness(uploads);
  await controller.handle({ method:'HEAD', headers:{} }, res, new URL('https://music.test/api/uploads/abc-def'), { id:7 });
  assert.deepEqual(output, { status:204, headers:{ 'Upload-Offset':'12', 'Upload-Length':'20', 'Upload-Status':'uploading' }, ended:true });
});

test('upload offset conflict preserves expected offset', async () => {
  const uploads = {
    async get() { return { id:'abc-def', received_bytes:12, total_bytes:20, status:'uploading' }; },
    async writePart() { return { status:'offset_mismatch', expectedOffset:12 }; },
  };
  const { controller, responses } = harness(uploads);
  await controller.handle({ method:'PUT', headers:{} }, {}, new URL('https://music.test/api/uploads/abc-def'), { id:7 });
  assert.deepEqual(responses[0], { status:409, value:{ error:'Неверное смещение', expected_offset:12 } });
});

test('completed upload part enters processing with accepted status', async () => {
  const uploads = {
    async get() { return { id:'abc-def', received_bytes:0, total_bytes:20, status:'uploading' }; },
    async writePart() { return { status:'accepted', offset:20, complete:true, processing:true }; },
  };
  const { controller, responses } = harness(uploads);
  await controller.handle({ method:'PUT', headers:{} }, {}, new URL('https://music.test/api/uploads/abc-def'), { id:7 });
  assert.deepEqual(responses[0], { status:202, value:{ offset:20, complete:true, processing:true } });
});
