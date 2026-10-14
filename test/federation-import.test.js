import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { sha256File } from '../src/media-tools.js';
import { createFederationImportService, federationImportRetryDelay, federationReplicaPaths, federationSourceId } from '../src/federation-import.js';

test('federation import retry delay is deterministic and bounded', () => {
  assert.equal(federationImportRetryDelay(1), 10);
  assert.equal(federationImportRetryDelay(2), 20);
  assert.equal(federationImportRetryDelay(20), 2560);
});

test('federation replica path does not expose node id in storage', () => {
  const result = federationReplicaPaths('/srv/music', 'fm:private-node', 'track-id');
  assert.equal(result.temporaryPath.startsWith(path.join('/srv/music', 'federation', 'replicas')), true);
  assert.equal(result.temporaryPath.includes('private-node'), false);
  assert.equal(result.temporaryPath.endsWith('.track-id.part'), true);
  assert.equal(federationSourceId('node', 'track'), 'node\ntrack');
});

function importFixture(t,{failCommit=false,rejectAudio=false,resume=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f-music-import-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const body=Buffer.from('exact uploaded source'),sha=crypto.createHash('sha256').update(body).digest('hex');
  const paths=federationReplicaPaths(root,'node','object');
  const job={origin_node_id:'node',object_id:'object',attempts:1,size_bytes:body.length,sha256:sha,mime_type:'audio/flac'};
  if(resume){fs.mkdirSync(path.dirname(paths.temporaryPath),{recursive:true});fs.writeFileSync(paths.temporaryPath,body);}
  const calls=[],remote={title:'Test',artist:'Test',duration_seconds:999};let imported=false;
  const db={prepare(sql){return{
    async get(){
      if(sql.includes('FROM federation_peers'))return{endpoint:'https://node.test'};
      if(sql.startsWith('SELECT status FROM federation_remote_replicas'))return{status:'downloading'};
      if(sql.startsWith('SELECT * FROM federation_remote_tracks'))return remote;
      return null;
    },
    async all(){return sql.includes('FROM federation_remote_likes')?[{user_id:1}]:[];},
    async run(...params){calls.push({sql,params});if(sql.includes('attempts=attempts+1'))return{rows:[job]};if(sql.includes("status='imported'"))imported=true;return{changes:1};},
  };},async transaction(callback){if(failCommit&&calls.some(c=>c.sql.includes('INSERT INTO tracks')))throw new Error('commit interrupted');const result=await callback(this);if(failCommit&&calls.some(c=>c.sql.includes('INSERT INTO tracks')))throw new Error('commit interrupted');return result;}};
  const {privateKey}=crypto.generateKeyPairSync('ed25519');
  const service=createFederationImportService({db,storageDir:root,uploadDir:root,originalDir:path.join(root,'originals'),sha256File,
    loadIdentity:()=>({node_id:'node',private_key_pem:privateKey.export({type:'pkcs8',format:'pem'})}),extractCover:async()=>null,logger:{error(){}},
    prepareAudio:async source=>{
      if(rejectAudio)throw Object.assign(new Error('invalid audio'),{code:'audio_invalid'});
      const output=source+'.normalized';fs.writeFileSync(output,'lossless prepared');
      return{normalized:true,output,sourceMetadata:{streams:[{codec_type:'audio',codec_name:'flac'}]},metadata:{duration:7,streams:[{codec_type:'audio',codec_name:'flac'}]},cleanup:()=>fs.rmSync(output,{force:true})};
    },
    openStream:async()=>{assert.equal(resume,false,'A complete verified download must not hit the network');const response=Readable.from([body]);response.statusCode=200;response.headers={'content-length':String(body.length),'content-type':'audio/flac','x-music-sha256':sha};return{response};},
  });
  return{service,root,paths,body,sha,calls,imported:()=>imported};
}

test('federation keeps original SHA and bytes, and stores a separately prepared playback file',async t=>{
  const h=importFixture(t);assert.equal(await h.service.processNext(),true);
  const track=h.calls.find(c=>c.sql.startsWith('INSERT INTO tracks'));
  assert.deepEqual(fs.readFileSync(path.join(h.root,track.params[9])),h.body);
  assert.equal(track.params[10],h.sha);assert.equal(track.params[8],7);assert.equal(track.params.at(-1),'flac');
  const derivative=h.calls.find(c=>c.sql.includes("'normalized_flac'"));
  assert.equal(fs.readFileSync(path.join(h.root,derivative.params[2]),'utf8'),'lossless prepared');
  assert.equal(h.imported(),true);
});

test('interrupted federation commit restores the exact download and removes the derivative',async t=>{
  const h=importFixture(t,{failCommit:true});assert.equal(await h.service.processNext(),false);
  assert.deepEqual(fs.readFileSync(h.paths.temporaryPath),h.body);
  const derivative=h.calls.find(c=>c.sql.includes("'normalized_flac'"));
  assert.equal(fs.existsSync(path.join(h.root,derivative.params[2])),false);
  assert.ok(h.calls.some(c=>c.sql.includes('available_at=CURRENT_TIMESTAMP+')&&c.params[0]==='retry'));
  assert.ok(h.calls.some(c=>c.sql.includes('SET sha256=?,mime_type=?')&&c.params[0]===h.sha));
});

test('verified complete federation download resumes preparation without another network request',async t=>{
  const h=importFixture(t,{resume:true});assert.equal(await h.service.processNext(),true);
  assert.equal(h.imported(),true);
});

test('a matching transport SHA does not bypass audio validation',async t=>{
  const h=importFixture(t,{rejectAudio:true});assert.equal(await h.service.processNext(),false);
  assert.equal(h.calls.some(c=>c.sql.startsWith('INSERT INTO tracks')),false);
  assert.deepEqual(fs.readFileSync(h.paths.temporaryPath),h.body);
  assert.ok(h.calls.some(c=>c.sql.includes('available_at=CURRENT_TIMESTAMP+')&&c.params[0]==='failed'));
});
