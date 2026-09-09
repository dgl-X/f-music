#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { openFederationStream } from '../src/federation-endpoints.js';
import { loadFederationIdentity } from '../src/federation-identity.js';
import { signFederationRequest } from '../src/federation-signatures.js';

function readEnv(file){
  const env={...process.env};
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line||line.startsWith('#'))continue;const separator=line.indexOf('=');if(separator>0)env[line.slice(0,separator)]=line.slice(separator+1);}
  return env;
}

const config=loadConfig(readEnv(process.argv[2]||'/opt/family-music/.env')),db=await openDatabase(config.databaseUrl);
try{
  const target=await db.prepare(`SELECT remote.origin_node_id,remote.object_id,peer.endpoint FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id WHERE remote.cover_available=1 AND peer.revoked_at IS NULL AND peer.status<>'revoked' LIMIT 1`).get();
  if(!target)throw new Error('Нет удалённого трека с обложкой');
  const identity=loadFederationIdentity(config.storageDir),remotePath=`/federation/v1/tracks/${encodeURIComponent(target.object_id)}/cover`,targetUri=`${target.endpoint.replace(/\/$/,'')}${remotePath}`;
  const headers=signFederationRequest({method:'GET',targetUri,nodeId:identity.node_id,privateKeyPem:identity.private_key_pem}),upstream=await openFederationStream(target.endpoint,remotePath,headers,{timeoutMs:15000});
  let bytes=0;for await(const chunk of upstream.response){bytes+=chunk.length;if(bytes>12*1024*1024)throw new Error('Обложка превышает лимит');}
  if(upstream.response.statusCode!==200||!String(upstream.response.headers['content-type']||'').startsWith('image/')||!bytes)throw new Error(`Некорректный ответ обложки: HTTP ${upstream.response.statusCode}, ${bytes} байт`);
  console.log(JSON.stringify({ok:true,status:upstream.response.statusCode,bytes}));
}finally{await db.close();}
