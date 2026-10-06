import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLoudnessHttpController, createLoudnessService, parseLoudness } from '../src/loudness-service.js';

test('loudness parser calculates bounded replay gain from the last ffmpeg block', () => {
  const value=parseLoudness('noise\n{"input_i":"-20.50","input_tp":"-3.00","input_lra":"7.2"}');
  assert.deepEqual(value,{integrated:-20.5,peak:-3,range:7.2,gain:2});
  assert.throws(()=>parseLoudness('no measurement'),/не вернул измерение/);
  assert.throws(()=>parseLoudness('{"input_i":"inf","input_tp":"-1","input_lra":"2"}'),/Некорректное измерение/);
});

test('loudness worker claims, measures and completes one job', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-loudness-'));
  try {
    fs.mkdirSync(path.join(root,'originals'));fs.writeFileSync(path.join(root,'originals','track.flac'),'audio');
    const calls=[];let finished;
    const db={prepare(sql){return{
      async run(...params){calls.push({sql,params});if(sql.includes("status='processing'"))return{rows:[{id:4,track_id:'track',attempts:1}]};return{changes:1,rows:[]};},
      async get(){return{storage_key:'originals/track.flac'};},
    };}};
    const service=createLoudnessService({db,storageDir:root,
      async execute(command,args){assert.equal(command,'ffmpeg');assert.ok(args.includes(path.join(root,'originals','track.flac')));return'{"input_i":"-18","input_tp":"-2","input_lra":"5"}';},
      startOperation(name){assert.equal(name,'audio.loudness');return async success=>{finished=success;};},
    });
    assert.equal(await service.processNext(),true);
    const ready=calls.find(call=>call.sql.includes("status='ready'"));
    assert.deepEqual(ready.params,[-18,-2,5,1,4]);
    assert.equal(finished,true);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('loudness service keeps summary shape, retry policy and scan idempotency', async () => {
  const calls=[];
  const db={prepare(sql){return{
    async run(...params){calls.push({sql,params});if(sql.includes("status='processing'"))return{rows:[{id:9,track_id:'missing',attempts:3}]};if(sql.startsWith('INSERT'))return{changes:7};return{changes:1,rows:[]};},
    async get(){if(sql.includes('SELECT storage_key'))return null;return{analyzed:'2',average_lufs:'-15.25',quietest_lufs:'-20',loudest_lufs:'-11'};},
    async all(){return[{status:'ready',count:'2'}];},
  };}};
  const errors=[];
  const service=createLoudnessService({db,storageDir:'/unused',logError:(...items)=>errors.push(items)});
  assert.equal(await service.processNext(),false);
  const failed=calls.find(call=>call.sql.includes('error=?'));
  assert.deepEqual(failed.params.slice(0,2),['failed',120]);
  assert.equal(errors.length,1);
  assert.deepEqual(await service.summary(),{states:{ready:2},values:{analyzed:2,average_lufs:-15.25,quietest_lufs:-20,loudest_lufs:-11}});
  assert.equal(await service.scan(),7);
});

test('loudness HTTP routes are admin-only and preserve existing responses', async () => {
  const responses=[];
  const loudness={async summary(){return{states:{},values:{}};},async scan(){return 4;}};
  const controller=createLoudnessHttpController({loudness,sendJson(res,status,value){responses.push({status,value});}});
  await controller.handle({method:'GET'},{},new URL('http://local/api/admin/loudness'),{is_admin:0});
  assert.equal(responses[0].status,403);
  await controller.handle({method:'POST'},{},new URL('http://local/api/admin/loudness/scan'),{is_admin:1});
  assert.deepEqual(responses[1],{status:200,value:{queued:4}});
  assert.equal(await controller.handle({method:'GET'},{},new URL('http://local/api/tracks'),{is_admin:1}),false);
});
