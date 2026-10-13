import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadWorker } from '../src/upload-worker.js';

function harness({ job = { id:1, upload_id:'u1' }, upload = { id:'u1', status:'processing' }, processed = { trackId:'t1', status:'created' }, external = null } = {}) {
  const calls = [], finishes = [];
  const db = {
    prepare(sql) { return { async get() { if (sql.includes('FROM uploads')) return upload; if (sql.includes('external_imports')) return external; }, async run(...params) { calls.push({ sql, params }); } }; },
    async transaction(callback) { await callback(this); },
  };
  const uploadJobs = { async claim() { return job; }, async complete(id) { calls.push({ complete:id }); }, async failOrRetry() { return { message:'failed' }; } };
  const worker = createUploadWorker({ db, uploadJobs, uploadProcessor:{ async process() { return processed; } }, startOperation:() => async ok => finishes.push(ok), logError() {} });
  return { worker, calls, finishes };
}

test('upload worker completes an ordinary processed upload and records success', async () => {
  const h = harness();
  assert.equal(await h.worker.processNext(), true);
  assert.ok(h.calls.some(call => call.complete === 1));
  assert.deepEqual(h.finishes, [true]);
  assert.equal(h.worker.isBusy(), false);
});

test('upload worker completes stale jobs without invoking processing', async () => {
  const h = harness({ upload:null });
  assert.equal(await h.worker.processNext(), true);
  assert.ok(h.calls.some(call => call.complete === 1));
  assert.deepEqual(h.finishes, [true]);
});

test('upload worker returns false when queue is empty', async () => {
  const h = harness({ job:null });
  assert.equal(await h.worker.processNext(), false);
  assert.deepEqual(h.finishes, []);
});
