import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { inspectAudio, sha256File } from '../src/media-tools.js';
import { audioCodec, requiresCompatibilityVariant } from '../src/audio-compatibility.js';
import { normalizeHybridFlac } from '../src/audio-normalization.js';
import { validateAudioDecode } from '../src/audio-validation.js';
import { createUploadProcessor } from '../src/upload-processor.js';
import { createStreamingHttpController } from '../src/streaming-http.js';
import { serveStoredMedia } from '../src/media-stream.js';
import { playbackVariant } from '../src/audio-compatibility.js';

const original=process.env.F_MUSIC_TEST_ORIGINAL_FILE;
function ffmpeg(args) {
  const result=spawnSync('ffmpeg',['-nostdin','-v','error','-threads','1',...args],{maxBuffer:1024*1024});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr?.toString());
  return result.stdout.toString().trim();
}
const pcmHash=file=>ffmpeg(['-i',file,'-map','0:a:0','-c:a','pcm_s32le','-f','hash','-hash','sha256','-']);

test('real FLAC survives upload unchanged and its repaired container retains identical decoded audio', {skip:!original},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f-music-real-original-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const originalHash=await sha256File(original),decodedHash=pcmHash(original),originalMetadata=await inspectAudio(original);
  assert.equal(audioCodec(originalMetadata),'flac');
  const mp4=path.join(dir,'embedded.m4a');
  ffmpeg(['-i',original,'-map','0:a:0','-c:a','copy','-strict','experimental','-f','mp4','-y',mp4]);
  const hybrid=path.join(dir,'hybrid.flac');
  fs.writeFileSync(hybrid,Buffer.concat([Buffer.from('fLaC'),Buffer.from([0x81,0,0,0]),fs.readFileSync(mp4)]));
  for(const input of [original,hybrid]){
    const storageDir=fs.mkdtempSync(path.join(dir,'storage-'));
    const uploadDir=path.join(storageDir,'uploads');fs.mkdirSync(uploadDir);
    const records=[];
    const db={prepare(sql){return{async get(){return null;},async run(...params){records.push({sql,params});return{changes:1};}};},async transaction(callback){return callback(this);}};
    const processor=createUploadProcessor({db,storageDir,uploadDir,originalDir:path.join(storageDir,'originals'),inspectAudio,sha256File,validateAudioDecode,normalizeHybridFlac,audioCodec,requiresCompatibilityVariant,
      extractCover:async()=>null,recognitionSettings:async()=>({enabled:false}),normalizedTags:()=>({}),randomUUID:()=> 'aa000000-0000-4000-8000-000000000001'});
    fs.copyFileSync(input,path.join(uploadDir,'test.part'));
    const inputHash=await sha256File(input);
    assert.equal((await processor.process({id:'test',user_id:1,filename:'test.flac',mime_type:'audio/flac'})).status,'ready');
    const track=records.find(row=>row.sql.startsWith('INSERT INTO tracks'));
    assert.equal(track.params[10],inputHash);
    assert.equal(await sha256File(path.join(storageDir,track.params[9])),inputHash);
    const repaired=records.find(row=>row.sql.includes("'normalized_flac'"));
    assert.equal(Boolean(repaired),input===hybrid);
    const playable=path.join(storageDir,repaired?repaired.params[2]:track.params[9]);
    assert.equal(pcmHash(playable),decodedHash);
    assert.ok(Math.abs(Number((await inspectAudio(playable)).duration)-Number(originalMetadata.duration))<0.1);
    assert.equal((await validateAudioDecode(playable,originalMetadata.duration)).valid,true);
    const streamDb={prepare(sql){return{async get(){return sql.includes('FROM tracks')?{id:track.params[0],storage_key:track.params[9],source_codec:'flac',mime_type:'audio/flac'}:repaired?{variant:'normalized_flac',storage_key:repaired.params[2],mime_type:'audio/flac'}:null;}};}};
    const controller=createStreamingHttpController({db:streamDb,storageDir,xAccelRedirect:false,playbackVariant,serveStoredMedia,sendJson(res,status,value){res.writeHead(status);res.end(JSON.stringify(value));}});
    const server=createServer((req,res)=>controller.handle(req,res,new URL(req.url,'http://localhost')).catch(()=>{res.writeHead(500);res.end();}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const stream=`http://127.0.0.1:${server.address().port}/api/tracks/${track.params[0]}/stream`;
      for(const quality of ['original','source']){
        const response=await fetch(stream+'?quality='+quality,{headers:{Range:'bytes=0-1023'}});
        assert.equal(response.status,206);
        const expected=quality==='source'?input:playable;
        assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(expected).subarray(0,1024));
        assert.equal(response.headers.get('x-music-variant'),quality==='source'||!repaired?'original':'normalized_flac');
      }
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  assert.equal(await sha256File(original),originalHash);
});
