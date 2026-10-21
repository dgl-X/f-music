import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {ListeningJournal} from '../public/listening-journal.js';
import {ListeningTracker} from '../public/listening-tracker.js';
const scope='a'.repeat(64),track='11111111-1111-4111-8111-111111111111';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function wait(check){for(let i=0;i<500;i++){if(check())return;await flush();}assert.fail('Collector did not settle');}
function fixture(){
  let clock=0,accepted=0;
  const indexedDB=new IDBFactory(),stored=new Map(),sent=[];
  const mode={offline:false,lose:false,legacy:false,enabled:true,generation:1,scope};
  const state={trackId:track,deviceId:'web_statistics_test_device',positionSeconds:0,rate:1,executing:true,playing:true};
  const settings=()=>({enabled:mode.enabled,generation:mode.generation,...mode.legacy?{}:{journal_scope:mode.scope,offline_window_ms:86400000,server_time_ms:1800000000000+clock}});
  async function api(url,request){
    if(mode.offline)throw new Error('offline');
    if(!request)return settings();
    const body=JSON.parse(request.body);sent.push(body);
    if(!mode.enabled)return{status:'disabled'};
    if(body.generation!==mode.generation)throw Object.assign(new Error('generation'),{status:409,code:'statistics_generation_changed'});
    if(body.journal_scope&&body.journal_scope!==mode.scope)throw Object.assign(new Error('session'),{status:409});
    const previous=stored.get(body.playback_id)||0;
    accepted+=Math.max(0,body.elapsed_ms-previous);stored.set(body.playback_id,Math.max(previous,body.elapsed_ms));
    if(mode.lose){mode.lose=false;throw new Error('ACK lost');}
    return{status:'ok',elapsed_ms:stored.get(body.playback_id)};
  }
  function create(journal=new ListeningJournal({indexedDB,now:()=>1800000000000+clock,uuid:randomUUID})){
    const tracker=new ListeningTracker({api,journal,sample:()=>({...state}),now:()=>clock,wallNow:()=>1800000000000+clock,
      uuid:randomUUID,schedule:()=>1,cancel:()=>{}});
    return{tracker,journal,async start(){tracker.start();await wait(()=>!tracker.settingsBusy&&tracker.journalReady);tracker.tick();await flush();},
      async step(ms=1000){clock+=ms;state.positionSeconds+=ms/1000;tracker.tick();await flush();}};
  }
  return{create,mode,state,sent,settings,accepted:()=>accepted,advance:ms=>{clock+=ms;}};
}
test('WEB reload retries a lost acknowledgement with the original ID without double time',async()=>{
  const f=fixture(),first=f.create();await first.start();f.mode.lose=true;
  for(let i=0;i<10;i++)await first.step();
  assert.equal(f.accepted(),10000);const id=f.sent[0].playback_id;
  first.tracker.suspend();f.state.playing=false;
  const next=f.create();await next.start();await wait(()=>!next.tracker.busy);
  assert.equal(f.sent.at(-1).playback_id,id);assert.equal(f.sent.at(-1).elapsed_ms,10000);assert.equal(f.accepted(),10000);
  next.tracker.stop();
});
test('a track started without network survives reload and keeps its zero handshake',async()=>{
  const f=fixture();f.state.playing=false;const first=f.create();await first.start();
  f.mode.offline=true;f.state.playing=true;
  for(let i=0;i<12;i++)await first.step();
  const elapsed=first.tracker.current.elapsed_ms,id=first.tracker.current.playback_id;
  first.tracker.suspend();f.mode.offline=false;f.state.playing=false;
  const next=f.create();await next.start();await next.step();await wait(()=>!next.tracker.busy);
  assert.equal(f.sent.find(row=>row.playback_id===id).elapsed_ms,0);
  assert.equal(f.accepted(),elapsed);next.tracker.stop();
});
test('back-forward cache resume retains the current playback identity',async()=>{
  const f=fixture(),h=f.create();await h.start();for(let i=0;i<10;i++)await h.step();
  const id=h.tracker.current.playback_id;h.tracker.suspend();f.advance(60000);
  h.tracker.resume();await wait(()=>!h.tracker.settingsBusy&&!h.tracker.loadingJournal);
  await h.step();for(let i=0;i<10;i++)await h.step();
  assert.equal(h.tracker.current.playback_id,id);assert.equal(new Set(f.sent.map(row=>row.playback_id)).size,1);h.tracker.stop();
});
test('failed IndexedDB degrades to memory collection without blocking audio sampling',async()=>{
  const f=fixture();const h=f.create({load:async()=>{throw new Error('denied');},save:async()=>{throw new Error('quota');},clear:async()=>{}});
  await h.start();for(let i=0;i<10;i++)await h.step();assert.equal(f.accepted(),10000);h.tracker.stop();
});
test('an older server without a journal capability keeps the old in-memory protocol',async()=>{
  const f=fixture();f.mode.legacy=true;const h=f.create();await h.start();for(let i=0;i<10;i++)await h.step();
  assert.equal(f.accepted(),10000);assert.equal(f.sent[0].started_at_ms,undefined);
  assert.equal((await h.journal.transaction(scope,({rows})=>rows)).length,0);h.tracker.stop();
});
test('generation changes discard disk and memory counters instead of resurrecting them',async()=>{
  const f=fixture(),h=f.create();await h.start();for(let i=0;i<5;i++)await h.step();
  const old=h.tracker.current.playback_id;f.mode.generation=2;
  h.tracker.configure(f.settings());await wait(()=>!h.tracker.loadingJournal);
  assert.equal(h.tracker.entries.has(old),false);
  const rows=await h.journal.transaction(scope,({rows})=>rows);assert.ok(rows.every(row=>row.data.generation===2));h.tracker.stop();
});
test('logout ignores late IndexedDB restoration and never queues an old event',async()=>{
  const f=fixture();let release;
  const h=f.create({load:()=>new Promise(resolve=>{release=resolve;}),save:async()=>{},clear:async()=>{}});
  h.tracker.start();await wait(()=>Boolean(release));h.tracker.stop({revoke:true});
  release({entries:[{playback_id:randomUUID(),track_id:track,elapsed_ms:1000}]});await flush();
  assert.equal(h.tracker.entries.size,0);assert.equal(h.tracker.running,false);assert.equal(f.sent.length,0);
});
test('pagehide during recovery cannot overwrite the transferred journal with empty RAM',async()=>{
  const f=fixture();f.state.playing=false;const loads=[],saves=[];
  const h=f.create({load:()=>new Promise(resolve=>loads.push(resolve)),save:async(...args)=>saves.push(args),clear:async()=>{}});
  h.tracker.start();await wait(()=>loads.length===1);h.tracker.suspend();
  const id=randomUUID(),data={entries:[{playback_id:id,track_id:track,device_id:f.state.deviceId,started_at_ms:1800000000000,
    elapsed_ms:1000,acknowledged:0,started:true}]};
  loads[0](data);await flush();assert.equal(saves.length,0);
  h.tracker.resume();await wait(()=>loads.length===2);loads[1](data);await wait(()=>h.tracker.journalReady);
  assert.equal(h.tracker.entries.get(id)?.elapsed_ms,1000);h.tracker.stop();
});
test('another authenticated scope discards the previous account and accepts its lower generation',async()=>{
  const f=fixture();f.mode.generation=10;const h=f.create();await h.start();await h.step();
  const old=h.tracker.current.playback_id;f.advance(1000);f.mode.scope='b'.repeat(64);f.mode.generation=1;
  h.tracker.configure(f.settings());await wait(()=>!h.tracker.loadingJournal);
  assert.equal(h.tracker.generation,1);assert.equal(h.tracker.entries.has(old),false);assert.equal(h.tracker.scope,f.mode.scope);
  const rows=await h.journal.transaction(f.mode.scope,({rows})=>rows);assert.ok(rows.every(row=>row.scope===f.mode.scope));h.tracker.stop();
});
test('an abandoned tab is recovered by periodic settings refresh after its lease expires',async()=>{
  const f=fixture(),dead=f.create();await dead.start();f.mode.lose=true;for(let i=0;i<10;i++)await dead.step();
  const id=dead.tracker.current.playback_id;
  await dead.journal.save(scope,dead.tracker.snapshot());dead.tracker.running=false; // abrupt process loss: no pagehide release
  f.state.playing=false;const next=f.create();await next.start();assert.equal(next.tracker.entries.has(id),false);
  f.advance(61000);next.tracker.tick();await wait(()=>!next.tracker.settingsBusy&&!next.tracker.loadingJournal);
  next.tracker.tick();await flush();await wait(()=>!next.tracker.busy);
  assert.equal(f.sent.at(-1).playback_id,id);assert.equal(f.accepted(),10000);next.tracker.stop();
});
