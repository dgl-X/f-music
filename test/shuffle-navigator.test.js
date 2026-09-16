import test from 'node:test';
import assert from 'node:assert/strict';
import { ShuffleNavigator } from '../public/shuffle-navigator.js';

test('shuffle previous returns the track that actually played before', () => {
  const navigator = new ShuffleNavigator(() => 0.25); navigator.reset(5, 2);
  const first = navigator.next(5, 2), second = navigator.next(5, first);
  assert.notEqual(first, 2); assert.notEqual(second, first);
  assert.equal(navigator.previous(5, second), first); assert.equal(navigator.previous(5, first), 2); assert.equal(navigator.next(5, 2), first);
});

test('shuffle skips failed tracks and does not invent previous history', () => {
  const navigator = new ShuffleNavigator(() => 0); navigator.reset(4, 0);
  const next = navigator.next(4, 0, index => index !== 1);
  assert.notEqual(next, 1); assert.equal(navigator.previous(4, next), 0); assert.equal(navigator.previous(4, 0), -1);
});

test('shuffle preview shows two upcoming tracks without changing the order', () => {
  const navigator = new ShuffleNavigator(() => 0.25);
  navigator.reset(5, 2);
  const before = [...navigator.order];
  const upcoming = navigator.peekUpcoming(5, 2, index => index !== 3, 2, false);
  assert.equal(upcoming.length, 2);
  assert.deepEqual(navigator.order, before);
  assert.equal(navigator.next(5, 2, index => index !== 3), upcoming[0]);
  assert.equal(navigator.next(5, upcoming[0], index => index !== 3), upcoming[1]);
});
