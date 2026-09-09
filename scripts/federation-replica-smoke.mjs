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
const username = `replica-smoke-${crypto.randomUUID()}`;
const sessionToken = randomToken();
let userId, target, reference;
const apiBase = `http://127.0.0.1:${config.port}`;
const virtualHost = 'replica-smoke.invalid';
const commonHeaders = { host: virtualHost, 'x-forwarded-host': virtualHost, 'x-forwarded-proto': 'https', cookie: `music_session=${sessionToken}` };

async function api(route, options = {}) {
  return fetch(`${apiBase}${route}`, { ...options, headers: { ...commonHeaders, ...(options.headers || {}) } });
}

try {
  const created = await db.prepare('INSERT INTO users(username,display_name,password_hash,is_admin) VALUES(?,?,?,0) RETURNING id').run(username,'Replica smoke',hashPassword(randomToken()));
  userId = created.rows[0].id;
  await db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at,device_name,client_name) VALUES(?,?,CURRENT_TIMESTAMP+INTERVAL '1 hour','smoke','smoke')")
    .run(userId,tokenHash(sessionToken));
  target = await db.prepare(`SELECT remote.origin_node_id,remote.object_id FROM federation_remote_tracks remote
    JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
    WHERE peer.revoked_at IS NULL AND peer.status<>'revoked'
      AND NOT EXISTS(SELECT 1 FROM federation_remote_replicas replica WHERE replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id)
    ORDER BY remote.cover_available DESC,remote.duration_seconds ASC NULLS LAST LIMIT 1`).get();
  if (!target) throw new Error('Нет свободного удалённого трека для теста');
  reference = encodeRemoteReference(target.origin_node_id,target.object_id);
  const route = `/api/v1/federation/like?ref=${encodeURIComponent(reference)}`;
  const liked = await api(route,{method:'PUT',headers:{origin:`https://${virtualHost}`}});
  if (liked.status !== 200) throw new Error(`Не удалось поставить тестовый лайк: HTTP ${liked.status}`);

  let state;
  for (let attempt=0;attempt<60;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,500));
    const response=await api(`/api/v1/federation/replica?ref=${encodeURIComponent(reference)}`);
    state=response.status===200?await response.json():null;
    if(state?.status==='imported')break;
  }
  if(state?.status!=='imported'||!state.local_track_id)throw new Error(`Импорт не готов: ${state?.status||'unknown'} ${state?.error||''}`);
  const importedTrack=await db.prepare('SELECT cover_key FROM tracks WHERE id=?').get(state.local_track_id);
  const sourceTrack=await db.prepare('SELECT cover_available FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(target.origin_node_id,target.object_id);
  if(sourceTrack?.cover_available&&!importedTrack?.cover_key)throw new Error('Обложка удалённого трека не импортирована');
  const cardResponse=await api(`/api/v1/federation/track?ref=${encodeURIComponent(reference)}`);
  const card=await cardResponse.json();
  if(cardResponse.status!==200||card.replica_status!=='imported'||card.local_track_id!==state.local_track_id||card.liked!==true)throw new Error('Карточка не увидела локальный импорт');
  const likedListResponse=await api('/api/v1/favorites?limit=50');
  const likedList=await likedListResponse.json();
  if(likedListResponse.status!==200||!likedList.items?.some(item=>item.id===state.local_track_id&&!item.remote))throw new Error('Общее «Мне нравится» не увидело локальный импорт');
  const commonResponse=await api('/api/v1/library?scope=all&limit=10000');
  const common=await commonResponse.json();
  if(commonResponse.status!==200||!common.items?.some(item=>item.id===state.local_track_id&&!item.remote))throw new Error('Общая библиотека не увидела локальный импорт');
  if(common.items.some(item=>item.remote&&item.remote_ref===reference))throw new Error('Общая библиотека продублировала импортированный трек');
  const localResponse=await api('/api/v1/library?scope=local&limit=10000');
  const local=await localResponse.json();
  if(localResponse.status!==200||!local.items?.some(item=>item.id===state.local_track_id&&!item.remote)||local.items.some(item=>item.remote))throw new Error('Локальный фильтр библиотеки работает неверно');
  const remoteResponse=await api('/api/v1/library?scope=remote&limit=10000');
  const remote=await remoteResponse.json();
  if(remoteResponse.status!==200||!remote.items?.some(item=>item.remote&&item.remote_ref===reference)||remote.items.some(item=>!item.remote))throw new Error('Федеративный фильтр библиотеки работает неверно');

  const streamed=await fetch(`http://127.0.0.1/api/v1/tracks/${state.local_track_id}/stream?quality=original`,{headers:{host:virtualHost,cookie:`music_session=${sessionToken}`,range:'bytes=0-1023'}});
  const bytes=(await streamed.arrayBuffer()).byteLength;
  if(streamed.status!==206||bytes!==1024)throw new Error(`Локальный stream: HTTP ${streamed.status}, ${bytes} байт`);
  const pending=await db.prepare('SELECT 1 FROM federation_remote_likes WHERE user_id=? AND origin_node_id=? AND object_id=?').get(userId,target.origin_node_id,target.object_id);
  if(pending)throw new Error('После импорта осталась федеративная зависимость лайка');
  console.log(JSON.stringify({ok:true,status:'imported',local_track_id:state.local_track_id,bytes:Number(state.size_bytes),range_bytes:bytes,remote_like_removed:true,library_scopes:true,cover_imported:Boolean(importedTrack?.cover_key)}));
} finally {
  if(target){
    const replica=await db.prepare('SELECT storage_key,local_track_id FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(target.origin_node_id,target.object_id);
    if(replica?.storage_key){const file=path.resolve(config.storageDir,replica.storage_key);if(file.startsWith(`${path.resolve(config.storageDir)}${path.sep}`))fs.rmSync(file,{force:true});}
    if(replica?.local_track_id){const track=await db.prepare('SELECT storage_key,cover_key FROM tracks WHERE id=?').get(replica.local_track_id);for(const key of [track?.storage_key,track?.cover_key])if(key){const file=path.resolve(config.storageDir,key);if(file.startsWith(`${path.resolve(config.storageDir)}${path.sep}`))fs.rmSync(file,{force:true});}await db.prepare('DELETE FROM tracks WHERE id=?').run(replica.local_track_id);}
    await db.prepare('DELETE FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').run(target.origin_node_id,target.object_id);
  }
  if(userId)await db.prepare('DELETE FROM users WHERE id=?').run(userId);
  await db.close();
}
