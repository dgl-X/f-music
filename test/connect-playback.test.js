import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForPlayback } from '../public/connect-playback.js';

test('Connect readiness waits for delayed media preparation', async () => {
  let ready=false,completed=false;
  const waiting=waitForPlayback(()=>ready,{timeoutMs:500,intervalMs:5}).then(()=>{completed=true;});
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(completed,false);
  ready=true;
  await waiting;
  assert.equal(completed,true);
});

test('Connect preparation fails instead of acknowledging an unavailable player', async () => {
  await assert.rejects(waitForPlayback(()=>false,{timeoutMs:10,intervalMs:5}),/не подтвердил/);
});
