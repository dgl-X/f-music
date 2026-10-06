import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionCookie, createAuthenticationService, hasValidSessionOrigin, LoginAttemptLimiter, requestOriginMatches, sessionCookie, validateInitialSetup, validateNewPassword } from '../src/authentication.js';

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

test('active sessions extend their expiry from the latest use', async () => {
  const calls=[];
  const db={prepare(sql){return{
    async get(){if(sql.startsWith('SELECT users.id'))return{id:7,username:'user',session_id:41};},
    async run(...params){calls.push({sql,params});return{changes:1};},
  };}};
  const authentication=createAuthenticationService({db,sessionDays:30,secureCookies:true});
  const user=await authentication.currentUser({cookieHeader:'music_session=token',deviceName:'Pixel',clientName:'Android',ip:'127.0.0.1'});
  assert.equal(user.id,7);
  assert.match(calls[0].sql,/expires_at=CURRENT_TIMESTAMP\+\(\? \* INTERVAL '1 day'\)/);
  assert.deepEqual(calls[0].params,['127.0.0.1',30,'Pixel','Pixel','Android','Android',41]);
});

test('initial setup and password changes share strict validation',()=>{
  assert.deepEqual(validateInitialSetup({username:' admin ',display_name:'Дом',library_name:'Музыка',password:'long-password'}),{username:'admin',displayName:'Дом',libraryName:'Музыка',password:'long-password',recognitionEnabled:false});
  assert.match(validateInitialSetup({username:'я',password:'long-password'}).error,/пользователя/);
  assert.match(validateInitialSetup({username:'admin',library_name:'x',password:'long-password'}).error,/библиотеки/);
  assert.deepEqual(validateNewPassword('new-password'),{password:'new-password'});
  assert.match(validateNewPassword('short').error,/пароль/i);
  assert.match(validateNewPassword('x'.repeat(257)).error,/пароль/i);
});
