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
