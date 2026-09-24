import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionCookie, hasValidSessionOrigin, LoginAttemptLimiter, requestOriginMatches, sessionCookie } from '../src/authentication.js';

const request = ({ method='POST', origin, host='music.example', protocol='https', cookie='' }={}) => ({
  method, headers:{ origin, host, cookie, 'x-forwarded-proto':protocol }, socket:{ remoteAddress:'127.0.0.1' },
});

test('authenticated mutations require an exact Origin', () => {
  assert.equal(hasValidSessionOrigin(request({cookie:'music_session=token'})),false);
  assert.equal(hasValidSessionOrigin(request({cookie:'music_session=token',origin:'https://music.example'})),true);
  assert.equal(hasValidSessionOrigin(request({cookie:'music_session=token',origin:'https://evil.example'})),false);
  assert.equal(hasValidSessionOrigin(request({method:'GET',cookie:'music_session=token'})),true);
  assert.equal(requestOriginMatches(request(),true),true);
});

test('login limiter resets after success or expiry', () => {
  const limiter=new LoginAttemptLimiter({limit:2,windowMs:1000});
  limiter.failure('ip',0);limiter.failure('ip',1);
  assert.equal(limiter.blocked('ip',2),true);
  limiter.success('ip');assert.equal(limiter.blocked('ip',3),false);
  limiter.failure('ip',4);assert.equal(limiter.blocked('ip',1005),false);
});

test('session cookies keep security attributes', () => {
  assert.match(sessionCookie('a b',30,true),/^music_session=a%20b; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/);
  assert.equal(clearSessionCookie(),'music_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
});
