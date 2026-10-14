import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectEventsClient } from '../public/connect-events-client.js';
import { ConnectClient } from '../public/connect-client.js';

const status={enabled:true,transports:['sse','polling'],events_url:'/api/v1/connect/events',events_heartbeat_ms:15000,poll_interval_ms:999999};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function sources(){
  const items=[];
  return{items,factory(url){const listeners=new Map();const source={url,closed:false,addEventListener(name,fn){listeners.set(name,fn);},close(){this.closed=true;},emit(name){listeners.get(name)?.({data:'{}'});}};items.push(source);return source;}};
}
function fixture({api:extra,onCommand,onState}={}){
  const stream=sources(),values=new Map();let now=0,polls=0;
  const requests=[];
  const client=new ConnectClient({api:async(url,options)=>{
    requests.push({url,method:options?.method||'GET'});
    if(extra){const result=await extra(url,options);if(result!==undefined)return result;}
    if(url.endsWith('/status'))return status;
    if(url.endsWith('/devices'))return{state:{revision:1,playback_epoch:1}};
    if(url.includes('/commands?')){polls++;return{state:{revision:1,playback_epoch:1},items:[]};}
    return{};
  },storage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},cryptoObject:{randomUUID:()=> '01234567-89ab-cdef-0123-456789abcdef'},eventSourceFactory:stream.factory,now:()=>now,onCommand,onState});
  return{client,stream,requests,polls:()=>polls,time:value=>{now=value;}};
}

test('SSE URLs must be the declared same-origin route and contain only a device id',()=>{
  const stream=sources(),events=new ConnectEventsClient({factory:stream.factory,now:()=>0});
  for(const events_url of ['https://other.test/events','//other.test/events','/api/v1/connect/events?token=secret','/api/v1/connect/events#hash'])events.configure({...status,events_url},'device');
  events.configure({...status,transports:{}},'device');assert.equal(stream.items.length,0);
  events.configure(status,'device with spaces');assert.equal(stream.items[0].url,'/api/v1/connect/events?device_id=device%20with%20spaces');events.close();
});

test('SSE coalesces a burst into one read and healthy streams replace fast polling',async t=>{
  const f=fixture();t.after(()=>f.client.stop());await f.client.start();
  const source=f.stream.items[0],before=f.polls();source.emit('open');for(let i=0;i<100;i++)source.emit('resync');
  await flush();assert.equal(f.polls(),before+1);assert.equal(f.client.events.healthy,true);
  f.time(1000);f.client.tick();await flush();assert.equal(f.polls(),before+1);
});

test('SSE error immediately falls back to polling, uses backoff and ignores retired sources',async t=>{
  const f=fixture();t.after(()=>f.client.stop());await f.client.start();
  const first=f.stream.items[0];first.emit('resync');await flush();const before=f.polls();
  first.emit('error');await flush();assert.equal(first.closed,true);assert.equal(f.client.events.healthy,false);assert.equal(f.polls(),before+1);
  f.time(1000);f.client.tick();await flush();assert.equal(f.stream.items.length,1);assert.equal(f.polls(),before+2);
  f.time(1500);f.client.tick();await flush();assert.equal(f.stream.items.length,2);
  first.emit('resync');assert.equal(f.client.events.healthy,false);
  f.stream.items[1].emit('resync');await flush();assert.equal(f.client.events.healthy,true);
});

test('silent streams trigger the watchdog and heartbeat resync keeps the watchdog alive',()=>{
  const stream=sources();let now=0,hints=0;
  const events=new ConnectEventsClient({factory:stream.factory,now:()=>now,onHint:()=>hints++});
  events.configure(status,'device');const first=stream.items[0];first.emit('resync');
  now=40000;first.emit('resync');now=80000;events.tick();assert.equal(first.closed,false);
  now=86000;events.tick();assert.equal(first.closed,true);assert.equal(events.healthy,false);assert.equal(hints,3);events.close();
});

test('logout and disabled capability close the stream and discard queued hints',async()=>{
  const f=fixture();await f.client.start();const source=f.stream.items[0];source.emit('resync');f.client.stop();
  const before=f.polls();source.emit('open');source.emit('resync');source.emit('error');await flush();assert.equal(f.polls(),before);assert.equal(source.closed,true);
  const stream=sources(),events=new ConnectEventsClient({factory:stream.factory});events.configure(status,'device');events.configure({...status,enabled:false},'device');assert.equal(stream.items[0].closed,true);assert.equal(events.url,'');
});

