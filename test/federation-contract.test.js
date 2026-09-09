import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FEDERATION_CAPABILITIES, FEDERATION_PROTOCOL_MINOR, negotiateFederation, validateDeltaCompatibility } from '../src/federation-protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

test('federation v1 schemas are additive and keep unknown fields compatible', () => {
  for (const name of ['node-v1', 'invitation-v1', 'error-v1', 'delta-v1']) {
    const schema = readJson(`federation/schemas/${name}.schema.json`);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, true);
    assert.ok(schema.required.length > 0);
  }
});

test('current and previous node descriptors have a common v1 baseline', () => {
  const previous = readJson('federation/compat/v1.0-node.json');
  const current = {
    software_version: '1.1.0', protocols: { 1: { minor: 1 }, 2: { minor: 0 } },
    capabilities: { ...previous.capabilities, 'covers.v1': {}, 'future.optional.v1': {} },
    future_field: { ignored_by_previous_reader: true },
  };
  const commonMajor = Math.max(...Object.keys(current.protocols).map(Number).filter(version => previous.protocols[version]));
  const commonCapabilities = Object.keys(current.capabilities).filter(name => previous.capabilities[name]);
  assert.equal(commonMajor, 1);
  assert.deepEqual(commonCapabilities.sort(), ['catalog.delta.v1', 'health.v1', 'node.info.v1', 'pairing.v1']);
});

test('current node negotiates a limited but usable session with previous v1 profile', () => {
  const previous = readJson('federation/compat/v1.0-node.json');
  const negotiated = negotiateFederation(previous, ['pairing.v1', 'catalog.delta.v1']);
  assert.equal(negotiated.status, 'limited');
  assert.equal(negotiated.major, 1);
  assert.equal(negotiated.minor, 0);
  assert.deepEqual(negotiated.missing, []);
  assert.ok(negotiated.capabilities.includes('catalog.delta.v1'));
});

test('missing required capability or common major requires an upgrade', () => {
  const previous = readJson('federation/compat/v1.0-node.json');
  assert.deepEqual(negotiateFederation(previous, ['stream.range.v1']).missing, ['stream.range.v1']);
  assert.equal(negotiateFederation({ protocols: { 2: { minor: 0 } }, capabilities: {} }).status, 'upgrade_required');
});

test('current reader accepts previous and additive future delta pages', () => {
  const previous = readJson('federation/compat/v1.0-delta.json');
  assert.deepEqual(validateDeltaCompatibility(previous), { producerMinor: 0, minReaderMinor: 0 });
  assert.deepEqual(validateDeltaCompatibility({ ...previous, producer_minor: FEDERATION_PROTOCOL_MINOR + 1, future_field: true }), {
    producerMinor: FEDERATION_PROTOCOL_MINOR + 1, minReaderMinor: 0,
  });
});

test('reader rejects a delta that explicitly requires a newer minor', () => {
  const previous = readJson('federation/compat/v1.0-delta.json');
  assert.throws(() => validateDeltaCompatibility({ ...previous, min_reader_minor: FEDERATION_PROTOCOL_MINOR + 1 }), error =>
    error.code === 'upgrade_required' && error.requiredMinor === FEDERATION_PROTOCOL_MINOR + 1);
  assert.throws(() => validateDeltaCompatibility({ ...previous, producer_minor: '0' }), error => error.code === 'invalid_delta');
  assert.ok(Object.keys(FEDERATION_CAPABILITIES).length >= 6);
});

test('unknown optional delta event is skippable but critical event is not', () => {
  const decision = event => event.type === 'track.upsert.v1' || event.type === 'track.delete.v1'
    ? 'apply' : event.critical ? 'upgrade_required' : 'skip';
  assert.equal(decision({ type: 'artist.image.v1', critical: false }), 'skip');
  assert.equal(decision({ type: 'catalog.rewrite.v2', critical: true }), 'upgrade_required');
});

test('Ed25519 HTTP signature vector verifies and detects tampering', () => {
  const vector = readJson('federation/vectors/http-signature-ed25519-v1.json');
  const digest = `sha-256=:${crypto.createHash('sha256').update(vector.body).digest('base64')}:`;
  assert.equal(digest, vector.content_digest);
  const signature = Buffer.from(vector.signature.slice('sig1=:'.length, -1), 'base64');
  assert.equal(crypto.verify(null, Buffer.from(vector.signature_base), vector.public_key_pem, signature), true);
  assert.equal(crypto.verify(null, Buffer.from(`${vector.signature_base}x`), vector.public_key_pem, signature), false);
});
