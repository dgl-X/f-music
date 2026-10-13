import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountHttpController } from '../src/account-http.js';

function harness({ authentication = {}, db = {}, body = {}, registrationEnabled = async () => false } = {}) {
  const responses = [];
  const controller = createAccountHttpController({
    db,
    authentication,
    registrationEnabled,
    async readJson() { return body; },
    sendJson(_res, status, value, extra = {}) { responses.push({ status, value, extra }); },
  });
  return { controller, responses };
}

test('account controller returns current user and ignores unrelated routes', async () => {
  const user = { id:7, username:'family' };
  const { controller, responses } = harness();
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/me'), user), true);
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks'), user), false);
  assert.deepEqual(responses[0], { status:200, value:user, extra:{} });
});

test('revoking the current session clears its cookie', async () => {
  const authentication = { async revokeSession() { return { current:true }; } };
  const { controller, responses } = harness({ authentication });
  await controller.handle({ method:'DELETE' }, {}, new URL('https://music.test/api/sessions/41'), { id:7, session_id:41 });
  assert.equal(responses[0].status, 200);
  assert.match(responses[0].extra['Set-Cookie'], /Max-Age=0/);
});

test('registration settings remain admin-only', async () => {
  const { controller, responses } = harness({ registrationEnabled:async () => true });
  await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/admin/registration-settings'), { id:7, is_admin:0 });
  assert.deepEqual(responses[0], { status:403, value:{ error:'Доступно только администратору' }, extra:{} });
});

test('admin user creation validates before database writes', async () => {
  let touched = false;
  const db = { prepare() { touched = true; throw new Error('must not run'); } };
  const { controller, responses } = harness({ db, body:{ username:'x', password:'short' } });
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/users'), { id:1, is_admin:1 });
  assert.equal(responses[0].status, 400);
  assert.equal(touched, false);
});

test('admin cannot reset own password through another user route', async () => {
  const { controller, responses } = harness();
  await controller.handle({ method:'PUT' }, {}, new URL('https://music.test/api/users/7/password'), { id:7, is_admin:1 });
  assert.deepEqual(responses[0], { status:400, value:{ error:'Свой пароль меняется через профиль' }, extra:{} });
});
