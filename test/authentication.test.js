import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/security.js';
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

test('login limiter reserves attempts synchronously and bounds inactive IPs', () => {
  const limiter = new LoginAttemptLimiter({limit:2,windowMs:1000,maxEntries:2});
  assert.equal(limiter.take('a',0),true);
  assert.equal(limiter.take('a',1),true);
  assert.equal(limiter.take('a',2),false);
  assert.equal(limiter.take('b',3),true);
  assert.equal(limiter.take('c',4),false);
  assert.equal(limiter.entries.size,2);
  assert.equal(limiter.take('c',1004),true);
  assert.equal(limiter.entries.size,1);
});

test('concurrent logins reserve their IP budget before database responses', async () => {
  let reads = 0;
  const pending = [];
  const db = {prepare(){return {get(){reads++;return new Promise(resolve=>pending.push(resolve));}};}};
  let checks = 0;
  const auth = createAuthenticationService({db,maxConcurrentLogins:20,passwordVerifier:async()=>{checks++;return false;}});
  const input = {username:'missing',password:'bad-password',ip:'ip'};
  const tasks = Array.from({length:8},()=>auth.login(input));
  assert.equal((await auth.login(input)).status,'blocked');
  assert.equal(reads,8);
  pending.forEach(resolve=>resolve(null));
  assert.ok((await Promise.all(tasks)).every(result=>result.status==='invalid'));
  assert.equal(checks,8,'unknown accounts also perform password verification');
});

test('login concurrency slots are released after a database failure', async () => {
  let fail = true;
  const db = {prepare(){return {async get(){if(fail)throw new Error('database unavailable');return null;}};}};
  const auth = createAuthenticationService({db,maxConcurrentLogins:1,passwordVerifier:async()=>false});
  const input = {username:'missing',password:'bad-password',ip:'ip'};
  await assert.rejects(auth.login(input),/database unavailable/);
  fail = false;
  assert.equal((await auth.login(input)).status,'invalid');
});

test('login rejects excessive input before querying or hashing', async () => {
  const auth = createAuthenticationService({db:{prepare(){throw new Error('unexpected query');}}});
  assert.equal((await auth.login({username:'user',password:'x'.repeat(65537),ip:'ip'})).status,'invalid');
});

test('global login concurrency rejects excess work without starting a database request', async () => {
  let release;
  let reads=0;
  const db={prepare(){return {get(){reads++;return new Promise(resolve=>{release=resolve;});}};}};
  const auth=createAuthenticationService({db,maxConcurrentLogins:1,passwordVerifier:async()=>false});
  const task=auth.login({username:'missing',password:'bad',ip:'a'});
  assert.equal((await auth.login({username:'missing',password:'bad',ip:'b'})).status,'blocked');
  assert.equal(reads,1);
  release(null);
  assert.equal((await task).status,'invalid');
});

test('existing password hashes still create secure sessions using asynchronous verification', async () => {
  const user={id:7,username:'user',display_name:'User',password_hash:hashPassword('very-long-password')};
  const inserts=[];
  const db={prepare(){return {async get(){return user;},async run(...args){inserts.push(args);}};}};
  const auth=createAuthenticationService({db,sessionDays:30,secureCookies:true});
  const result=await auth.login({username:'user',password:'very-long-password',ip:'ip'});
  assert.equal(result.status,'ok');
  assert.match(result.cookie,/HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/);
  assert.equal(inserts.length,1);
  assert.equal(inserts[0][1].length,64,'only the token hash is persisted');
});

test('legacy admin-created passwords longer than 256 characters remain valid', async () => {
  const password='x'.repeat(300);
  const user={id:7,username:'user',password_hash:hashPassword(password)};
  const db={prepare(){return {async get(){return user;},async run(){}};}};
  const auth=createAuthenticationService({db,sessionDays:30,secureCookies:true});
  assert.equal((await auth.login({username:'user',password,ip:'ip'})).status,'ok');
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
