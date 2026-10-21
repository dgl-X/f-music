import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireCounter, DUMMY_PASSWORD_HASH, hashPassword, parseContentRange, releaseCounter, verifyPassword, verifyPasswordAsync } from '../src/security.js';

test('asynchronous password verification keeps existing hashes compatible', async () => {
  const hash = hashPassword('very-long-password');
  assert.equal(await verifyPasswordAsync('very-long-password', hash), true);
  assert.equal(await verifyPasswordAsync('wrong-password', hash), false);
  assert.equal(await verifyPasswordAsync('wrong-password', DUMMY_PASSWORD_HASH), false);
  assert.equal(await verifyPasswordAsync('anything', 'scrypt$bad$bad'), false);
  assert.equal(await verifyPasswordAsync('anything', null), false);
});

test('password hashes verify safely', () => {
  const hash = hashPassword('very-long-password');
  assert.equal(verifyPassword('very-long-password', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);
});

test('content range parser validates bounds', () => {
  assert.deepEqual(parseContentRange('bytes 10-19/100'), { start: 10, end: 19, total: 100, length: 10 });
  assert.equal(parseContentRange('bytes 20-10/100'), null);
  assert.equal(parseContentRange('bytes 0-100/100'), null);
});

test('stream counter enforces its limit and ignores unrelated releases', () => {
  const counter = new Map();
  assert.equal(acquireCounter(counter, 'peer-a', 2), true);
  assert.equal(acquireCounter(counter, 'peer-a', 2), true);
  assert.equal(acquireCounter(counter, 'peer-a', 2), false);
  releaseCounter(counter, 'peer-b');
  assert.equal(counter.get('peer-a'), 2);
  releaseCounter(counter, 'peer-a');
  assert.equal(acquireCounter(counter, 'peer-a', 2), true);
});
