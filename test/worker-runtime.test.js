import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerRuntime } from '../src/worker-runtime.js';

test('worker runtime schedules every background subsystem and can stop', async () => {
  const scheduled = [], cleared = [], calls = [];
  const method = name => async () => { calls.push(name); };
  const runtime = createWorkerRuntime({
    config:{ workerPollMs:100, uploadCleanupMinutes:5 },
    maintenance:{ heartbeat:method('heartbeat'), enrichTracks:method('enrich'), cleanupUploads:method('uploads'), cleanupReports:method('reports'), cleanupFederation:method('federation-cleanup') },
    uploadJobs:{ recover:method('upload-recover') }, uploadWorker:{ processNext:method('upload') },
    transcoding:{ recover:method('transcode-recover'), processNext:method('transcode') },
    recognition:{ recover:method('recognition-recover'), processNext:method('recognition') },
    loudness:{ recover:method('loudness-recover'), pump:method('loudness') },
    federationImport:{ recover:method('replica-recover'), processNext:method('replica') },
    federation:{ async settings() { return { enabled:false }; } }, federationSync:{ sync:method('sync'), notify:method('notify') },
    federationAvailability:{ check:method('check') }, loadFederationIdentity:() => null, probeFederationEndpoint() {},
    setIntervalFn(fn, interval) { scheduled.push({ fn, interval }); return scheduled.length; }, clearIntervalFn:id => cleared.push(id), logError() {},
  });
  runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled.length, 13);
  assert.ok(calls.includes('heartbeat'));
  assert.ok(calls.includes('upload-recover'));
  assert.ok(calls.includes('loudness-recover'));
  assert.ok(calls.includes('enrich'));
  runtime.stop();
  assert.equal(cleared.length, scheduled.length);
});

test('federation jobs do nothing while federation is disabled', async () => {
  let touched = false;
  const runtime = createWorkerRuntime({
    config:{}, maintenance:{}, uploadJobs:{}, uploadWorker:{}, transcoding:{}, recognition:{}, loudness:{}, federationImport:{},
    federation:{ async settings() { return { enabled:false }; } }, federationSync:{ async sync() { touched=true; }, async notify() { touched=true; } },
    federationAvailability:{ async check() { touched=true; } }, loadFederationIdentity:() => ({ id:'node' }), probeFederationEndpoint() {},
  });
  await runtime.syncFederationCatalogs(); await runtime.notifyFederationPeers(); await runtime.checkFederationPeers();
  assert.equal(touched, false);
});
