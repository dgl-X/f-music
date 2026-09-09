#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { encodeRemoteReference } from '../src/federation-catalog.js';
import { hashPassword, randomToken, tokenHash } from '../src/security.js';

function readEnv(file) {
  const env = { ...process.env };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
}

const config = loadConfig(readEnv(process.argv[2] || '/opt/family-music/.env'));
const db = await openDatabase(config.databaseUrl);
const username = `reconnect-smoke-${crypto.randomUUID()}`;
const sessionToken = randomToken();
const apiBase = `http://127.0.0.1:${config.port}`;
const virtualHost = 'reconnect-smoke.invalid';
const commonHeaders = { host:virtualHost,'x-forwarded-host':virtualHost,'x-forwarded-proto':'https',cookie:`music_session=${sessionToken}` };
let userId, target, reference, originalEndpoint;

async function api(route, options = {}) {
  return fetch(`${apiBase}${route}`,{...options,headers:{...commonHeaders,...(options.headers||{})}});
}

async function waitForReplica(expected, attempts = 60) {
  for (let attempt=0;attempt<attempts;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,500));
    const replica=await db.prepare('SELECT * FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(target.origin_node_id,target.object_id);
    if(replica&&expected.includes(replica.status))return replica;
  }
  throw new Error(`Реплика не перешла в состояние ${expected.join('/')}`);
}

try {
  userId=(await db.prepare('INSERT INTO users(username,display_name,password_hash,is_admin) VALUES(?,?,?,0) RETURNING id').run(username,'Reconnect smoke',hashPassword(randomToken()))).rows[0].id;
  await db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at,device_name,client_name) VALUES(?,?,CURRENT_TIMESTAMP+INTERVAL '1 hour','smoke','smoke')").run(userId,tokenHash(sessionToken));
  target=await db.prepare(`SELECT remote.origin_node_id,remote.object_id,peer.endpoint FROM federation_remote_tracks remote
    JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
    WHERE peer.revoked_at IS NULL AND peer.status<>'revoked'
      AND NOT EXISTS(SELECT 1 FROM track_sources source WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\n'||remote.object_id)
    ORDER BY remote.duration_seconds ASC NULLS LAST LIMIT 1`).get();
  if(!target)throw new Error('Нет свободного удалённого трека для reconnect-теста');
  reference=encodeRemoteReference(target.origin_node_id,target.object_id);originalEndpoint=target.endpoint;

  await db.prepare("UPDATE federation_peers SET endpoint='https://192.168.0.254',next_sync_at=CURRENT_TIMESTAMP WHERE node_id=?").run(target.origin_node_id);
  const offline=await api(`/api/v1/federation/stream?ref=${encodeURIComponent(reference)}&quality=original`,{headers:{range:'bytes=0-1023'}});
  await offline.arrayBuffer();
  if(offline.status!==502)throw new Error(`При offline ожидался HTTP 502, получен ${offline.status}`);
  const liked=await api(`/api/v1/federation/like?ref=${encodeURIComponent(reference)}`,{method:'PUT',headers:{origin:`https://${virtualHost}`}});
  if(liked.status!==200)throw new Error(`Не удалось поставить тестовый лайк: HTTP ${liked.status}`);
  const retry=await waitForReplica(['retry']);
  if(!retry.error)throw new Error('Retry не содержит причины сетевого сбоя');

  await db.prepare('UPDATE federation_peers SET endpoint=?,next_sync_at=CURRENT_TIMESTAMP,sync_error=NULL WHERE node_id=?').run(originalEndpoint,target.origin_node_id);
  const online=await api(`/api/v1/federation/stream?ref=${encodeURIComponent(reference)}&quality=original`,{headers:{range:'bytes=0-1023'}});
  const onlineBytes=(await online.arrayBuffer()).byteLength;
  if(online.status!==206||onlineBytes!==1024)throw new Error(`После reconnect Range: HTTP ${online.status}, ${onlineBytes} байт`);
  const retryResponse=await api(`/api/v1/federation/replica?ref=${encodeURIComponent(reference)}`,{method:'POST',headers:{origin:`https://${virtualHost}`}});
  if(retryResponse.status!==202)throw new Error(`Не удалось повторить импорт: HTTP ${retryResponse.status}`);
  const imported=await waitForReplica(['imported'],240);
  if(!imported.local_track_id)throw new Error('Импорт завершился без локального track_id');
  const local=await db.prepare("SELECT tracks.id FROM tracks JOIN track_sources source ON source.track_id=tracks.id WHERE source.source='federation' AND source.source_id=?").get(`${target.origin_node_id}\n${target.object_id}`);
  if(local?.id!==imported.local_track_id)throw new Error('Импорт не стал независимым локальным треком');
  console.log(JSON.stringify({ok:true,offline_status:502,retry:true,reconnect_range_status:206,reconnect_range_bytes:onlineBytes,imported:true,local_track_id:imported.local_track_id}));
} finally {
  if(target&&originalEndpoint)await db.prepare('UPDATE federation_peers SET endpoint=?,next_sync_at=CURRENT_TIMESTAMP,sync_error=NULL WHERE node_id=?').run(originalEndpoint,target.origin_node_id).catch(()=>{});
  if(target){
    const replica=await db.prepare('SELECT storage_key,local_track_id FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(target.origin_node_id,target.object_id).catch(()=>null);
    if(replica?.storage_key){const file=path.resolve(config.storageDir,replica.storage_key);if(file.startsWith(`${path.resolve(config.storageDir)}${path.sep}`))fs.rmSync(file,{force:true});}
    if(replica?.local_track_id){const track=await db.prepare('SELECT storage_key,cover_key FROM tracks WHERE id=?').get(replica.local_track_id);for(const key of [track?.storage_key,track?.cover_key])if(key){const file=path.resolve(config.storageDir,key);if(file.startsWith(`${path.resolve(config.storageDir)}${path.sep}`))fs.rmSync(file,{force:true});}await db.prepare('DELETE FROM tracks WHERE id=?').run(replica.local_track_id);}
    await db.prepare('DELETE FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').run(target.origin_node_id,target.object_id).catch(()=>{});
  }
  if(userId)await db.prepare('DELETE FROM users WHERE id=?').run(userId).catch(()=>{});
  await db.close();
}
