import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {loadLegacySqlite} from '../../scripts/sqlite-migration-loader.mjs';

const url=process.env.LEGACY_MIGRATION_TEST_URL;
assert.ok(url,'LEGACY_MIGRATION_TEST_URL must name a separate empty test database');
const db=new pg.Client({connectionString:url});
let directory;
try{
  await db.connect();
  assert.match((await db.query('SELECT current_database() AS name')).rows[0].name,/^fm_legacy_test_[a-z0-9_]+$/);
  assert.equal((await db.query("SELECT to_regclass('public.users') AS value")).rows[0].value,null,'Refusing a populated application database');
  const Database=loadLegacySqlite();
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'fm-legacy-migration-'));
  const source=path.join(directory,'old.sqlite'),sqlite=new Database(source);
  try{sqlite.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,is_admin INTEGER);
    INSERT INTO users VALUES(1,'legacy-fixture','Legacy fixture','synthetic-not-a-login',0);
    CREATE TABLE tracks(id TEXT,owner_id INTEGER,title TEXT,filename TEXT,mime_type TEXT,size_bytes INTEGER,storage_key TEXT);
    INSERT INTO tracks VALUES('55555555-5555-4555-8555-555555555555',1,'Legacy track','fixture.mp3','audio/mpeg',1,'originals/fixture.mp3');
    CREATE TABLE track_likes(user_id INTEGER,track_id TEXT);
    INSERT INTO track_likes VALUES(1,'55555555-5555-4555-8555-555555555555');
    CREATE TABLE playlists(id TEXT,owner_id INTEGER,title TEXT);
    INSERT INTO playlists VALUES('legacy-list',1,'Legacy playlist');
    CREATE TABLE playlist_tracks(playlist_id TEXT,track_id TEXT,position INTEGER);
    INSERT INTO playlist_tracks VALUES('legacy-list','55555555-5555-4555-8555-555555555555',0);
    CREATE TABLE play_history(user_id INTEGER,track_id TEXT,play_count INTEGER);
    INSERT INTO play_history VALUES(1,'55555555-5555-4555-8555-555555555555',7);
    CREATE TABLE track_sources(id INTEGER);CREATE TABLE uploads(id INTEGER);
    CREATE TABLE sessions(id INTEGER);CREATE TABLE playback_state(id INTEGER);
  `);}finally{sqlite.close();}
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),before=hash();
  for(let i=0;i<2;i++){
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../scripts/migrate-sqlite-to-postgres.js',import.meta.url)),source],{encoding:'utf8',env:{...process.env,DATABASE_URL:url},timeout:30000});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  }
  for(const table of ['users','tracks','track_likes','playlists','playlist_tracks','play_history'])assert.equal(Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count),1,table);
  assert.equal((await db.query('SELECT play_count FROM play_history')).rows[0].play_count,7);
  assert.equal(hash(),before);
  console.log('Optional legacy tool: SQLite to PostgreSQL, likes/playlist/history, repeat import and unchanged source OK');
}finally{await db.end();if(directory)fs.rmSync(directory,{recursive:true,force:true});}
