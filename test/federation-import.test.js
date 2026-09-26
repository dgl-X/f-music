import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { federationImportRetryDelay, federationReplicaPaths, federationSourceId } from '../src/federation-import.js';

test('federation import retry delay is deterministic and bounded', () => {
  assert.equal(federationImportRetryDelay(1), 10);
  assert.equal(federationImportRetryDelay(2), 20);
  assert.equal(federationImportRetryDelay(20), 2560);
});

test('federation replica path does not expose node id in storage', () => {
  const result = federationReplicaPaths('/srv/music', 'fm:private-node', 'track-id');
  assert.equal(result.temporaryPath.startsWith(path.join('/srv/music', 'federation', 'replicas')), true);
  assert.equal(result.temporaryPath.includes('private-node'), false);
  assert.equal(result.temporaryPath.endsWith('.track-id.part'), true);
  assert.equal(federationSourceId('node', 'track'), 'node\ntrack');
});
