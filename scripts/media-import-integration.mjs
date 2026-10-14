import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createFederationImportService, federationReplicaPaths } from '../src/federation-import.js';
import { inspectAudio, sha256File, runProcess } from '../src/media-tools.js';
import { createStreamingHttpController } from '../src/streaming-http.js';
import { createTranscodeService } from '../src/transcode-service.js';
import { playbackVariant } from '../src/audio-compatibility.js';
import { validateAudioDecode } from '../src/audio-validation.js';
import { serveStoredMedia } from '../src/media-stream.js';
import { createWorkerMaintenance } from '../src/worker-maintenance.js';
import { MediaPlaybackClient } from '../public/media-playback-client.js';

const url=process.env.MEDIA_IMPORT_TEST_DATABASE_URL;
if(!url||!/(test|ci)/i.test(new URL(url).pathname))throw new Error('Нужна отдельная тестовая БД в MEDIA_IMPORT_TEST_DATABASE_URL');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'f-music-import-integration-'));
const {privateKey}=crypto.generateKeyPairSync('ed25519');
const nodeId='fm:'+crypto.randomBytes(24).toString('base64url');
const identity={node_id:nodeId,private_key_pem:privateKey.export({type:'pkcs8',format:'pem'})};
let db;
function ffmpeg(args){
  const r=spawnSync('ffmpeg',['-nostdin','-v','error','-threads','1',...args],{maxBuffer:1024*1024});
  assert.ifError(r.error);assert.equal(r.status,0,r.stderr?.toString());return r.stdout.toString().trim();
}
const pcm=file=>ffmpeg(['-i',file,'-map','0:a:0','-c:a','pcm_s32le','-f','hash','-hash','sha256','-']);
try{
  db=await openDatabase(url);
  assert.equal(Number((await db.prepare('SELECT count(*) count FROM users').get()).count),0,'Тест требует пустую БД');
  const owner=(await db.prepare('INSERT INTO users(username,display_name,password_hash) VALUES(?,?,?) RETURNING id').run('media-test','Media test','test-only')).rows[0].id;
  await db.prepare(`INSERT INTO federation_peers(node_id,label,public_key,endpoint,status,protocol_major,protocol_minor,capabilities_json)
    VALUES(?,?,?,?,'compatible',1,0,'{}')`).run(nodeId,'Test','test-public-key','https://source.test');
  let original=process.env.F_MUSIC_TEST_ORIGINAL_FILE;
  if(!original){original=path.join(root,'source.flac');ffmpeg(['-f','lavfi','-i','sine=frequency=440:duration=1.25','-c:a','flac','-y',original]);}
  const originalHash=await sha256File(original),metadata=await inspectAudio(original),originalPcm=pcm(original);
  const mp4=path.join(root,'embedded.m4a');ffmpeg(['-i',original,'-map','0:a:0','-c:a','copy','-strict','experimental','-f','mp4','-y',mp4]);
  const hybrid=path.join(root,'hybrid.flac');fs.writeFileSync(hybrid,Buffer.concat([Buffer.from('fLaC'),Buffer.from([0x81,0,0,0]),fs.readFileSync(mp4)]));
  for(const [name,input] of [['native',original],['hybrid',hybrid],['broken',null]]){
    const object=crypto.randomUUID(),body=input?fs.readFileSync(input):Buffer.from('not audio');
    const sha=crypto.createHash('sha256').update(body).digest('hex');
    await db.prepare(`INSERT INTO federation_remote_tracks(origin_node_id,object_id,revision,title,artist,duration_seconds)
      VALUES(?,?,1,?,?,999)`).run(nodeId,object,'Test '+name,'Test');
    await db.prepare('INSERT INTO federation_remote_likes(user_id,origin_node_id,object_id) VALUES(?,?,?)').run(owner,nodeId,object);
    await db.prepare("INSERT INTO federation_remote_replicas(origin_node_id,object_id,status) VALUES(?,?,'queued')").run(nodeId,object);
    const service=createFederationImportService({db,storageDir:root,uploadDir:root,originalDir:path.join(root,'originals'),loadIdentity:()=>identity,sha256File,extractCover:async()=>null,logger:{error(){}},
      openStream:async()=>{const response=Readable.from([body]);response.statusCode=200;response.headers={'content-length':String(body.length),'content-type':'audio/flac','x-music-sha256':sha};return{response};},
    });
    assert.equal(await service.processNext(),name!=='broken');
    const replica=await db.prepare('SELECT * FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(nodeId,object);
    assert.equal(replica.sha256,sha);
    if(name==='broken'){
      assert.equal(replica.status,'failed');assert.equal(replica.local_track_id,null);
      fs.rmSync(federationReplicaPaths(root,nodeId,object).temporaryPath,{force:true});
      console.log('Broken audio with matching SHA rejected: OK');continue;
    }
    assert.equal(replica.status,'imported');
    const track=await db.prepare('SELECT * FROM tracks WHERE id=?').get(replica.local_track_id);
    assert.equal(track.sha256,sha);assert.equal(track.source_codec,'flac');
    assert.equal(await sha256File(path.join(root,track.storage_key)),sha);
    assert.ok(Math.abs(track.duration_seconds-Number(metadata.duration))<0.1);
    const derivative=await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant='normalized_flac'").get(track.id);
    assert.equal(Boolean(derivative),name==='hybrid');
    assert.equal(pcm(path.join(root,derivative?.storage_key||track.storage_key)),originalPcm);
    assert.equal(Number((await db.prepare('SELECT count(*) count FROM track_likes WHERE track_id=?').get(track.id)).count),1);
    assert.equal(Number((await db.prepare('SELECT count(*) count FROM federation_remote_likes WHERE origin_node_id=? AND object_id=?').get(nodeId,object)).count),0);
    console.log(`Federation ${name}: source SHA, PCM, measured duration and local like OK`);
    if(name==='native'){
      await db.prepare('UPDATE tracks SET source_codec=NULL WHERE id=?').run(track.id);
      const maintenance=createWorkerMaintenance({db,storageDir:root,uploadDir:root,inspectAudio,
        sha256File:async()=>assert.fail('Known original must not be rehashed'),extractCover:async()=>assert.fail('Checked artwork must not be extracted'),
        normalizedTags:()=>({genre:'',year:null,trackNumber:null,discNumber:null}),log(){},logError(error){throw new Error(error);}});
      await maintenance.enrichTracks();
      assert.equal((await db.prepare('SELECT source_codec FROM tracks WHERE id=?').get(track.id)).source_codec,'flac');
      console.log('Legacy codec backfill without rehashing original: OK');
    }
    const responses=[];let served=0;
    const streaming=createStreamingHttpController({db,storageDir:root,xAccelRedirect:false,playbackVariant,
      serveStoredMedia(){served++;return true;},sendJson(_res,status,value){responses.push({status,value});}});
    const statusUrl=new URL(`https://music.test/api/tracks/${track.id}/playback?codecs=mp3,aac`);
    await streaming.handle({method:'GET'},{},statusUrl);
    assert.equal(responses.at(-1).value.status,'preparing');
    await streaming.handle({method:'GET'},{},new URL(`https://music.test/api/tracks/${track.id}/stream?codecs=mp3,aac`));
    assert.equal(responses.at(-1).status,409);assert.equal(served,0);
    const worker=createTranscodeService({db,storageDir:root,execute:runProcess});
    assert.equal(await worker.processNext(),true);
    await streaming.handle({method:'GET'},{},statusUrl);
    assert.equal(responses.at(-1).value.status,'ready');assert.equal(responses.at(-1).value.variant,'aac_192');
    const aac=await db.prepare("SELECT * FROM track_files WHERE track_id=? AND variant='aac_192'").get(track.id);
    assert.equal((await validateAudioDecode(path.join(root,aac.storage_key),metadata.duration)).valid,true);
    assert.equal(await sha256File(path.join(root,track.storage_key)),sha);
    console.log(`Playback ${name}: unsupported fallback blocked, preparing -> ready AAC OK`);
    const httpController=createStreamingHttpController({db,storageDir:root,xAccelRedirect:false,playbackVariant,serveStoredMedia,
      sendJson(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}});
    const server=createServer((req,res)=>{
      const requestUrl=new URL(req.url,'http://localhost');requestUrl.pathname=requestUrl.pathname.replace(/^\/api\/v1\//,'/api/');
      httpController.handle(req,res,requestUrl).catch(()=>{res.writeHead(500);res.end();});
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const base=`http://127.0.0.1:${server.address().port}`;
      const client=new MediaPlaybackClient({codecs:['aac'],api:async url=>{
        const response=await fetch(base+url),body=await response.json();
        if(!response.ok)throw Object.assign(new Error(body.error),{status:response.status});return body;
      }});
      const selection=await client.resolve({id:track.id});assert.equal(selection.variant,'aac_192');
      const response=await fetch(base+selection.stream_url,{headers:{Range:'bytes=0-1023'}});
      assert.equal(response.status,206);assert.equal(response.headers.get('X-Music-Variant'),'aac_192');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(path.join(root,aac.storage_key)).subarray(0,1024));
      console.log(`WEB ${name}: client resolution, pinned variant and real HTTP Range OK`);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  assert.equal(await sha256File(original),originalHash);
}finally{await db?.close();fs.rmSync(root,{recursive:true,force:true});}
