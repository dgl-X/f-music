import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadJobService, uploadRetryDelaySeconds } from '../src/upload-jobs.js';

function fakeDb({ claimed = null } = {}) {
  const calls = [];
  const connection = {
    prepare(sql) { return {
      async run(...params) {
        calls.push({ sql, params });
        return sql.includes('RETURNING id,upload_id,attempts') ? { rows: claimed ? [claimed] : [] } : { rows: [], changes: 1 };
      },
    }; },
  };
  return {
    calls,
    prepare: connection.prepare,
    async transaction(callback) { return await callback(connection); },
  };
}

test('upload retry backoff is bounded and deterministic', () => {
  assert.equal(uploadRetryDelaySeconds(1), 5);
  assert.equal(uploadRetryDelaySeconds(2), 10);
  assert.equal(uploadRetryDelaySeconds(5), 80);
  assert.equal(uploadRetryDelaySeconds(99), 300);
});

test('enqueue is idempotent and clears terminal job state', async () => {
  const db = fakeDb();
  const jobs = createUploadJobService({ db });
  await jobs.enqueue({ uploadId: 'upload-1', candidateTrackId: 'track-1' });
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /status='processing'/);
  assert.deepEqual(db.calls[0].params, ['track-1', 'upload-1']);
  assert.match(db.calls[1].sql, /ON CONFLICT\(upload_id\) DO UPDATE/);
  assert.match(db.calls[1].sql, /started_at=NULL,finished_at=NULL,last_error=NULL/);
});

test('claim uses a locked queue row and returns one job', async () => {
  const expected = { id: 4, upload_id: 'upload-1', attempts: 2 };
  const db = fakeDb({ claimed: expected });
  const jobs = createUploadJobService({ db });
  assert.deepEqual(await jobs.claim(), expected);
  assert.match(db.calls[0].sql, /FOR UPDATE SKIP LOCKED LIMIT 1/);
  assert.match(db.calls[0].sql, /attempts=attempts\+1/);
});

test('transient upload failure is retried without failing its upload', async () => {
  const db = fakeDb();
  const jobs = createUploadJobService({ db });
  assert.deepEqual(await jobs.failOrRetry({ id: 4, upload_id: 'upload-1', attempts: 2 }, new Error('network')), {
    status: 'retry', delaySeconds: 10, message: 'network',
  });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /status='retry'/);
  assert.deepEqual(db.calls[0].params, [10, 'network', 4]);
});

test('fifth upload failure atomically closes the job and upload', async () => {
  const db = fakeDb();
  const jobs = createUploadJobService({ db });
  assert.deepEqual(await jobs.failOrRetry({ id: 4, upload_id: 'upload-1', attempts: 5 }, new Error('broken')), {
    status: 'failed', message: 'broken',
  });
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /processing_jobs SET status='failed'/);
  assert.match(db.calls[1].sql, /uploads SET status='failed'/);
});

test('worker recovery retries claimed work and restores missing queued jobs', async () => {
  const db = fakeDb();
  const jobs = createUploadJobService({ db });
  await jobs.recover();
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /WHERE status='processing'/);
  assert.match(db.calls[0].sql, /started_at=NULL,finished_at=NULL/);
  assert.match(db.calls[1].sql, /FROM uploads WHERE status='processing'/);
  assert.match(db.calls[1].sql, /ON CONFLICT\(upload_id\) DO NOTHING/);
});
