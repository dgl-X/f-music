import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationalHttpController } from '../src/operational-http.js';

function harness(options = {}) {
  const responses = [];
  const controller = createOperationalHttpController({
    db:options.db || { prepare() { return { async get() { return { ok:1 }; } }; } },
    storageDir:'/storage',
    workerMode:false,
    softwareVersion:'0.1.29',
    metricsToken:'metrics-secret',
    registrationEnabled:async () => false,
    observability:options.observability || {},
    accessStorage:options.accessStorage || (() => {}),
    sendJson(_res, status, value) { responses.push({ status, value }); },
    ...options.controller,
  });
  return { controller, responses };
}

test('health reports database and writable storage state', async () => {
  const { controller, responses } = harness();
  assert.equal(await controller.handlePublic({ method:'GET', headers:{} }, {}, new URL('https://music.test/api/health')), true);
  assert.deepEqual(responses[0], { status:200, value:{ status:'ok', database:'ok', storage:'ok', role:'api' } });
});

test('health degrades when storage access fails', async () => {
  const { controller, responses } = harness({ accessStorage() { throw new Error('readonly'); } });
  await controller.handlePublic({ method:'GET', headers:{} }, {}, new URL('https://music.test/api/health'));
  assert.deepEqual(responses[0], { status:503, value:{ status:'degraded' } });
});

test('Zabbix metrics reject an invalid bearer without reading metrics', async () => {
  let touched = false;
  const { controller, responses } = harness({ observability:{ async metrics() { touched = true; } } });
  await controller.handlePublic({ method:'GET', headers:{ authorization:'Bearer wrong' } }, {}, new URL('https://music.test/api/metrics/zabbix'));
  assert.equal(responses[0].status, 401);
  assert.equal(touched, false);
});

test('setup status keeps worker readiness and public version fields', async () => {
  const rows = [{ count:0 }, { value:'Дом' }, { age_seconds:12 }];
  const db = { prepare() { return { async get() { return rows.shift(); } }; } };
  const { controller, responses } = harness({ db, controller:{ registrationEnabled:async () => true } });
  await controller.handlePublic({ method:'GET', headers:{} }, {}, new URL('https://music.test/api/setup/status'));
  assert.equal(responses[0].value.needs_setup, true);
  assert.equal(responses[0].value.library_name, 'Дом');
  assert.equal(responses[0].value.checks.worker, 'ok');
  assert.equal(responses[0].value.registration_enabled, true);
  assert.equal(responses[0].value.features.android_settings_portal,1);
});

test('administrative metrics remain admin-only', async () => {
  const { controller, responses } = harness();
  await controller.handleAdmin({ method:'GET' }, {}, new URL('https://music.test/api/admin/metrics'), { id:7, is_admin:0 });
  assert.deepEqual(responses[0], { status:403, value:{ error:'Доступно только администратору' } });
});
