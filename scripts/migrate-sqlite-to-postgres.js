import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { schemaSql } from '../src/db.js';

const sqlitePath = path.resolve(process.argv[2] ?? 'data/music.db');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new pg.Pool({ connectionString: databaseUrl });
const tables = ['users', 'tracks', 'track_sources', 'track_likes', 'playlists', 'playlist_tracks', 'play_history', 'playback_state', 'uploads', 'sessions'];

try {
  await pool.query(schemaSql);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of tables) {
      const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        const values = columns.map(column => row[column]);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(',');
        await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
      }
      console.log(`${table}: ${rows.length}`);
    }
    await client.query("SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT max(id) FROM users), 1), true)");
    await client.query("SELECT setval(pg_get_serial_sequence('sessions','id'), COALESCE((SELECT max(id) FROM sessions), 1), true)");
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} finally {
  sqlite.close();
  await pool.end();
}
