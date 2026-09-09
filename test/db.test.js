import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaSql } from '../src/db.js';

test('PostgreSQL schema includes all persistent media entities', () => {
  for (const table of ['users', 'sessions', 'uploads', 'tracks', 'processing_jobs', 'recognition_jobs', 'track_sources', 'track_likes', 'playlists', 'playlist_tracks', 'play_history', 'playback_state', 'federation_nonces', 'federation_invitations', 'federation_peers', 'federation_export_collections', 'federation_export_collection_tracks', 'federation_peer_export_rules', 'federation_catalog_events', 'federation_remote_tracks', 'federation_remote_likes', 'federation_remote_replicas', 'federation_playlist_tracks']) {
    assert.match(schemaSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const column of ['sha256', 'cover_key', 'genre', 'lyrics', 'track_number', 'disc_number']) assert.match(schemaSql, new RegExp(`\\b${column}\\b`));
  assert.match(schemaSql, /tracks_sha256_unique/);
  assert.match(schemaSql, /ALTER TABLE uploads ADD COLUMN IF NOT EXISTS track_id/);
  assert.match(schemaSql, /ALTER TABLE uploads ADD COLUMN IF NOT EXISTS candidate_track_id/);
  assert.match(schemaSql, /processing_jobs_queue/);
  assert.match(schemaSql, /recognition_jobs_queue/);
});
