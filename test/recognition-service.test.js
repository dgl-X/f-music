import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecognitionService, recognitionCandidates } from '../src/recognition-service.js';

test('recognition candidates prefer original album releases and weight duration', () => {
  const lookup={results:[{score:.9,recordings:[{id:'recording',title:'Song',duration:200,artists:[{name:'Artist'}],releasegroups:[
    {id:'live',title:'Live',type:'Album',secondarytypes:['Live'],releases:[{date:{year:2020}}]},
    {id:'album',title:'Studio',type:'Album',releases:[{date:{year:2018}}]},
  ]}]}]};
  const items=recognitionCandidates(lookup,201,200);
  assert.equal(items.length,1);
  assert.equal(items[0].album,'Studio');
  assert.equal(items[0].release_group_id,'album');
  assert.ok(items[0].confidence>.9);
});

test('recognition settings preserve configured defaults and update secrets transactionally', async () => {
  const calls=[];let rows=[];
  const db={prepare(){return{async all(){return rows;}};},async transaction(callback){await callback({prepare(sql){return{async run(value){calls.push({sql,value});}};}});}};
  const service=createRecognitionService({db,storageDir:'/unused',uploadDir:'/unused',extractCover:async()=>null,defaultEnabled:true,defaultClientKey:'default'});
  assert.deepEqual(await service.settings(),{enabled:true,clientKey:'default'});
  await service.saveSettings({enabled:false,keyProvided:true,clientKey:'new-key'});
  assert.equal(calls.length,2);
  assert.equal(calls[0].value,'false');
  assert.equal(calls[1].value,'new-key');
  rows=[{key:'recognition_enabled',value:'false'},{key:'acoustid_client_key',value:'stored'}];
  assert.deepEqual(await service.settings(),{enabled:false,clientKey:'stored'});
});

test('recognition worker applies bounded retry policy when source is missing', async () => {
  const calls=[];
  const db={prepare(sql){return{
    async all(){return[{key:'recognition_enabled',value:'true'},{key:'acoustid_client_key',value:'client'}];},
    async run(...params){calls.push({sql,params});if(sql.includes("status='processing'"))return{rows:[{id:7,track_id:'missing',attempts:5}]};return{changes:1,rows:[]};},
    async get(){return{storage_key:'outside/file.mp3'};},
  };}};
  const errors=[];
  const service=createRecognitionService({db,storageDir:'/unused',uploadDir:'/unused',extractCover:async()=>null,logError:(...args)=>errors.push(args)});
  assert.equal(await service.processNext(),false);
  const failed=calls.find(call=>call.sql.includes('error=?'));
  assert.deepEqual(failed.params.slice(0,2),['failed',480]);
  assert.equal(errors.length,1);
});
