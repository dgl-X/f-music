import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationMetrics, operationMetricSnapshot } from '../src/operation-metrics.js';

test('operation timer records one bounded named operation exactly once', async () => {
  const calls = [];
  const db = { prepare:sql => ({ run:async (...values) => calls.push({ sql, values }) }) };
  const times = [100, 142];
  const metrics = createOperationMetrics({ db, now:() => times.shift(), logger:{ error(){} } });
  const finish = metrics.start('upload.process');
  assert.equal(await finish(false), true);
  assert.equal(await finish(true), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ['upload.process', 1, 42, 42, 42, 0]);
  assert.match(calls[0].sql, /ON CONFLICT\(name\)/);
});

test('unknown operation names are rejected to prevent unbounded labels', () => {
  const metrics = createOperationMetrics({ db:{} });
  assert.throws(() => metrics.start('track.secret-id'), /Unknown operation metric/);
});

test('operation snapshot converts database aggregates to JSON numbers', () => {
  assert.deepEqual(operationMetricSnapshot([{
    name:'federation.sync', count:'4', error_count:'1', duration_ms_total:'101',
    duration_ms_max:'50.25', last_duration_ms:'10.14', last_succeeded:0,
    last_finished_at:'2026-09-26T12:00:00Z',
  }]), { 'federation.sync':{
    count:4, errors:1, duration_ms_average:25.3, duration_ms_max:50.3,
    last_duration_ms:10.1, last_succeeded:false, last_finished_at:'2026-09-26T12:00:00Z',
  } });
});
