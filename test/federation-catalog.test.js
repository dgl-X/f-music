import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogEvent, decodeCatalogCursor, decodeRemoteReference, encodeCatalogCursor, encodeRemoteReference, federationCatalogRow, federationTrackVisible } from '../src/federation-catalog.js';

test('catalog cursor is opaque and round-trips revisions', () => {
  assert.equal(decodeCatalogCursor(encodeCatalogCursor(0)), 0);
  assert.equal(decodeCatalogCursor(encodeCatalogCursor(987654)), 987654);
  assert.throws(() => decodeCatalogCursor('987654'), /cursor/);
  assert.throws(() => decodeCatalogCursor('fm-cursor-v1:bm90LWEtbnVtYmVy'), /cursor/);
});

test('catalog events expose metadata without local storage details', () => {
  const event = catalogEvent({ revision: '4', event_type: 'track.upsert.v1', object_id: 'track-1', occurred_at: '2026-09-07T00:00:00Z', payload_json: { title: 'Song' } }, 'fm:test-node-1234567890');
  assert.equal(event.revision, 4);
  assert.deepEqual(event.payload, { title: 'Song' });
  assert.equal('storage_key' in event.payload, false);
});

test('remote references safely bind origin and object id',()=>{
  const ref=encodeRemoteReference('fm:test-node-1234567890','track/one');
  assert.deepEqual(decodeRemoteReference(ref),{nodeId:'fm:test-node-1234567890',objectId:'track/one'});
  assert.throws(()=>decodeRemoteReference('broken'));
});

test('album export policy publishes only selected albums', () => {
  const settings = { export_policy: 'albums', selected_albums: ['Published'] };
  assert.equal(federationTrackVisible({ album: 'Published' }, settings), true);
  assert.equal(federationTrackVisible({ album: 'Private' }, settings), false);
  const visible = federationCatalogRow({ event_type:'track.upsert.v1', current_album:'Published', payload_json:{ title:'Song', policy_event:true } }, settings);
  assert.equal(visible.event_type, 'track.upsert.v1');
  assert.deepEqual(visible.payload_json, { title:'Song' });
  const hidden = federationCatalogRow({ event_type:'track.upsert.v1', current_album:'Private', payload_json:{ title:'Secret' } }, settings);
  assert.equal(hidden.event_type, 'track.delete.v1');
  assert.deepEqual(hidden.payload_json, {});
});

test('disabled export turns stale upserts into tombstones', () => {
  const row = federationCatalogRow({ event_type:'track.upsert.v1', current_album:'Anything', payload_json:{ title:'Song' } }, { export_policy:'none', selected_albums:[] });
  assert.equal(row.event_type, 'track.delete.v1');
  assert.deepEqual(row.payload_json, {});
});

test('collection export publishes only explicit track ids', () => {
  const settings={export_policy:'collections',selected_albums:[],selected_track_ids:['track-public']};
  assert.equal(federationTrackVisible({id:'track-public',album:'Private'},settings),true);
  assert.equal(federationTrackVisible({id:'track-hidden',album:'Published'},settings),false);
  const visible=federationCatalogRow({event_type:'track.upsert.v1',object_id:'track-public',current_album:'Private',payload_json:{title:'Shared'}},settings);
  const hidden=federationCatalogRow({event_type:'track.upsert.v1',object_id:'track-hidden',current_album:'Published',payload_json:{title:'Hidden'}},settings);
  assert.equal(visible.event_type,'track.upsert.v1');
  assert.equal(hidden.event_type,'track.delete.v1');
});
