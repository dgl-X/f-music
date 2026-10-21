import test from 'node:test';
import assert from 'node:assert/strict';
import {validateListeningCounter,qualifiedListeningThreshold,validOfflineStart,OFFLINE_LISTENING_WINDOW_MS} from '../src/listening-events.js';
import {listeningPeriod} from '../src/measured-statistics.js';
import {createListeningStatisticsHttp} from '../src/listening-statistics-http.js';
const valid={playback_id:'11111111-1111-4111-8111-111111111111',track_id:'22222222-2222-4222-8222-222222222222',client_type:'web',elapsed_ms:0,generation:1};

test('listening counters validate bounded cumulative time, identities and generation',()=>{
  assert.equal(validateListeningCounter(valid),true);
  for(const value of [{elapsed_ms:-1},{elapsed_ms:1.5},{elapsed_ms:'1000'},{elapsed_ms:86400001},{elapsed_ms:Infinity},{generation:-1},{playback_id:'invalid'},{track_id:'remote:abc'},{client_type:'controller'},{device_id:'bad'}])assert.equal(validateListeningCounter({...valid,...value}),false);
});
test('qualified listening uses thirty seconds or half a short track',()=>{
  assert.equal(qualifiedListeningThreshold(180),30000);assert.equal(qualifiedListeningThreshold(20),10000);
  assert.equal(qualifiedListeningThreshold(null),30000);assert.equal(qualifiedListeningThreshold(0),30000);
});
test('journal scope is an optional bounded identifier, not arbitrary input',()=>{
  assert.equal(validateListeningCounter({...valid,journal_scope:'a'.repeat(64)}),true);
  for(const journal_scope of ['bad','A'.repeat(64),'a'.repeat(65),null,{}])assert.equal(validateListeningCounter({...valid,journal_scope}),false);
});
test('offline timestamps are bounded by consent, authentication and the advertised window',()=>{
  const now=Date.now(),consent=now-10000,session=now-20000;
  assert.equal(validOfflineStart(now-5000,now,consent,session),true);
  for(const start of [now+1001,now-OFFLINE_LISTENING_WINDOW_MS-1,consent-1001,NaN])assert.equal(validOfflineStart(start,now,consent,session),false);
  assert.equal(validOfflineStart(now-5000,now,consent,now),false);
  assert.equal(validateListeningCounter({...valid,client_type:'android',started_at_ms:now}),true);
  assert.equal(validateListeningCounter({...valid,started_at_ms:now}),true);
  assert.equal(validateListeningCounter({...valid,client_type:'android',started_at_ms:'123'}),false);
});
test('period is a closed enum rather than interpolated SQL',()=>{
  assert.equal(listeningPeriod('7'),'7');assert.equal(listeningPeriod('all'),'all');assert.equal(listeningPeriod('365'),null);assert.equal(listeningPeriod("7; DELETE FROM users"),null);
});
test('measured HTTP enforces administrator and authenticated-user scope',async()=>{
  const calls=[],responses=[];
  const controller=createListeningStatisticsHttp({statistics:{},measured:{async personal(id,period){calls.push({id,period});return{};},async administrative(){assert.fail('forbidden');}},
    events:{async configure(id,enabled){calls.push({id,enabled});return{status:'ok',settings:{enabled}};},async clear(id){calls.push({id,clear:true});return{};}},
    readJson:async()=>({enabled:true,user_id:999}),sendJson(_res,status,value){responses.push({status,value});}});
  const run=(method,path)=>controller.handle({method},{},new URL('https://music.test'+path),{id:7,is_admin:0,session_id:12});
  await run('GET','/api/admin/listening');assert.equal(responses.at(-1).status,403);assert.equal(calls.length,0);
  await run('GET','/api/statistics/listening?user_id=999&period=30');assert.deepEqual(calls.at(-1),{id:7,period:'30'});
  await run('GET','/api/statistics/listening?period=999');assert.equal(responses.at(-1).status,400);
  await run('PUT','/api/statistics/settings');assert.deepEqual(calls.at(-1),{id:7,enabled:true});
  await run('DELETE','/api/statistics/listening');assert.deepEqual(calls.at(-1),{id:7,clear:true});
});
