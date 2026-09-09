import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describePublicKey, ensureFederationIdentity, loadFederationIdentity, publicNodeDescriptor } from '../src/federation-identity.js';

test('federation identity is stable, private and has a key-derived node id', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-federation-'));
  try {
    const first = ensureFederationIdentity(storage), second = ensureFederationIdentity(storage);
    assert.equal(first.node_id, second.node_id);
    assert.match(first.node_id, /^fm:[A-Za-z0-9_-]{43}$/);
    assert.equal(first.node_id, describePublicKey(first.public_key_pem).nodeId);
    assert.equal(fs.statSync(path.join(storage, 'federation', 'identity.json')).mode & 0o777, 0o600);
    assert.equal(loadFederationIdentity(storage).private_key_pem, first.private_key_pem);
  } finally { fs.rmSync(storage, { recursive: true, force: true }); }
});

test('public node descriptor never contains the private key', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'family-music-federation-'));
  try {
    const identity = ensureFederationIdentity(storage);
    const descriptor = publicNodeDescriptor(identity, { softwareVersion: '1.2.3', endpoints: [] });
    assert.equal(descriptor.software_version, '1.2.3');
    assert.equal(descriptor.public_key.algorithm, 'ed25519');
    assert.equal(JSON.stringify(descriptor).includes('PRIVATE KEY'), false);
  } finally { fs.rmSync(storage, { recursive: true, force: true }); }
});
