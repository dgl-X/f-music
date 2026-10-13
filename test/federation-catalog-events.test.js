import assert from 'node:assert/strict';
import test from 'node:test';
import { createFederationCatalogEvents } from '../src/federation-catalog-events.js';

test('visibility changes append an upsert without exposing storage details', async () => {
  const inserted = [];
  const track = { id:'track', title:'Song', artist:'Artist', album:'Album', cover_key:'covers/private.jpg', created_at:'2026-01-01' };
  const tx = { prepare(sql) { return sql.startsWith('SELECT') ? { async all() { return [track]; } } : { async run(...args) { inserted.push(args); } }; } };
  const events = createFederationCatalogEvents({ db:{}, federationTrackVisible(_track, settings) { return settings.enabled; } });
  await events.appendVisibilityEvents(tx, { enabled:false }, { enabled:true });
  assert.equal(inserted[0][0], 'track.upsert.v1');
  const payload = JSON.parse(inserted[0][2]);
  assert.equal(payload.cover_available, true);
  assert.equal('cover_key' in payload, false);
});

test('track refresh deduplicates ids and skips an empty set', async () => {
  const selections = [], inserted = [];
  const tx = { prepare(sql) { return sql.startsWith('SELECT') ? { async all(ids) { selections.push(ids); return [{ id:'a', title:'A' }]; } } : { async run(...args) { inserted.push(args); } }; } };
  const events = createFederationCatalogEvents({ db:{}, federationTrackVisible() { return true; } });
  await events.appendTrackRefreshEvents(tx, []);
  await events.appendTrackRefreshEvents(tx, ['a', 'a']);
  assert.deepEqual(selections, [['a']]);
  assert.equal(inserted.length, 1);
});
