import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {ListeningJournal,mergeListeningSnapshots} from '../public/listening-journal.js';
const scope='a'.repeat(64),track='11111111-1111-4111-8111-111111111111',play='22222222-2222-4222-8222-222222222222';
function fixture(){
  let clock=1800000000000,writer=0;
  const indexedDB=new IDBFactory();
  const settings=()=>({generation:1,server_time_ms:clock});
  const data=(overrides={})=>({enabled:true,generation:1,confirmed_at:clock,server_offset:0,
    entries:[{playback_id:play,track_id:track,device_id:'journal_test_device',started_at_ms:clock-30000,elapsed_ms:10000,acknowledged:0,started:true}],...overrides});
  const journal=()=>new ListeningJournal({indexedDB,now:()=>clock,uuid:()=>`writer-${++writer}`});
  return{journal,data,settings,advance:ms=>{clock+=ms;},now:()=>clock};
}
test('released WEB journal is atomically transferred to the next document',async()=>{
  const f=fixture(),first=f.journal(),next=f.journal();
  await first.save(scope,f.data(),{released:true});
  const restored=await next.load(scope,f.settings());assert.equal(restored.entries[0].playback_id,play);assert.equal(restored.entries[0].elapsed_ms,10000);
  const rows=await next.transaction(scope,({rows})=>rows);assert.equal(rows.length,1);assert.equal(rows[0].writer,next.writer);
});
test('live tabs are not claimed; expired leases are recovered without another reload',async()=>{
  const f=fixture(),active=f.journal(),next=f.journal();await active.save(scope,f.data());
  assert.equal((await next.load(scope,f.settings())).entries.length,0);
  f.advance(60001);
  const recovered=await next.load(scope,f.settings(),{recover:true,snapshot:f.data({entries:[]})});
  assert.equal(recovered.entries.length,1);
  assert.equal((await next.load(scope,f.settings(),{recover:true,snapshot:recovered})).entries.length,0);
});
test('two reclaiming tabs cannot both own a released record',async()=>{
  const f=fixture(),first=f.journal(),a=f.journal(),b=f.journal();await first.save(scope,f.data(),{released:true});
  const loaded=await Promise.all([a.load(scope,f.settings()),b.load(scope,f.settings())]);
  assert.equal(loaded.reduce((sum,row)=>sum+row.entries.length,0),1);
});
test('clear barriers prevent a stale tab from restoring deleted counters',async()=>{
  const f=fixture(),a=f.journal(),b=f.journal();await a.save(scope,f.data());
  await b.clear(scope,{generation:2});assert.equal(await a.save(scope,f.data()),false);
  assert.equal(await a.load(scope,f.settings()),null);
  const settings={...f.settings(),generation:2};assert.equal((await a.load(scope,settings)).entries.length,0);
  assert.equal(await a.save(scope,f.data({generation:2})),true);
});
test('logout revokes this session scope and another login starts empty',async()=>{
  const f=fixture(),a=f.journal();await a.save(scope,f.data());await a.clear(scope,{revoke:true});
  assert.equal(await a.load(scope,{...f.settings(),generation:100}),null);
  assert.equal(await a.save(scope,f.data({generation:100})),false);
  assert.equal((await a.load('b'.repeat(64),f.settings())).entries.length,0);
});
test('scope switch erases records belonging to an earlier authenticated session',async()=>{
  const f=fixture(),a=f.journal();await a.save(scope,f.data());await a.load('b'.repeat(64),f.settings());
  assert.equal((await a.transaction(scope,({rows})=>rows)).some(row=>row.scope===scope),false);
});
test('journal limits writers and rejects oversized or invalid writes',async()=>{
  const f=fixture();for(let i=0;i<22;i++)await f.journal().save(scope,f.data());
  const a=f.journal();assert.ok((await a.transaction(scope,({rows})=>rows)).length<=16);
  assert.throws(()=>a.save(scope,{payload:'x'.repeat(131073)}),/limit/);
  await assert.rejects(a.load('invalid',f.settings()),/scope/);
  await assert.rejects(new ListeningJournal({indexedDB:null,uuid:()=>play}).load(scope,f.settings()),/unavailable/);
});
test('snapshot merge filters malformed, expired, foreign-generation and conflicting data',()=>{
  const f=fixture(),context={generation:1,wallNow:f.now(),serverNow:f.now(),serverOffset:0};
  const original=f.data(),entry=original.entries[0];
  const restored=mergeListeningSnapshots([original,f.data({entries:[{...entry,elapsed_ms:15000,acknowledged:5000}]})],context);
  assert.equal(restored.entries.length,1);assert.equal(restored.entries[0].elapsed_ms,15000);assert.equal(restored.entries[0].acknowledged,5000);
  for(const bad of [f.data({generation:2}),f.data({confirmed_at:f.now()-86400001}),f.data({entries:[{...entry,acknowledged:99999}]}),f.data({entries:[{...entry,started_at_ms:f.now()-86400001}]})])
    assert.equal(mergeListeningSnapshots([bad],context).entries.length,0);
  assert.equal(mergeListeningSnapshots([original,f.data({entries:[{...entry,track_id:play}]})],context).entries.length,0);
});
