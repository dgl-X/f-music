import test from 'node:test';
import assert from 'node:assert/strict';
import { RegistrationLimiter, validateRegistration } from '../src/registration.js';

test('registration limiter fails closed at capacity and removes expired IPs', () => {
  const limiter=new RegistrationLimiter({maxEntries:2,windowMs:1000});
  assert.equal(limiter.take('a',0),true);
  assert.equal(limiter.take('b',1),true);
  assert.equal(limiter.take('c',2),false);
  assert.equal(limiter.entries.size,2);
  assert.equal(limiter.take('c',1001),true);
  assert.equal(limiter.entries.size,1);
});

test('registration validates and normalizes a family account', () => {
  assert.deepEqual(validateRegistration({username:' wife ',display_name:'Жена',password:'long-password'}),{username:'wife',displayName:'Жена',password:'long-password'});
  assert.match(validateRegistration({username:'я',password:'long-password'}).error,/Логин/);
  assert.match(validateRegistration({username:'wife',password:'short'}).error,/Пароль/);
});

test('registration limiter permits five requests per address and resets', () => {
  const limiter=new RegistrationLimiter({limit:5,windowMs:1000});
  for(let i=0;i<5;i++)assert.equal(limiter.take('127.0.0.1',0),true);
  assert.equal(limiter.take('127.0.0.1',999),false);
  assert.equal(limiter.take('127.0.0.1',1000),true);
});
