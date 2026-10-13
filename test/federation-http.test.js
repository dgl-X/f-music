import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboundFederationHttpController } from '../src/federation-http.js';

function harness(overrides = {}) {
  const responses = [];
  const federation = overrides.federation || {
    async settings() { return { enabled:true, endpoints:[{ scope:'public', url:'https://music.test' }] }; },
    async trustedPeer() { return null; },
    consumeNonce() {},
  };
  const controller = createInboundFederationHttpController({
    federation,
    pairing:overrides.pairing || { async accept() { return { ok:true }; } },
    sync:overrides.sync || {},
    loadIdentity:overrides.loadIdentity || (() => ({ node_id:'fm:test-node', public_key:'public' })),
    publicNodeDescriptor:overrides.publicNodeDescriptor || ((identity, options) => ({ identity, options })),
    externalRequestUri:() => 'https://music.test/federation',
    verifyRequest:overrides.verifyRequest || (async () => {}),
    readBytes:overrides.readBytes || (async () => Buffer.from('{}')),
    sendJson(_res, status, value) { responses.push({ status, value }); },
    jsonHeaders:{ 'Content-Type':'application/json; charset=utf-8' },
    softwareVersion:'0.1.29',
  });
  return { controller, responses };
}

test('public federation descriptor is hidden while federation is disabled', async () => {
  const { controller, responses } = harness({
    federation:{ async settings() { return { enabled:false, endpoints:[] }; } },
  });
  const handled = await controller.handle({ method:'GET', headers:{} }, {}, new URL('https://music.test/.well-known/family-music'));
  assert.equal(handled, true);
  assert.deepEqual(responses[0], {
    status:404,
    value:{ error:{ code:'federation_disabled', message:'Федерация выключена', retryable:false } },
  });
});

test('public health exposes only stable node and protocol fields', async () => {
  const { controller, responses } = harness();
  await controller.handle({ method:'GET', headers:{} }, {}, new URL('https://music.test/federation/v1/health'));
  assert.deepEqual(responses[0], {
    status:200,
    value:{ status:'ok', node_id:'fm:test-node', protocol_version:1 },
  });
});

test('catalog delta rejects an untrusted node before signature verification', async () => {
  let verified = false;
  const { controller, responses } = harness({ verifyRequest:async () => { verified = true; } });
  await controller.handle(
    { method:'GET', headers:{ 'x-family-music-node':'fm:unknown-node-0001' } },
    {},
    new URL('https://music.test/federation/v1/catalog/delta'),
  );
  assert.equal(verified, false);
  assert.deepEqual(responses[0], {
    status:403,
    value:{ error:{ code:'peer_not_trusted', message:'Нода не подключена или отозвана', retryable:false } },
  });
});

test('invalid pairing JSON keeps its stable client error', async () => {
  let accepted = false;
  const { controller, responses } = harness({
    pairing:{ async accept() { accepted = true; } },
    readBytes:async () => Buffer.from('{broken'),
  });
  await controller.handle(
    { method:'POST', headers:{} },
    {},
    new URL('https://music.test/federation/v1/pairing/accept'),
  );
  assert.equal(accepted, false);
  assert.deepEqual(responses[0], {
    status:400,
    value:{ error:{ code:'invalid_json', message:'Некорректный JSON', retryable:false } },
  });
});

test('valid signed delta preserves response body and signature headers', async () => {
  const output = { status:null, headers:null, body:null };
  const peer = { node_id:'fm:trusted-node-001', public_key:'peer-key' };
  const { controller } = harness({
    federation:{
      async settings() { return { enabled:true, endpoints:[] }; },
      async trustedPeer() { return peer; },
      consumeNonce() {},
    },
    sync:{ async delta(input) {
      assert.equal(input.peerNodeId, peer.node_id);
      return { headers:{ 'X-Family-Music-Signature':'signature' }, body:'{"events":[]}' };
    } },
  });
  const res = {
    writeHead(status, headers) { output.status = status; output.headers = headers; },
    end(body) { output.body = body; },
  };
  await controller.handle(
    { method:'GET', headers:{ 'x-family-music-node':peer.node_id } },
    res,
    new URL('https://music.test/federation/v1/catalog/delta?limit=10'),
  );
  assert.equal(output.status, 200);
  assert.equal(output.headers['X-Family-Music-Signature'], 'signature');
  assert.equal(output.body, '{"events":[]}');
});
