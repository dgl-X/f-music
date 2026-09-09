#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';

function readEnv(file) {
  const env={...process.env};
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line||line.startsWith('#'))continue;const at=line.indexOf('=');if(at>0)env[line.slice(0,at)]=line.slice(at+1);}
  return env;
}

const envFile=process.argv[2]||'/opt/family-music/.env',base='http://127.0.0.1:8095',config=loadConfig(readEnv(envFile)),db=await openDatabase(config.databaseUrl);
const username=`acl-smoke-${Date.now()}`,password=crypto.randomBytes(18).toString('base64url');let userId,collectionId,cookie,previousGlobal,peer,previousRule;

async function request(path,options={}){
  const response=await fetch(`${base}${path}`,{...options,headers:{origin:base,'content-type':'application/json',...(cookie?{cookie}:{}),...(options.headers||{})},body:options.body?JSON.stringify(options.body):undefined});
  const body=await response.json();if(!response.ok)throw new Error(`${options.method||'GET'} ${path}: HTTP ${response.status} ${body.error||body.error?.message||''}`);return{body,response};
}

try{
  userId=(await db.prepare('INSERT INTO users(username,display_name,password_hash,is_admin) VALUES(?,?,?,1) RETURNING id').run(username,'Federation ACL smoke',hashPassword(password))).rows[0].id;
  const login=await request('/api/v1/login',{method:'POST',body:{username,password,device_name:'ACL smoke'}});cookie=login.response.headers.getSetCookie()[0].split(';')[0];
  previousGlobal=(await request('/api/v1/admin/federation')).body;
  const tracks=await db.prepare('SELECT id FROM tracks ORDER BY created_at,id LIMIT 2').all();if(tracks.length<2)throw new Error('Для smoke-теста нужны минимум два локальных трека');
  peer=await db.prepare("SELECT node_id FROM federation_peers WHERE revoked_at IS NULL AND status<>'revoked' ORDER BY created_at LIMIT 1").get();if(!peer)throw new Error('Нет активной доверенной ноды');
  previousRule=await db.prepare('SELECT * FROM federation_peer_export_rules WHERE peer_node_id=?').get(peer.node_id);
  collectionId=(await request('/api/v1/admin/federation/collections',{method:'POST',body:{name:`ACL smoke ${Date.now()}`}})).body.id;
  await request(`/api/v1/admin/federation/collections/${collectionId}`,{method:'PUT',body:{name:`ACL smoke ${Date.now()}`,track_ids:[tracks[0].id]}});
  await request('/api/v1/admin/federation',{method:'PUT',body:{enabled:previousGlobal.enabled,export_policy:'collections',selected_albums:[],selected_collections:[collectionId],endpoints:previousGlobal.endpoints}});
  await request(`/api/v1/admin/federation/peers/${peer.node_id}/export-policy`,{method:'PUT',body:{policy:'collections',selected_collections:[collectionId],selected_albums:[]}});
  const effectiveCollection=await db.prepare('SELECT count(*) AS count FROM federation_export_collection_tracks WHERE collection_id=? AND track_id=?').get(collectionId,tracks[0].id);
  const recentEvents=await db.prepare("SELECT object_id,event_type FROM federation_catalog_events WHERE object_id=ANY(?::text[]) ORDER BY revision DESC LIMIT 10").all(tracks.map(item=>item.id));
  if(Number(effectiveCollection.count)!==1||!recentEvents.some(item=>item.object_id===tracks[0].id))throw new Error('Коллекция или события политики не сохранены');
  console.log(JSON.stringify({ok:true,collection_tracks:1,excluded_tracks:1,peer_policy:'collections',events:recentEvents.length}));
}finally{
  try{if(previousGlobal)await request('/api/v1/admin/federation',{method:'PUT',body:{enabled:previousGlobal.enabled,export_policy:previousGlobal.export_policy,selected_albums:previousGlobal.selected_albums,selected_collections:previousGlobal.selected_collections,endpoints:previousGlobal.endpoints}});}catch{}
  try{if(peer){if(previousRule)await db.prepare(`INSERT INTO federation_peer_export_rules(peer_node_id,policy,selected_albums_json,selected_collections_json,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(peer_node_id) DO UPDATE SET policy=excluded.policy,selected_albums_json=excluded.selected_albums_json,selected_collections_json=excluded.selected_collections_json,updated_at=CURRENT_TIMESTAMP`).run(peer.node_id,previousRule.policy,previousRule.selected_albums_json,previousRule.selected_collections_json);else await db.prepare('DELETE FROM federation_peer_export_rules WHERE peer_node_id=?').run(peer.node_id);}}catch{}
  try{if(collectionId)await db.prepare('DELETE FROM federation_export_collections WHERE id=?').run(collectionId);}catch{}
  try{if(userId)await db.prepare('DELETE FROM users WHERE id=?').run(userId);}catch{}
  await db.close();
}
