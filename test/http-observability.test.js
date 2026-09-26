import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createHttpObserver, httpMetricSnapshot, requestIdFrom, requestKind } from '../src/http-observability.js';

test('request id accepts a safe proxy id and rejects unsafe input', () => {
  assert.equal(requestIdFrom({ 'x-request-id':'proxy-12345678' }), 'proxy-12345678');
  assert.match(requestIdFrom({ 'x-request-id':'bad value with spaces' }), /^[0-9a-f-]{36}$/);
  assert.equal(requestKind('/api/v1/tracks'), 'api');
  assert.equal(requestKind('/federation/v1/node'), 'federation');
});

test('observer emits one safe record and aggregates request duration', () => {
  const metrics = { requests:0, errors5xx:0, duration_ms_total:0, duration_ms_max:0, slow_requests:0 };
  const lines = [];
  const response = new EventEmitter();
  response.statusCode = 503;
  response.setHeader = (name, value) => { response[name] = value; };
  createHttpObserver({ metrics, write:line => lines.push(JSON.parse(line)), slowMs:0 })(
    { method:'GET', headers:{ cookie:'secret', 'x-request-id':'test-request-123' } }, response,
    new URL('https://music.example/api/v1/tracks?token=secret'),
  );
  response.emit('finish');
  response.emit('close');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].request_id, 'test-request-123');
  assert.equal(lines[0].path, '/api/v1/tracks');
  assert.equal(JSON.stringify(lines[0]).includes('secret'), false);
  const snapshot = httpMetricSnapshot(metrics);
  assert.equal(snapshot.requests, 1);
  assert.equal(snapshot.errors_5xx, 1);
  assert.equal(snapshot.slow_requests, 1);
  assert.equal(snapshot.duration_ms_average, snapshot.duration_ms_max);
});
