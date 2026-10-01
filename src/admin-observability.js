import fs from 'node:fs';
import path from 'node:path';
import { httpMetricSnapshot } from './http-observability.js';
import { operationMetricSnapshot } from './operation-metrics.js';

export function numericRecord(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key,item]) => [key, typeof item === 'string' && /^-?\d+(\.\d+)?$/.test(item) ? Number(item) : item]));
}

export function storageStats(directory) {
  let bytes=0,files=0;
  if(!fs.existsSync(directory))return {bytes,files};
  const pending=[directory];
  while(pending.length){const current=pending.pop();for(const entry of fs.readdirSync(current,{withFileTypes:true})){const item=path.join(current,entry.name);if(entry.isDirectory())pending.push(item);else if(entry.isFile()){files++;bytes+=fs.statSync(item).size;}}}
  return {bytes,files};
}

export function createAdminObservabilityService({ db, storageDir, processStartedAt, httpMetrics, federationStats = () => ({}), uptime = () => process.uptime(), memoryUsage = () => process.memoryUsage() }) {
  const storageRoot=path.resolve(storageDir);
  const storedFileExists=storageKey=>{if(!storageKey)return false;const file=path.resolve(storageRoot,storageKey);return file.startsWith(`${storageRoot}${path.sep}`)&&fs.existsSync(file)&&fs.statSync(file).isFile();};
  const queue=rows=>Object.fromEntries(rows.map(row=>[row.status,{count:Number(row.count),oldest_seconds:Math.round(Number(row.oldest_seconds))}]));

  async function stats() {
    const [library,people,activity,uploadJobs,transcodeJobs,variants,recentErrors,storedTracks,storedVariants]=await Promise.all([
      db.prepare(`SELECT count(*) AS tracks, count(DISTINCT artist) AS artists,
        count(DISTINCT NULLIF(album,'')) AS albums, count(*) FILTER (WHERE cover_key IS NOT NULL) AS with_cover,
        count(*) FILTER (WHERE sha256 IS NULL) AS without_hash, COALESCE(sum(size_bytes),0) AS original_bytes,
        COALESCE(sum(duration_seconds),0) AS duration_seconds FROM tracks`).get(),
      db.prepare(`SELECT count(*) AS users, count(*) FILTER (WHERE is_admin=1) AS admins,
        (SELECT count(*) FROM sessions WHERE expires_at>CURRENT_TIMESTAMP) AS active_sessions FROM users`).get(),
      db.prepare(`SELECT (SELECT count(*) FROM track_likes) AS likes, (SELECT count(*) FROM playlists) AS playlists,
        (SELECT COALESCE(sum(play_count),0) FROM play_history) AS plays`).get(),
      db.prepare('SELECT status, count(*) AS count FROM processing_jobs GROUP BY status').all(),
      db.prepare('SELECT status, count(*) AS count FROM track_files GROUP BY status').all(),
      db.prepare(`SELECT variant, status, count(*) AS files, COALESCE(sum(size_bytes),0) AS bytes
        FROM track_files GROUP BY variant,status ORDER BY variant,status`).all(),
      db.prepare(`SELECT kind, item, error, updated_at FROM (
        SELECT 'Загрузка' AS kind, uploads.filename AS item, COALESCE(processing_jobs.last_error,uploads.error) AS error,
          GREATEST(uploads.updated_at,processing_jobs.updated_at) AS updated_at
          FROM uploads LEFT JOIN processing_jobs ON processing_jobs.upload_id=uploads.id
          WHERE (uploads.status='failed' OR processing_jobs.status='failed')
            AND GREATEST(uploads.updated_at,processing_jobs.updated_at)>COALESCE(
              (SELECT NULLIF(value,'')::timestamptz FROM app_settings WHERE key='admin_recent_errors_cleared_at'),
              '-infinity'::timestamptz)
        UNION ALL
        SELECT 'AAC' AS kind, tracks.artist || ' — ' || tracks.title AS item, track_files.error,
          track_files.updated_at FROM track_files JOIN tracks ON tracks.id=track_files.track_id
          WHERE track_files.status='failed' AND track_files.updated_at>COALESCE(
            (SELECT NULLIF(value,'')::timestamptz FROM app_settings WHERE key='admin_recent_errors_cleared_at'),
            '-infinity'::timestamptz)
        ) errors ORDER BY updated_at DESC LIMIT 10`).all(),
      db.prepare('SELECT id, storage_key, cover_key FROM tracks').all(),
      db.prepare("SELECT track_id,variant,storage_key FROM track_files WHERE status='ready'").all(),
    ]);
    const directories=Object.fromEntries(['originals','covers','derived','uploads'].map(name=>[name,storageStats(path.join(storageRoot,name))]));
    const disk=fs.statfsSync(storageRoot);
    return {
      generated_at:new Date().toISOString(),library:numericRecord(library),users:numericRecord(people),activity:numericRecord(activity),
      queues:{uploads:Object.fromEntries(uploadJobs.map(item=>[item.status,Number(item.count)])),transcodes:Object.fromEntries(transcodeJobs.map(item=>[item.status,Number(item.count)]))},
      variants:variants.map(numericRecord),storage:directories,disk:{total_bytes:disk.blocks*disk.bsize,free_bytes:disk.bavail*disk.bsize},
      integrity:{missing_originals:storedTracks.filter(track=>!storedFileExists(track.storage_key)).map(track=>track.id),missing_covers:storedTracks.filter(track=>track.cover_key&&!storedFileExists(track.cover_key)).map(track=>track.id),missing_variants:storedVariants.filter(item=>!storedFileExists(item.storage_key)).map(item=>({track_id:item.track_id,variant:item.variant}))},recent_errors:recentErrors,
    };
  }

  async function metrics() {
    const [heartbeat,uploads,transcodes,recognition,loudness,replicas,summary,federation,operations]=await Promise.all([
      db.prepare(`SELECT started_at,last_seen_at,EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-last_seen_at)) AS age_seconds FROM service_heartbeats WHERE service='worker'`).get(),
      db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds FROM processing_jobs WHERE status IN ('queued','retry','processing','failed') GROUP BY status`).all(),
      db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds FROM track_files WHERE status IN ('queued','processing','failed') GROUP BY status`).all(),
      db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds FROM recognition_jobs WHERE status IN ('queued','retry','processing','failed') GROUP BY status`).all(),
      db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds FROM loudness_jobs WHERE status IN ('queued','retry','processing','failed') GROUP BY status`).all(),
      db.prepare(`SELECT status,count(*) AS count,COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-min(updated_at))),0) AS oldest_seconds FROM federation_remote_replicas WHERE status IN ('queued','retry','downloading','failed') GROUP BY status`).all(),
      db.prepare(`SELECT (SELECT count(*) FROM tracks) AS tracks,(SELECT count(*) FROM sessions WHERE expires_at>CURRENT_TIMESTAMP) AS active_sessions,(SELECT count(*) FROM diagnostic_reports WHERE status='new') AS new_reports,(SELECT count(*) FROM uploads WHERE status='failed' AND updated_at>CURRENT_TIMESTAMP-INTERVAL '24 hours') AS upload_errors_24h`).get(),
      db.prepare(`SELECT count(*) FILTER(WHERE revoked_at IS NULL AND status<>'revoked') peers_active,count(*) FILTER(WHERE revoked_at IS NOT NULL OR status='revoked') peers_revoked,count(*) FILTER(WHERE revoked_at IS NULL AND (sync_error IS NOT NULL OR last_synced_at IS NULL OR last_synced_at<CURRENT_TIMESTAMP-INTERVAL '10 minutes')) peers_offline,(SELECT count(*) FROM federation_remote_tracks) remote_tracks,(SELECT count(*) FROM federation_remote_likes) remote_likes,(SELECT count(*) FROM federation_playlist_tracks) remote_playlist_tracks,COALESCE(max(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-last_synced_at))) FILTER(WHERE revoked_at IS NULL),0) oldest_sync_seconds,count(*) FILTER(WHERE sync_error IS NOT NULL) sync_errors,count(*) FILTER(WHERE notify_error IS NOT NULL) notify_errors FROM federation_peers`).get(),
      db.prepare(`SELECT name,count,error_count,duration_ms_total,duration_ms_max,last_duration_ms,last_succeeded,last_finished_at FROM operation_metrics ORDER BY name`).all(),
    ]);
    const workerAge=heartbeat?Math.round(Number(heartbeat.age_seconds)):null;
    return {generated_at:new Date().toISOString(),status:workerAge!==null&&workerAge<=45?'ok':'degraded',api:{uptime_seconds:Math.floor(uptime()),started_at:processStartedAt.toISOString(),...httpMetricSnapshot(httpMetrics),memory_rss_bytes:memoryUsage().rss},worker:{status:workerAge!==null&&workerAge<=45?'ok':'stale',last_seen_at:heartbeat?.last_seen_at??null,age_seconds:workerAge},queues:{uploads:queue(uploads),transcodes:queue(transcodes),recognition:queue(recognition),loudness:queue(loudness),federation_replicas:queue(replicas)},operations:operationMetricSnapshot(operations),summary:numericRecord(summary),federation:{...Object.fromEntries(Object.entries(federation).map(([key,value])=>[key,Number(value||0)])),...federationStats()}};
  }

  async function clearRecentErrors() {
    const clearedAt=new Date().toISOString();
    await db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('admin_recent_errors_cleared_at',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(clearedAt);
    return {cleared_at:clearedAt};
  }

  return { stats,metrics,clearRecentErrors };
}
