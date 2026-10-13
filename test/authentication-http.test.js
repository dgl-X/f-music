import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthenticationHttpController } from '../src/authentication-http.js';

function request(method = 'POST', extraHeaders = {}) {
  return { method, headers:{ host:'music.test', 'x-forwarded-proto':'https', ...extraHeaders }, socket:{ remoteAddress:'127.0.0.1' } };
}

function harness({ db = {}, authentication = {}, body = {}, registrationEnabled = async () => false, registrationLimiter } = {}) {
  const responses = [];
  const controller = createAuthenticationHttpController({
    db,
    authentication,
    registrationEnabled,
    registrationLimiter,
    async readJson() { return body; },
    sendJson(_res, status, value, extra = {}) { responses.push({ status, value, extra }); },
  });
  return { controller, responses };
}

test('setup HTTP preserves validation and already-configured responses', async () => {
  for (const [result, status] of [[{ status:'invalid', error:'bad' }, 400], [{ status:'configured' }, 409]]) {
    const { controller, responses } = harness({ authentication:{ async setup() { return result; } } });
    await controller.handle(request(), {}, new URL('https://music.test/api/setup'));
    assert.equal(responses[0].status, status);
  }
});

test('registration rejects an untrusted Origin before touching settings', async () => {
  let checked = false;
  const { controller, responses } = harness({ registrationEnabled:async () => { checked = true; return true; } });
  await controller.handle(request('POST', { origin:'https://evil.test' }), {}, new URL('https://music.test/api/register'));
  assert.equal(responses[0].status, 403);
  assert.equal(checked, false);
});

test('registration rate limit keeps its Retry-After response', async () => {
  const db = { prepare() { return { async get() { return { count:1 }; } }; } };
  const registrationLimiter = { take() { return false; } };
  const { controller, responses } = harness({ db, registrationEnabled:async () => true, registrationLimiter });
  await controller.handle(request('POST', { origin:'https://music.test' }), {}, new URL('https://music.test/api/register'));
  assert.deepEqual(responses[0], { status:429, value:{ error:'Слишком много регистраций. Повторите позже' }, extra:{ 'Retry-After':'3600' } });
});

test('login forwards client metadata and sets the session cookie', async () => {
  let input;
  const authentication = { async login(value) { input = value; return { status:'ok', user:{ id:7 }, cookie:'music_session=safe' }; } };
  const { controller, responses } = harness({ authentication, body:{ username:'user', password:'password', device_name:'Pixel', client_name:'Android' } });
  await controller.handle(request('POST', { 'user-agent':'agent' }), {}, new URL('https://music.test/api/login'));
  assert.equal(input.ip, '127.0.0.1');
  assert.equal(input.deviceName, 'Pixel');
  assert.equal(responses[0].extra['Set-Cookie'], 'music_session=safe');
});

test('logout deletes the server session and expires its cookie', async () => {
  let cookie;
  const authentication = { async logout(value) { cookie = value; } };
  const { controller, responses } = harness({ authentication });
  await controller.handle(request('POST', { cookie:'music_session=token' }), {}, new URL('https://music.test/api/logout'));
  assert.equal(cookie, 'music_session=token');
  assert.match(responses[0].extra['Set-Cookie'], /Max-Age=0/);
});
