import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackHttpController } from '../src/playback-http.js';

function harness({ row, body = {}, decodeRemoteReference, saveResult = true } = {}) {
  const responses = [];
  let saved, readLimit;
  const controller = createPlaybackHttpController({
    db:{ prepare() { return { async get() { return row; } }; } },
    decodeRemoteReference:decodeRemoteReference || (() => { throw new Error('invalid reference'); }),
    async savePlaybackState(input) { saved = input; return saveResult; },
    async readJson(_req, limit) { readLimit = limit; return body; },
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses, get saved() { return saved; }, get readLimit() { return readLimit; } };
}

test('playback controller ignores unrelated routes and unsupported methods', async () => {
  const first = harness(), second = harness();
  assert.equal(await first.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/history'), { id:7 }), false);
  assert.equal(await second.controller.handle({ method:'DELETE' }, {}, new URL('https://music.test/api/playback-state'), { id:7 }), false);
  assert.deepEqual(first.responses, []);
  assert.deepEqual(second.responses, []);
});

test('missing playback state returns stable defaults', async () => {
  const h = harness();
  assert.equal(await h.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/playback-state'), { id:7 }), true);
  assert.deepEqual(h.responses[0], { status:200, value:{ track_id:null, position_seconds:0, queue:[], shuffle:false, repeat_mode:'off', queue_source:'Очередь' } });
});

test('stored remote state restores its public id and tolerates damaged queue JSON', async () => {
  const h = harness({ row:{ track_id:null, remote_track_ref:'encoded', position_seconds:12, queue_json:'broken', shuffle:1, repeat_mode:'all', queue_source:'Микс' } });
  await h.controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/playback-state'), { id:7 });
  assert.equal(h.responses[0].value.track_id, 'remote:encoded');
  assert.deepEqual(h.responses[0].value.queue, []);
  assert.equal(h.responses[0].value.shuffle, true);
  assert.equal(h.responses[0].value.queue_json, undefined);
  assert.equal(h.responses[0].value.remote_track_ref, undefined);
});

test('playback update normalizes and bounds client state', async () => {
  const local = '11111111-1111-4111-8111-111111111111';
  const remote = 'remote:reference';
  const h = harness({ body:{
    track_id:local, position_seconds:-15, queue:[local, 'bad', remote, local],
    shuffle:1, repeat_mode:'invalid', queue_source:`  ${'x'.repeat(130)}  `,
  } });
  await h.controller.handle({ method:'PUT' }, {}, new URL('https://music.test/api/playback-state'), { id:7 });
  assert.equal(h.readLimit, 1024 * 1024);
  assert.equal(h.saved.userId, 7);
  assert.equal(h.saved.trackId, local);
  assert.equal(h.saved.position, 0);
  assert.deepEqual(h.saved.queue, [local, remote]);
  assert.equal(h.saved.repeatMode, 'off');
  assert.equal(h.saved.queueSource.length, 120);
  assert.deepEqual(h.responses[0], { status:200, value:{ ok:true } });
});

test('invalid remote current track is rejected before persistence', async () => {
  const h = harness({ body:{ track_id:'remote:broken' } });
  await h.controller.handle({ method:'PUT' }, {}, new URL('https://music.test/api/playback-state'), { id:7 });
  assert.equal(h.responses[0].status, 400);
  assert.equal(h.saved, undefined);
});

test('valid remote current track passes decoded identity to persistence', async () => {
  const decoded = { nodeId:'node', objectId:'track' };
  const h = harness({ body:{ track_id:'remote:encoded', repeat_mode:'one' }, decodeRemoteReference:() => decoded });
  await h.controller.handle({ method:'PUT' }, {}, new URL('https://music.test/api/playback-state'), { id:7 });
  assert.equal(h.saved.trackId, null);
  assert.equal(h.saved.remoteTrackRef, 'encoded');
  assert.equal(h.saved.decodedRemote, decoded);
  assert.equal(h.saved.repeatMode, 'one');
});

test('persistence rejection keeps the compatible local-track error', async () => {
  const h = harness({ body:{ track_id:'missing' }, saveResult:false });
  await h.controller.handle({ method:'PUT' }, {}, new URL('https://music.test/api/playback-state'), { id:7 });
  assert.deepEqual(h.responses[0], { status:400, value:{ error:'Некорректный текущий трек' } });
});
