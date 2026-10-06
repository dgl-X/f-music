import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkerMaintenance } from '../src/worker-maintenance.js';

function temporaryStorage(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-maintenance-'));
  const uploadDir=path.join(root,'uploads');fs.mkdirSync(uploadDir);
  return{root,uploadDir};
}

test('worker heartbeat stores only operational process details',async()=>{
  const calls=[];
  const db={prepare(sql){return{async run(...params){calls.push({sql,params});return{rows:[]};}};}};
  const {root,uploadDir}=temporaryStorage();
  try{
    const maintenance=createWorkerMaintenance({db,storageDir:root,uploadDir,abandonedUploadHours:1,diagnosticReports:{},pid:42,nodeVersion:'v24.test'});
    await maintenance.heartbeat();
    assert.deepEqual(JSON.parse(calls[0].params[0]),{pid:42,version:'v24.test'});
    assert.match(calls[0].sql,/service_heartbeats/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('upload cleanup removes abandoned database and orphaned disk parts but keeps active upload',async()=>{
  const {root,uploadDir}=temporaryStorage();
  try{
    for(const name of ['expired.part','orphan.part','active.part'])fs.writeFileSync(path.join(uploadDir,name),'part');
    const old=new Date(Date.now()-3*3600000);fs.utimesSync(path.join(uploadDir,'orphan.part'),old,old);
    const calls=[];
    const db={prepare(sql){return{
      async run(){calls.push(sql);return sql.startsWith('DELETE FROM uploads')?{rows:[{id:'expired'}]}:{rows:[]};},
      async all(){return[{id:'active'}];},
    };}};
    const maintenance=createWorkerMaintenance({db,storageDir:root,uploadDir,abandonedUploadHours:1,diagnosticReports:{},log(){}});
    assert.equal(await maintenance.cleanupUploads(),1);
    assert.equal(fs.existsSync(path.join(uploadDir,'expired.part')),false);
    assert.equal(fs.existsSync(path.join(uploadDir,'orphan.part')),false);
    assert.equal(fs.existsSync(path.join(uploadDir,'active.part')),true);
    assert.ok(calls.some(sql=>sql.includes('processing_jobs')));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('track enrichment stays inside storage and preserves duplicate hashes',async()=>{
  const {root,uploadDir}=temporaryStorage();
  try{
    fs.mkdirSync(path.join(root,'originals'));fs.writeFileSync(path.join(root,'originals','song.mp3'),'audio');
    const updates=[];
    const tracks=[{id:'track',storage_key:'originals/song.mp3',cover_key:null},{id:'escape',storage_key:'../outside.mp3',cover_key:null}];
    const db={prepare(sql){return{
      async all(){return tracks;},
      async get(){return{id:'duplicate'};},
      async run(...params){updates.push({sql,params});return{rows:[]};},
    };}};
    const maintenance=createWorkerMaintenance({db,storageDir:root,uploadDir,abandonedUploadHours:1,diagnosticReports:{},
      async inspectAudio(){return{tags:{}};},async sha256File(){return'hash';},async extractCover(){return'covers/track.jpg';},
      normalizedTags(){return{genre:'Rock',year:2020,trackNumber:2,discNumber:1};},log(){},logError(){},
    });
    assert.equal(await maintenance.enrichTracks(),2);
    assert.equal(updates.length,1);
    assert.deepEqual(updates[0].params,[null,'covers/track.jpg','Rock',2020,2,1,'track']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('maintenance delegates report and federation retention',async()=>{
  const {root,uploadDir}=temporaryStorage();
  try{
    const calls=[];
    const db={prepare(sql){return{async run(){calls.push(sql);return{rows:[]};}};}};
    const maintenance=createWorkerMaintenance({db,storageDir:root,uploadDir,abandonedUploadHours:1,diagnosticReports:{async cleanup(){return 3;}},log(){}});
    assert.equal(await maintenance.cleanupReports(),3);
    await maintenance.cleanupFederation();
    assert.equal(calls.length,2);
    assert.match(calls[0],/federation_nonces/);
    assert.match(calls[1],/federation_invitations/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
