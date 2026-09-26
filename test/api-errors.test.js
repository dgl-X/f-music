import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultErrorCode, normalizeErrorResponse } from '../src/api-errors.js';

test('legacy string errors gain a stable code without changing their message', () => {
  assert.deepEqual(normalizeErrorResponse(404, { error:'Трек не найден' }, 'request-12345678'), {
    error:'Трек не найден',
    error_code:'not_found',
    retryable:false,
    request_id:'request-12345678',
  });
});

test('existing federation error codes and retry policy take precedence', () => {
  const error = { code:'variant_not_ready', message:'AAC-вариант готовится', retryable:true };
  assert.deepEqual(normalizeErrorResponse(409, { error }, 'request-87654321'), {
    error,
    error_code:'variant_not_ready',
    retryable:true,
    request_id:'request-87654321',
  });
});

test('retryable status defaults are explicit and successful payloads stay untouched', () => {
  assert.equal(defaultErrorCode(503), 'service_unavailable');
  assert.equal(normalizeErrorResponse(503, { error:'Позже' }, 'request-12345678').retryable, true);
  const success = { error:null, status:'ready' };
  assert.equal(normalizeErrorResponse(200, success, 'request-12345678'), success);
});
