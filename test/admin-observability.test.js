import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAdminObservabilityService, numericRecord, storageStats } from '../src/admin-observability.js';

test('admin storage helpers count nested files and normalize database numbers', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-admin-'));
  try {
    fs.mkdirSync(path.join(root,'nested'));
    fs.writeFileSync(path.join(root,'one.bin'),'1234');
    fs.writeFileSync(path.join(root,'nested','two.bin'),'12');
    assert.deepEqual(storageStats(root),{bytes:6,files:2});
    assert.deepEqual(numericRecord({count:'12',ratio:'1.5',label:'music'}),{count:12,ratio:1.5,label:'music'});
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('admin stats preserve response shape and report missing media', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-stats-'));
  try {
    for(const name of ['originals','covers','derived','uploads'])fs.mkdirSync(path.join(root,name));
    fs.writeFileSync(path.join(root,'originals','ready.mp3'),'audio');
    const db={prepare(sql){return {
      async get(){
        if(sql.includes('count(DISTINCT artist)'))return {tracks:'2',artists:'1',albums:'1',with_cover:'1',without_hash:'0',original_bytes:'5',duration_seconds:'20'};
        if(sql.includes('count(*) AS users'))return {users:'2',admins:'1',active_sessions:'2'};
        if(sql.includes('FROM track_likes'))return {likes:'3',playlists:'1',plays:'9'};
        throw new Error(`Unexpected get: ${sql}`);
      },
      async all(){
        if(sql.includes('FROM processing_jobs GROUP'))return [{status:'queued',count:'2'}];
        if(sql.includes('FROM track_files GROUP BY status'))return [{status:'ready',count:'1'}];
        if(sql.includes('SELECT variant, status'))return [{variant:'aac_192',status:'ready',files:'1',bytes:'4'}];
        if(sql.includes('SELECT kind, item'))return [];
        if(sql.includes('SELECT id, storage_key'))return [{id:'ready',storage_key:'originals/ready.mp3',cover_key:null},{id:'missing',storage_key:'originals/missing.mp3',cover_key:'covers/missing.jpg'}];
        if(sql.includes('SELECT track_id,variant'))return [{track_id:'missing',variant:'aac_192',storage_key:'derived/missing.m4a'}];
        throw new Error(`Unexpected all: ${sql}`);
      },
    };}};
    const service=createAdminObservabilityService({db,storageDir:root,processStartedAt:new Date(0),httpMetrics:{},uptime:()=>1,memoryUsage:()=>({rss:1})});
    const result=await service.stats();
    assert.equal(result.library.tracks,2);
    assert.equal(result.queues.uploads.queued,2);
    assert.deepEqual(result.integrity.missing_originals,['missing']);
    assert.deepEqual(result.integrity.missing_covers,['missing']);
    assert.deepEqual(result.integrity.missing_variants,[{track_id:'missing',variant:'aac_192'}]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('admin metrics combine worker, queues, HTTP and federation snapshots', async () => {
  const db={prepare(sql){return {
    async get(){
      if(sql.includes("service='worker'"))return {last_seen_at:'now',age_seconds:'12'};
      if(sql.includes("diagnostic_reports"))return {tracks:'10',active_sessions:'2',new_reports:'1',upload_errors_24h:'0'};
      if(sql.includes('peers_active'))return {peers_active:'1',peers_revoked:'0',peers_offline:'0',remote_tracks:'5',remote_likes:'2',remote_playlist_tracks:'1',oldest_sync_seconds:'3',sync_errors:'0',notify_errors:'0'};
      throw new Error(`Unexpected get: ${sql}`);
    },
    async all(){
      if(sql.includes('FROM processing_jobs'))return [{status:'queued',count:'2',oldest_seconds:'8.6'}];
      if(sql.includes('FROM track_files'))return [];
      if(sql.includes('FROM recognition_jobs'))return [];
      if(sql.includes('FROM loudness_jobs'))return [];
      if(sql.includes('FROM federation_remote_replicas'))return [];
      if(sql.includes('FROM operation_metrics'))return [];
      throw new Error(`Unexpected all: ${sql}`);
    },
  };}};
  const service=createAdminObservabilityService({db,storageDir:'/unused',processStartedAt:new Date('2026-01-01T00:00:00Z'),httpMetrics:{requests:7,errors5xx:1,duration_ms_total:14,duration_ms_max:4,slow_requests:0},federationStats:()=>({incoming_streams:2}),uptime:()=>20.9,memoryUsage:()=>({rss:123})});
  const result=await service.metrics();
  assert.equal(result.status,'ok');
  assert.deepEqual(result.queues.uploads.queued,{count:2,oldest_seconds:9});
  assert.equal(result.api.uptime_seconds,20);
  assert.equal(result.api.errors_5xx,1);
  assert.equal(result.federation.remote_tracks,5);
  assert.equal(result.federation.incoming_streams,2);
});
