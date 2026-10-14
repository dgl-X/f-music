import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTranscodeService } from '../src/transcode-service.js';

test('transcode worker creates the requested AAC variant and records metrics',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-transcode-'));
  try{
    fs.mkdirSync(path.join(root,'originals'));fs.writeFileSync(path.join(root,'originals','song.flac'),'original');
    const calls=[];let finished;
    const db={prepare(sql){return{
      async run(...params){calls.push({sql,params});if(sql.includes("status='processing'"))return{rows:[{id:5,track_id:'track-id',variant:'aac_96'}]};return{rows:[],changes:1};},
      async get(){return{storage_key:'originals/song.flac'};},
    };}};
    const service=createTranscodeService({db,storageDir:root,
      inspectAudio:async()=>({duration:1,streams:[{codec_type:'audio',codec_name:'aac'}]}),validateAudioDecode:async()=>({valid:true}),
      async execute(command,args){assert.equal(command,'ffmpeg');assert.ok(args.includes('96k'));fs.writeFileSync(args.at(-1),'aac');return true;},
      startOperation(name){assert.equal(name,'audio.transcode');return async success=>{finished=success;};},
    });
    assert.equal(await service.processNext(),true);
    const ready=calls.find(call=>call.sql.includes("status='ready'"));
    assert.equal(ready.params[0],96000);
    assert.equal(ready.params[1],3);
    assert.match(ready.params[2],/^derived\/aac_96\/tr\/track-id\.m4a$/);
    assert.equal(finished,true);
    assert.equal(service.active(),0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('transcode worker rejects missing sources and removes partial output',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-transcode-'));
  try{
    const calls=[],errors=[];
    const db={prepare(sql){return{
      async run(...params){calls.push({sql,params});if(sql.includes("status='processing'"))return{rows:[{id:8,track_id:'missing',variant:'aac_192'}]};return{rows:[],changes:1};},
      async get(){return{storage_key:'originals/missing.flac'};},
    };}};
    const service=createTranscodeService({db,storageDir:root,execute:async()=>true,logError:(...items)=>errors.push(items)});
    assert.equal(await service.processNext(),false);
    const failed=calls.find(call=>call.sql.includes("status='failed'"));
    assert.match(failed.params[0],/Исходный файл не найден/);
    assert.equal(errors.length,1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('transcode recovery returns interrupted work to the queue',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-transcode-'));
  try{
    const calls=[];
    const db={prepare(sql){return{async run(){calls.push(sql);return{rows:[]};}};}};
    const service=createTranscodeService({db,storageDir:root,execute:async()=>true});
    assert.equal(await service.recover(),false);
    assert.match(calls[0],/status='retry'/);
    assert.match(calls[1],/status='processing'/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('AAC processing uses the repaired lossless container while preserving raw original',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f-music-repaired-transcode-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'originals'));fs.writeFileSync(path.join(root,'originals','raw.flac'),'raw');
  fs.mkdirSync(path.join(root,'derived'));fs.writeFileSync(path.join(root,'derived','repaired.flac'),'repaired');
  const db={prepare(sql){return{
    async run(){return sql.includes("status='processing'")?{rows:[{id:1,track_id:'track',variant:'aac_192'}]}:{changes:1};},
    async get(){assert.match(sql,/variant='normalized_flac' AND status='ready'/);return{storage_key:'derived/repaired.flac'};},
  };}};
  const service=createTranscodeService({db,storageDir:root,execute:async(_command,args)=>{
    assert.equal(args[args.indexOf('-i')+1],path.join(root,'derived','repaired.flac'));
    fs.writeFileSync(args.at(-1),'aac');return true;
  },inspectAudio:async()=>({duration:1,streams:[{codec_type:'audio',codec_name:'aac'}]}),validateAudioDecode:async()=>({valid:true})});
  assert.equal(await service.processNext(),true);
  assert.equal(fs.readFileSync(path.join(root,'originals','raw.flac'),'utf8'),'raw');
});

test('AAC is never published before successful probing and complete decoding',async t=>{
  for(const failure of ['codec','decode','duration','truncated']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'f-music-invalid-aac-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.writeFileSync(path.join(root,'original.flac'),'original');
    const calls=[];
    const db={prepare(sql){return{
      async run(...params){calls.push({sql,params});return sql.includes("status='processing'")?{rows:[{id:1,track_id:'track',variant:'aac_192'}]}:{changes:1};},
      async get(){return{storage_key:'original.flac',duration_seconds:100};},
    };}};
    const service=createTranscodeService({db,storageDir:root,logError:()=>{},
      execute:async(_cmd,args)=>{fs.writeFileSync(args.at(-1),'broken');return true;},
      inspectAudio:async()=>({duration:failure==='duration'?20:100,streams:[{codec_type:'audio',codec_name:failure==='codec'?'flac':'aac'}]}),
      validateAudioDecode:async()=>({valid:failure!=='decode',decodedSeconds:failure==='truncated'?92:100}),
    });
    assert.equal(await service.processNext(),false,failure);
    assert.equal(calls.some(call=>call.sql.includes("status='ready'")),false);
    assert.ok(calls.some(call=>call.sql.includes("status='failed'")));
    assert.equal(fs.existsSync(path.join(root,'derived/aac_192/tr/track.m4a.part')),false);
    assert.equal(fs.readFileSync(path.join(root,'original.flac'),'utf8'),'original');
  }
});
