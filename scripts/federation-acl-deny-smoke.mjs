#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { openFederationStream } from '../src/federation-endpoints.js';
import { loadFederationIdentity } from '../src/federation-identity.js';
import { signFederationRequest } from '../src/federation-signatures.js';

function readEnv(file){const env={...process.env};for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line||line.startsWith('#'))continue;const at=line.indexOf('=');if(at>0)env[line.slice(0,at)]=line.slice(at+1);}return env;}

const envFile=process.argv[2]||'/opt/family-music/.env',objectId=String(process.argv[3]||'');
if(!/^[0-9a-f-]{36}$/.test(objectId))throw new Error('Укажите UUID заведомо закрытого трека');
const config=loadConfig(readEnv(envFile)),db=await openDatabase(config.databaseUrl),identity=loadFederationIdentity(config.storageDir);
try{
  if(!identity)throw new Error('Identity федерации не создана');
  const peer=await db.prepare("SELECT * FROM federation_peers WHERE revoked_at IS NULL AND status<>'revoked' ORDER BY created_at LIMIT 1").get();
  if(!peer)throw new Error('Нет активной доверенной ноды');
  const query=new URLSearchParams({quality:'original',range:'bytes=0-0'}),remotePath=`/federation/v1/tracks/${objectId}/stream?${query}`,targetUri=`${peer.endpoint.replace(/\/$/,'')}${remotePath}`;
  const headers=signFederationRequest({method:'GET',targetUri,nodeId:identity.node_id,privateKeyPem:identity.private_key_pem}),stream=await openFederationStream(peer.endpoint,remotePath,headers),chunks=[];
  for await(const chunk of stream.response)chunks.push(chunk);
  const body=Buffer.concat(chunks).toString('utf8');
  if(stream.response.statusCode!==403)throw new Error(`Ожидался HTTP 403, получен ${stream.response.statusCode}: ${body.slice(0,200)}`);
  console.log(JSON.stringify({ok:true,status:403,track_not_shared:body.includes('track_not_shared')}));
}finally{await db.close();}
