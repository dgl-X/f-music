import pg from 'pg';

const { Pool } = pg;

export const schemaSql = `
CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase ON users (lower(username));
CREATE TABLE IF NOT EXISTS sessions (id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_name TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS sessions_user_activity ON sessions(user_id, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, filename TEXT NOT NULL, mime_type TEXT NOT NULL, total_bytes BIGINT NOT NULL, received_bytes BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'uploading', error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT 'Неизвестный исполнитель', album TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes BIGINT NOT NULL, duration_seconds DOUBLE PRECISION, storage_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, sha256 TEXT, cover_key TEXT, cover_checked INTEGER NOT NULL DEFAULT 0, genre TEXT NOT NULL DEFAULT '', lyrics TEXT, year INTEGER, track_number INTEGER, disc_number INTEGER);
CREATE TABLE IF NOT EXISTS artists (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE artists ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
ALTER TABLE artists ADD COLUMN IF NOT EXISTS image_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS artists_name_nocase ON artists(lower(name));
CREATE TABLE IF NOT EXISTS track_artists (track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, artist_id BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'primary', position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(track_id,artist_id));
CREATE INDEX IF NOT EXISTS track_artists_artist ON track_artists(artist_id,track_id);
CREATE OR REPLACE FUNCTION sync_track_artist_credits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credit_name TEXT; credit_position BIGINT; linked_artist BIGINT; primary_count BIGINT;
BEGIN
  DELETE FROM track_artists WHERE track_id=NEW.id;
  primary_count := CASE WHEN NEW.artist ~* '\\s+(feat(?:uring)?\\.?|ft\\.?)\\s+'
    THEN cardinality(regexp_split_to_array(regexp_replace(NEW.artist,'\\s+(feat(?:uring)?\\.?|ft\\.?).*$','','i'),'\\s*,\\s*')) ELSE 999999 END;
  FOR credit_name,credit_position IN
    SELECT trim(part),ordinality FROM regexp_split_to_table(
      CASE WHEN NEW.artist ~* '\\s+(feat(?:uring)?\\.?|ft\\.?)\\s+'
        THEN regexp_replace(NEW.artist,'\\s+(feat(?:uring)?\\.?|ft\\.?)\\s+',',','gi') ELSE NEW.artist END,
      '\\s*,\\s*') WITH ORDINALITY AS credits(part,ordinality)
  LOOP
    IF credit_name<>'' THEN
      INSERT INTO artists(name) VALUES(credit_name) ON CONFLICT((lower(name))) DO UPDATE SET name=artists.name RETURNING id INTO linked_artist;
      INSERT INTO track_artists(track_id,artist_id,role,position) VALUES(NEW.id,linked_artist,CASE WHEN credit_position<=primary_count THEN 'primary' ELSE 'featured' END,credit_position-1)
        ON CONFLICT(track_id,artist_id) DO UPDATE SET position=LEAST(track_artists.position,excluded.position);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tracks_sync_artist_credits ON tracks;
CREATE TRIGGER tracks_sync_artist_credits AFTER INSERT OR UPDATE OF artist ON tracks FOR EACH ROW EXECUTE FUNCTION sync_track_artist_credits();
UPDATE tracks SET artist=artist WHERE NOT EXISTS(SELECT 1 FROM track_artists WHERE track_artists.track_id=tracks.id);
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL;
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS candidate_track_id TEXT;
CREATE TABLE IF NOT EXISTS processing_jobs (id BIGSERIAL PRIMARY KEY, upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS track_sources (source TEXT NOT NULL, source_id TEXT NOT NULL, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source, source_id));
CREATE TABLE IF NOT EXISTS track_likes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, track_id));
CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS playlist_tracks (playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (playlist_id, track_id));
CREATE TABLE IF NOT EXISTS play_history (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, play_count INTEGER NOT NULL DEFAULT 0, last_played_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, track_id));
CREATE TABLE IF NOT EXISTS playback_state (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL, position_seconds DOUBLE PRECISION NOT NULL DEFAULT 0, queue_json TEXT NOT NULL DEFAULT '[]', shuffle INTEGER NOT NULL DEFAULT 0, repeat_mode TEXT NOT NULL DEFAULT 'off', updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE playback_state ADD COLUMN IF NOT EXISTS queue_source TEXT NOT NULL DEFAULT 'Очередь';
ALTER TABLE playback_state ADD COLUMN IF NOT EXISTS remote_track_ref TEXT;
CREATE TABLE IF NOT EXISTS track_files (id BIGSERIAL PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, variant TEXT NOT NULL, mime_type TEXT NOT NULL, codec TEXT NOT NULL, bitrate INTEGER, size_bytes BIGINT, storage_key TEXT, status TEXT NOT NULL DEFAULT 'queued', error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(track_id,variant));
ALTER TABLE track_files ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS recognition_jobs (id BIGSERIAL PRIMARY KEY, track_id TEXT NOT NULL UNIQUE REFERENCES tracks(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, confidence DOUBLE PRECISION, suggested_title TEXT, suggested_artist TEXT, candidates_json TEXT NOT NULL DEFAULT '[]', error TEXT, available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS loudness_jobs (id BIGSERIAL PRIMARY KEY, track_id TEXT NOT NULL UNIQUE REFERENCES tracks(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, integrated_lufs DOUBLE PRECISION, true_peak_db DOUBLE PRECISION, loudness_range_lu DOUBLE PRECISION, recommended_gain_db DOUBLE PRECISION, error TEXT, available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS diagnostic_reports (id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, description TEXT NOT NULL, app_version TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', android_version TEXT NOT NULL DEFAULT '', details_json TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE diagnostic_reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE diagnostic_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS tracks_created_at ON tracks(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS tracks_sha256_unique ON tracks(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS processing_jobs_queue ON processing_jobs(status, available_at, id);
CREATE INDEX IF NOT EXISTS track_files_status ON track_files(status, updated_at);
CREATE INDEX IF NOT EXISTS recognition_jobs_queue ON recognition_jobs(status, available_at, id);
CREATE INDEX IF NOT EXISTS loudness_jobs_queue ON loudness_jobs(status, available_at, id);
CREATE INDEX IF NOT EXISTS diagnostic_reports_created_at ON diagnostic_reports(created_at DESC);
CREATE TABLE IF NOT EXISTS service_heartbeats (service TEXT PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, details_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS federation_nonces (node_id TEXT NOT NULL, nonce TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(node_id,nonce));
CREATE INDEX IF NOT EXISTS federation_nonces_expires ON federation_nonces(expires_at);
CREATE TABLE IF NOT EXISTS federation_invitations (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, endpoint TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS federation_invitations_expires ON federation_invitations(expires_at);
CREATE TABLE IF NOT EXISTS federation_peers (node_id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', public_key TEXT NOT NULL, endpoint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'compatible', protocol_major INTEGER NOT NULL DEFAULT 1, protocol_minor INTEGER NOT NULL DEFAULT 0, capabilities_json TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ);
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS catalog_cursor TEXT;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS next_sync_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS sync_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS sync_error TEXT;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS remote_latest_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS last_notified_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS next_notify_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS notify_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS notify_error TEXT;
CREATE INDEX IF NOT EXISTS federation_peers_status ON federation_peers(status,updated_at DESC);
CREATE TABLE IF NOT EXISTS federation_catalog_events (revision BIGSERIAL PRIMARY KEY, event_type TEXT NOT NULL, object_id TEXT NOT NULL, payload_json JSONB NOT NULL DEFAULT '{}', occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS federation_catalog_events_object ON federation_catalog_events(object_id,revision DESC);
CREATE OR REPLACE FUNCTION record_federation_track_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    INSERT INTO federation_catalog_events(event_type,object_id,payload_json) VALUES('track.delete.v1',OLD.id,
      jsonb_build_object('album',OLD.album,'artist',OLD.artist));
    RETURN OLD;
  END IF;
  INSERT INTO federation_catalog_events(event_type,object_id,payload_json) VALUES('track.upsert.v1',NEW.id,
    jsonb_build_object('title',NEW.title,'artist',NEW.artist,'album',NEW.album,'genre',NEW.genre,'year',NEW.year,
      'duration_seconds',NEW.duration_seconds,'track_number',NEW.track_number,'disc_number',NEW.disc_number,
      'cover_available',NEW.cover_key IS NOT NULL,'created_at',NEW.created_at));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tracks_federation_catalog_event ON tracks;
CREATE TRIGGER tracks_federation_catalog_event AFTER INSERT OR UPDATE OF title,artist,album,genre,year,duration_seconds,track_number,disc_number,cover_key OR DELETE ON tracks FOR EACH ROW EXECUTE FUNCTION record_federation_track_event();
CREATE TABLE IF NOT EXISTS federation_remote_tracks (origin_node_id TEXT NOT NULL REFERENCES federation_peers(node_id) ON DELETE CASCADE, object_id TEXT NOT NULL, revision BIGINT NOT NULL, title TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '', genre TEXT NOT NULL DEFAULT '', year INTEGER, duration_seconds DOUBLE PRECISION, track_number INTEGER, disc_number INTEGER, cover_available INTEGER NOT NULL DEFAULT 0, origin_created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(origin_node_id,object_id));
CREATE INDEX IF NOT EXISTS federation_remote_tracks_search ON federation_remote_tracks(origin_node_id,artist,title);
CREATE TABLE IF NOT EXISTS federation_remote_likes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, origin_node_id TEXT NOT NULL, object_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,origin_node_id,object_id), FOREIGN KEY(origin_node_id,object_id) REFERENCES federation_remote_tracks(origin_node_id,object_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS federation_remote_replicas (
  origin_node_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  storage_key TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  received_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(origin_node_id,object_id),
  FOREIGN KEY(origin_node_id,object_id) REFERENCES federation_remote_tracks(origin_node_id,object_id) ON DELETE CASCADE
);
ALTER TABLE federation_remote_replicas ADD COLUMN IF NOT EXISTS local_track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS federation_remote_replicas_queue ON federation_remote_replicas(status,available_at,updated_at);
CREATE TABLE IF NOT EXISTS federation_playlist_tracks (playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, origin_node_id TEXT NOT NULL, object_id TEXT NOT NULL, position INTEGER NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(playlist_id,origin_node_id,object_id), FOREIGN KEY(origin_node_id,object_id) REFERENCES federation_remote_tracks(origin_node_id,object_id) ON DELETE CASCADE);
`;

