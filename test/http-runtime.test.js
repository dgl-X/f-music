import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createUserAccess, parseRequestUrl, readBytes, readJson, setBrowserSecurityHeaders } from '../src/http-runtime.js';

test('malformed request hosts produce a controlled bad-request error', () => {
  assert.throws(()=>parseRequestUrl({url:'/api/v1/health',headers:{host:'[malformed'}}),error=>error.status===400);
  assert.equal(parseRequestUrl({url:'/api/v1/health',headers:{host:'music.example'}}).pathname,'/api/v1/health');
});

const request = (chunks, headers = {}) => Object.assign(Readable.from(chunks), { headers });

test('request readers enforce limits and parse JSON', async () => {
  assert.deepEqual(await readJson(request([Buffer.from('{"ok":true}')]), 32), { ok:true });
  await assert.rejects(readJson(request([Buffer.from('{')]), 32), error => error.status === 400);
  await assert.rejects(readBytes(request([Buffer.from('abcd')], { 'content-length':'4' }), 3), error => error.status === 413);
  await assert.rejects(readBytes(request([]), 3), error => error.status === 400);
});

test('user access refreshes an authenticated session cookie', async () => {
  const headers = {}, responses = [];
  const access = createUserAccess({
    authentication:{ async currentUser(input) { assert.equal(input.cookieHeader, 'music_session=token'); return { id:7 }; } },
    parseCookies:() => ({ music_session:'token' }), requestIp:() => 'client',
    sessionCookie:token => `music_session=${token}`, sessionDays:30, secureCookies:true,
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  const user = await access.requireUser({ headers:{ cookie:'music_session=token' } }, { setHeader(name, value) { headers[name] = value; } });
  assert.equal(user.id, 7);
  assert.equal(headers['Set-Cookie'], 'music_session=token');
  assert.deepEqual(responses, []);
});

test('user access preserves unauthorized response', async () => {
  const responses = [];
  const access = createUserAccess({
    authentication:{ async currentUser() { return null; } }, parseCookies:() => ({}), requestIp:() => '', sessionCookie:() => '',
    sessionDays:30, secureCookies:true, sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  assert.equal(await access.requireUser({ headers:{} }, {}), null);
  assert.deepEqual(responses[0], { status:401, value:{ error:'Требуется авторизация' } });
});

test('browser security headers enable HSTS only behind HTTPS', () => {
  const collect = requestHeaders => {
    const headers = {};
    setBrowserSecurityHeaders({ headers:requestHeaders, socket:{} }, { setHeader(name, value) { headers[name] = value; } });
    return headers;
  };
  const plain = collect({}), secure = collect({ 'x-forwarded-proto':'https' });
  assert.equal(plain['X-Content-Type-Options'], 'nosniff');
  assert.equal(plain['X-Frame-Options'], 'DENY');
  assert.match(plain['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(plain['Strict-Transport-Security'], undefined);
  assert.equal(secure['Strict-Transport-Security'], 'max-age=31536000');
});
