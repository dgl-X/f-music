import test from 'node:test';
import assert from 'node:assert/strict';
import {ListeningTracker} from '../public/listening-tracker.js';
const track='11111111-1111-4111-8111-111111111111';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(options={}){
  let clock=0,id=0;
  const state={trackId:track,positionSeconds:0,playing:true,executing:true,rate:1};
  const sent=[],stored=new Map();let accepted=0,lose=false;
  const tracker=new ListeningTracker({sample:()=>({...state}),now:()=>clock,
    uuid:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`,schedule:()=>1,cancel:()=>{},
    api:async(url,request)=>{
      if(!request)return{enabled:options.enabled!==false,generation:1};
      const body=JSON.parse(request.body);sent.push(body);
      if(options.offline)throw new Error('offline');
      if(options.badAck)return{status:'ok',elapsed_ms:-1};
      const previous=stored.get(body.playback_id)||0;
      accepted+=Math.max(0,body.elapsed_ms-previous);stored.set(body.playback_id,Math.max(previous,body.elapsed_ms));
      if(lose){lose=false;throw new Error('ACK lost');}
      return{status:'ok',elapsed_ms:stored.get(body.playback_id)};
    }});
  tracker.start();await flush();tracker.tick();await flush();
  return{tracker,state,sent,stored,accepted:()=>accepted,lose:()=>{lose=true;},
    async step(ms=1000,advance=ms/1000){clock+=ms;state.positionSeconds+=advance;tracker.tick();await flush();}};
}

test('WEB cumulative tracker records advancing playback, not timer ticks or download duration',async()=>{
  const h=await harness();assert.equal(h.sent[0].elapsed_ms,0);
  for(let i=0;i<10;i++)await h.step();assert.equal(h.accepted(),10000);
  for(let i=0;i<10;i++)await h.step(1000,0);
  h.tracker.finish();await flush();assert.equal(h.accepted(),10000);
});
test('pause, remote control, buffering and seek gaps do not become measured time',async()=>{
  const h=await harness();await h.step();
  h.state.playing=false;for(let i=0;i<5;i++)await h.step(1000,0);
  h.state.playing=true;await h.step();await h.step();
  h.state.executing=false;for(let i=0;i<5;i++)await h.step();
  h.state.executing=true;await h.step();await h.step();
  h.tracker.interrupt();await h.step(1000,90);await h.step();
  h.tracker.finish();await flush();assert.equal(h.accepted(),4000);
});
test('long suspended intervals are discarded and playback speed does not multiply wall time',async()=>{
  const h=await harness();await h.step(30000,30);h.state.rate=2;
  await h.step(1000,2);await h.step(1000,2);h.tracker.finish();await flush();assert.equal(h.accepted(),1000);
});
test('lost ACK retries the same playback identity and cumulative counter without double credit',async()=>{
  const h=await harness();h.lose();for(let i=0;i<13;i++)await h.step();
  h.tracker.finish();await flush();assert.equal(h.accepted(),13000);
  assert.equal(new Set(h.sent.map(item=>item.playback_id)).size,1);
  assert.ok(h.sent.filter(item=>item.elapsed_ms>0).length>=2);
});
test('same-track repeat gets a new identity, while seek and pause retain the current one',async()=>{
  const h=await harness();await h.step();h.tracker.interrupt();await h.step(1000,-1);await h.step();
  h.tracker.finish();await flush();h.state.positionSeconds=0;h.tracker.tick();await flush();await h.step();
  h.tracker.finish();await flush();assert.equal(new Set(h.sent.map(item=>item.playback_id)).size,2);assert.equal(h.accepted(),3000);
});
test('disabled collection never starts a session and logout discards memory and queued requests',async()=>{
  const h=await harness({enabled:false});await h.step();assert.equal(h.sent.length,0);
  h.tracker.configure({enabled:true,generation:2});h.tracker.tick();h.tracker.stop();await flush();
  assert.equal(h.sent.length,0);assert.equal(h.tracker.entries.size,0);assert.equal(h.tracker.enabled,false);
});
test('clear generation discards pending counters and ignores stale preference responses',async()=>{
  const h=await harness();await h.step();const old=h.sent[0].playback_id;
  h.tracker.configure({enabled:true,generation:2});h.tracker.configure({enabled:false,generation:1});
  assert.equal(h.tracker.generation,2);assert.equal(h.tracker.enabled,true);
  h.tracker.tick();await flush();assert.notEqual(h.sent.at(-1).playback_id,old);assert.equal(h.sent.at(-1).elapsed_ms,0);
});
test('memory queue is bounded and failed collection cannot block playback sampling',async()=>{
  const h=await harness({offline:true});
  for(let i=0;i<40;i++){h.state.trackId=`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`;await h.step();}
  assert.ok(h.tracker.entries.size<=16);h.tracker.stop();assert.equal(h.tracker.entries.size,0);
});
test('malformed acknowledgements back off instead of spinning requests',async()=>{
  const h=await harness({badAck:true});assert.equal(h.sent.length,1);
  await h.step();assert.equal(h.sent.length,1);await h.step();assert.equal(h.sent.length,2);
  h.tracker.stop();
});
test('sub-millisecond remainders do not accumulate rounding drift or fractional counters',async()=>{
  const h=await harness();for(let i=0;i<10;i++)await h.step(1000.4,1.0004);
  h.tracker.finish();await flush();
  // Flooring a floating-point monotonic clock may lose <1 ms, not 1 ms per tick.
  assert.ok(Math.abs(h.accepted()-10004)<=1);assert.ok(h.sent.every(item=>Number.isInteger(item.elapsed_ms)));
});