function compile(sql, parameters) {
  let index = 0;
  const values = [];
  let text = sql.replace(/COLLATE NOCASE/gi, '');
  if (parameters.length === 1 && parameters[0] && parameters[0].constructor === Object) {
    const named = parameters[0];
    const positions = new Map();
    text = text.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      if (!positions.has(name)) { values.push(named[name]); positions.set(name, values.length); }
      return `$${positions.get(name)}`;
    });
  } else text = text.replace(/\?/g, () => { values.push(parameters[index++]); return `$${values.length}`; });
  text = text.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
  return { text, values };
}

function adapter(client) {
  return { prepare(sql) { return {
    async get(...parameters) { return (await client.query(compile(sql, parameters))).rows[0]; },
    async all(...parameters) { return (await client.query(compile(sql, parameters))).rows; },
    async run(...parameters) { const result = await client.query(compile(sql, parameters)); return { changes: result.rowCount, rows: result.rows }; },
  }; } };
}

export async function openDatabase(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  // API и worker могут стартовать одновременно на новой ноде. PostgreSQL не
  // гарантирует отсутствие гонки между двумя параллельными CREATE TABLE IF
  // NOT EXISTS, поэтому сериализуем применение схемы на уровне БД.
  const migrationClient = await pool.connect();
  try {
    await migrationClient.query('SELECT pg_advisory_lock($1)', [1179471693]);
    await migrationClient.query(schemaSql);
  } finally {
    await migrationClient.query('SELECT pg_advisory_unlock($1)', [1179471693]).catch(() => {});
    migrationClient.release();
  }
  return {
    ...adapter(pool),
    async transaction(callback) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await callback(adapter(client)); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}
