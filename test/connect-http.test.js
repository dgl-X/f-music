import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectHttpController } from '../src/connect-http.js';

function harness(connect, body = {}) {
  const responses = [];
  const controller = createConnectHttpController({
    connect,
    async readJson() { return body; },
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses };
}

test('Connect status remains available while the feature is disabled', async () => {
  const { controller, responses } = harness({ enabled:false });
  const handled = await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/connect/status'), { id:7 });
  assert.equal(handled, true);
  assert.deepEqual(responses, [{ status:200, value:{ enabled:false, transport:'polling', poll_interval_ms:1500 } }]);
});

test('disabled Connect rejects its other routes with a stable error code', async () => {
  const { controller, responses } = harness({ enabled:false });
  await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/connect/devices'), { id:7 });
  assert.deepEqual(responses, [{ status:404, value:{ error:'Family Music Connect выключен', error_code:'connect_disabled' } }]);
});

test('Connect HTTP controller preserves device registration validation errors', async () => {
  const connect = { enabled:true, async registerDevice(userId, body) {
    assert.equal(userId, 7);
    assert.equal(body.id, 'short');
    return { status:'invalid', error:'Некорректный ID устройства' };
  } };
  const { controller, responses } = harness(connect, { id:'short' });
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/connect/devices'), { id:7 });
  assert.deepEqual(responses, [{ status:400, value:{ error:'Некорректный ID устройства' } }]);
});

test('Connect command route maps an offline target to conflict', async () => {
  const connect = { enabled:true, async sendCommand() { return { status:'target_offline' }; } };
  const { controller, responses } = harness(connect, { source_device_id:'web_0123456789abcdef', action:'next' });
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/connect/commands'), { id:7 });
  assert.deepEqual(responses, [{ status:409, value:{ error:'Активное устройство недоступно' } }]);
});

test('Connect HTTP controller ignores unrelated and unknown enabled routes', async () => {
  const { controller, responses } = harness({ enabled:true });
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks'), { id:7 }), false);
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/connect/unknown'), { id:7 }), false);
  assert.deepEqual(responses, []);
});
