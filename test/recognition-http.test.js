import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecognitionHttpController } from '../src/recognition-http.js';

function setup({db,recognition={},scheduled=[]}={}){
  const responses=[];
  const controller=createRecognitionHttpController({
    db,recognition,async readJson(req){return req.body||{};},
    sendJson(res,status,value){responses.push({status,value});},
    runSoon(callback){scheduled.push(callback);},
  });
  return{controller,responses,scheduled};
}

test('recognition HTTP settings are admin-only and never expose the API key',async()=>{
  const recognition={async settings(){return{enabled:true,clientKey:'secret'};}};
  const denied=setup({db:{},recognition});
  await denied.controller.handle({method:'GET'},{},new URL('http://local/api/admin/recognition-settings'),{is_admin:0});
  assert.equal(denied.responses[0].status,403);
  const allowed=setup({db:{},recognition});
  await allowed.controller.handle({method:'GET'},{},new URL('http://local/api/admin/recognition-settings'),{is_admin:1});
  assert.deepEqual(allowed.responses[0],{status:200,value:{enabled:true,key_configured:true}});
  assert.equal(JSON.stringify(allowed.responses).includes('secret'),false);
});

test('recognition list tolerates damaged candidates and preserves public response shape',async()=>{
  const db={prepare(sql){return{async all(){
    if(sql.includes('GROUP BY status'))return[{status:'review',count:'1'}];
    return[{id:4,status:'review',confidence:'0.72',duration_seconds:'123',track_id:'track',cover_key:'cover',candidates_json:'{broken'}];
  }};}};
  const recognition={async settings(){return{enabled:true,clientKey:'configured'};}};
  const {controller,responses}=setup({db,recognition});
  await controller.handle({method:'GET'},{},new URL('http://local/api/recognition'),{is_admin:1},'/api/v1');
  assert.equal(responses[0].value.enabled,true);
  assert.deepEqual(responses[0].value.states,{review:1});
  assert.deepEqual(responses[0].value.items[0].candidates,[]);
  assert.equal(responses[0].value.items[0].cover_url,'/api/v1/tracks/track/cover');
  assert.equal(responses[0].value.items[0].candidates_json,undefined);
});

test('recognition bulk apply skips unusable jobs and schedules cover loading',async()=>{
  const writes=[];
  const jobs=[
    {id:1,track_id:'one',status:'review',candidates_json:JSON.stringify([{title:'Song',artist:'Artist',album:'Album',year:2020,release_group_id:'release'}])},
    {id:2,track_id:'two',status:'review',candidates_json:'broken'},
  ];
  const tx={prepare(sql){return{async run(...params){writes.push({sql,params});}};}};
  const db={prepare(){return{async all(){return jobs;}};},async transaction(callback){await callback(tx);}};
  const covers=[];const scheduled=[];
  const recognition={async addCover(...args){covers.push(args);}};
  const {controller,responses}=setup({db,recognition,scheduled});
  await controller.handle({method:'POST',body:{ids:[1,2,2],action:'apply'}},{},new URL('http://local/api/recognition/bulk'),{is_admin:1});
  assert.deepEqual(responses[0],{status:200,value:{updated:1,skipped:1}});
  assert.equal(writes.length,2);
  assert.equal(scheduled.length,1);
  await scheduled[0]();
  assert.deepEqual(covers,[['one','release']]);
});

test('recognition manual edit validates year and updates track transactionally',async()=>{
  const writes=[];
  const db={
    prepare(){return{async get(){return{id:7,track_id:'track'};}};},
    async transaction(callback){await callback({prepare(sql){return{async run(...params){writes.push({sql,params});}};}});},
  };
  const invalid=setup({db,recognition:{}});
  await invalid.controller.handle({method:'POST',body:{title:'Song',artist:'Artist',year:99}},{},new URL('http://local/api/recognition/7/manual'),{is_admin:1});
  assert.equal(invalid.responses[0].status,400);
  const valid=setup({db,recognition:{}});
  await valid.controller.handle({method:'POST',body:{title:'Song',artist:'Artist',album:'A',genre:'G',year:2021}},{},new URL('http://local/api/recognition/7/manual'),{is_admin:1});
  assert.equal(valid.responses[0].status,200);
  assert.deepEqual(writes[0].params,['Song','Artist','A','G',2021,'track']);
});

test('recognition HTTP controller ignores unrelated routes',async()=>{
  const {controller,responses}=setup({db:{},recognition:{}});
  assert.equal(await controller.handle({method:'GET'},{},new URL('http://local/api/tracks'),{is_admin:1}),false);
  assert.deepEqual(responses,[]);
});