test('a legacy server, unsupported browser or failed constructor retains polling',async t=>{
  for(const options of [{eventSourceFactory:null},{eventSourceFactory:()=>{throw new Error('blocked');}}]){
    const stream=new ConnectEventsClient({factory:options.eventSourceFactory,now:()=>0});stream.configure(status,'device');assert.equal(stream.healthy,false);stream.close();
  }
  const f=fixture({api:async url=>url.endsWith('/status')?{enabled:true,poll_interval_ms:999999}:undefined});t.after(()=>f.client.stop());await f.client.start();
  f.client.tick();await flush();assert.equal(f.stream.items.length,0);assert.equal(f.polls(),2);
});

test('hints during command preparation do not execute concurrently and lost ACK retries only the ACK',async t=>{
  let finish,executions=0,acks=0,reads=0;
  const f=fixture({api:async url=>{
    if(url.includes('/commands?')){reads++;return{state:{revision:1,playback_epoch:1},items:reads<=3?[{id:10,action:'next',payload:{playback_epoch:1}}]:[]};}
    if(url.endsWith('/ack')){acks++;if(acks===1)throw new Error('lost ACK');return{state:{revision:2,playback_epoch:1}};}
  },onCommand:()=>{executions++;return new Promise(resolve=>{finish=resolve;});}});t.after(()=>f.client.stop());
  // Initial availability may itself deliver a command. Resolve it before start finishes.
  const started=f.client.start();await flush();assert.equal(executions,1);assert.equal(acks,0);
  for(let i=0;i<20;i++)f.client.requestPoll();await flush();assert.equal(reads,1);
  finish({success:true});await started;await flush();
  assert.equal(executions,1);assert.equal(acks,2);
  f.client.requestPoll();await flush();assert.equal(executions,1);assert.equal(f.client.lastCommandId,10);
});

test('own state hints only read the API and do not publish a feedback loop',async t=>{
  let revision=1,writes=0;let f;
  f=fixture({api:async(url,options)=>{
    if(url.endsWith('/state')&&options?.method==='PUT'){writes++;f.stream.items[0].emit('resync');return{revision:++revision,playback_epoch:1,active_device_id:f.client.deviceId};}
    if(url.includes('/commands?'))return{state:{revision,playback_epoch:1,active_device_id:f.client.deviceId},items:[]};
  }});t.after(()=>f.client.stop());await f.client.start();
  await f.client.updateState({playing:true,track_id:'track'});await flush();await flush();assert.equal(writes,1);assert.equal(f.client.events.healthy,true);
  for(let i=0;i<10;i++)f.stream.items[0].emit('resync');await flush();assert.equal(writes,1);
});

test('SSE authorization failure stops the transport and does not run late commands',async t=>{
  let loggedOut=false;
  const f=fixture({api:async url=>{if(loggedOut&&url.includes('/commands?'))throw Object.assign(new Error('not signed in'),{status:401});}});t.after(()=>f.client.stop());await f.client.start();
  const source=f.stream.items[0];loggedOut=true;source.emit('resync');await flush();assert.equal(f.client.enabled,false);assert.equal(source.closed,true);
});

test('enabled clients periodically discover disabling SSE and keep Connect available',async t=>{
  let available=true;
  const f=fixture({api:async url=>url.endsWith('/status')?(available?status:{enabled:true,poll_interval_ms:999999}):undefined});t.after(()=>f.client.stop());await f.client.start();
  f.stream.items[0].emit('resync');await flush();available=false;f.time(16000);f.client.tick();await flush();
  assert.equal(f.stream.items[0].closed,true);assert.equal(f.client.enabled,true);assert.equal(f.client.events.healthy,false);
});

test('REST failure falls back even with a live stream and cannot spin an immediate retry loop',async t=>{
  let broken=false,reads=0;
  const f=fixture({api:async url=>{if(url.includes('/commands?')){reads++;if(broken)throw Object.assign(new Error('server error'),{status:500});}}});t.after(()=>f.client.stop());await f.client.start();
  const source=f.stream.items[0];source.emit('resync');await flush();const before=reads;
  broken=true;source.emit('resync');await flush();await flush();assert.equal(source.closed,true);assert.equal(f.client.events.healthy,false);assert.equal(reads,before+2);
  broken=false;f.time(1000);f.client.tick();await flush();assert.equal(f.client.connection,'connected');
});

test('stopping during startup cannot leave a timer or a late EventSource',async()=>{
  let finish;
  const f=fixture({api:async url=>url.endsWith('/status')?new Promise(resolve=>{finish=resolve;}):undefined});
  const started=f.client.start();f.client.stop();finish(status);await started;
  assert.equal(f.client.timer,null);assert.equal(f.client.enabled,false);assert.equal(f.stream.items.length,0);
});
