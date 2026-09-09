import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { federationContentDigest, signFederationRequest, signFederationResponse, signPairingConfirmation, verifyFederationRequest, verifyFederationResponse, verifyPairingConfirmation } from '../src/federation-signatures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vector = JSON.parse(fs.readFileSync(path.join(root, 'federation/vectors/http-signature-ed25519-v1.json'), 'utf8'));

test('signature implementation remains compatible with published vector', async () => {
  const headers = {
    'content-digest': vector.content_digest,
    'x-family-music-node': vector.node_id,
    'x-family-music-nonce': vector.nonce,
    'signature-input': vector.signature_input,
    signature: vector.signature,
  };
  const result = await verifyFederationRequest({ method: vector.method, targetUri: vector.target_uri, body: vector.body, headers, publicKey: vector.public_key_pem, now: 1788714000 });
  assert.equal(result.nodeId, vector.node_id);
  assert.equal(federationContentDigest(vector.body), vector.content_digest);
});

test('pairing confirmation binds both nodes, invitation and challenge', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const values = { invitationId: crypto.randomUUID(), requesterNodeId: 'fm:requester', issuerNodeId: 'fm:issuer', challenge: 'unique-challenge' };
  const signature = signPairingConfirmation(values, privateKey);
  assert.equal(verifyPairingConfirmation(values, signature, publicKey), true);
  assert.equal(verifyPairingConfirmation({ ...values, challenge: 'changed' }, signature, publicKey), false);
});

test('federation response signature binds exact body and node', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'), body=Buffer.from('{"items":[]}'), nodeId='fm:response-node';
  const headers=signFederationResponse(body,nodeId,privateKey);
  assert.equal(verifyFederationResponse(body,headers,nodeId,publicKey),true);
  assert.equal(verifyFederationResponse(Buffer.from('{"items":[1]}'),headers,nodeId,publicKey),false);
});

test('signed requests reject tampering, stale time and replay', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const request = { method: 'POST', targetUri: 'https://node.example/federation/v1/test', body: '{"ok":true}', nodeId: 'fm:test-node-1234567890', privateKeyPem: privateKey, created: 2000, nonce: 'test-nonce-1234567890' };
  const headers = signFederationRequest(request);
  const used = new Set();
  const consumeNonce = async (nodeId, nonce) => { const key = `${nodeId}:${nonce}`; if (used.has(key)) return false; used.add(key); return true; };
  await verifyFederationRequest({ ...request, headers, publicKey, expectedNodeId: request.nodeId, now: 2001, consumeNonce });
  await assert.rejects(() => verifyFederationRequest({ ...request, headers, publicKey, now: 2001, consumeNonce }), error => error.code === 'replay_detected');
  await assert.rejects(() => verifyFederationRequest({ ...request, body: '{"ok":false}', headers, publicKey, now: 2001 }), error => error.code === 'digest_mismatch');
  await assert.rejects(() => verifyFederationRequest({ ...request, headers, publicKey, now: 2600 }), error => error.code === 'clock_skew');
});
