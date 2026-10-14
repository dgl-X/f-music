import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createConnectEvents } from '../src/connect-events.js';
import { createConnectService } from '../src/connect-service.js';

const deviceId='web_0123456789abcdef';
function connection(){
  const req=new EventEmitter(),res=new EventEmitter();
  Object.assign(res,{frames:[],headers:null,writableLength:0,writeHead(status,headers){this.status=status;this.headers=headers;},write(frame){this.frames.push(frame);return true;},end(){this.writableEnded=true;this.emit('close');},destroy(){this.destroyed=true;this.emit('close');}});
  return{req,res};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const access={userId:1,sessionId:10,deviceId};

test('SSE starts with resync, isolates accounts and never sends commands or queue data',async t=>{
  const events=createConnectEvents({enabled:true,authorize:async()=>true});t.after(events.close);
  const a=connection(),b=connection();await events.open(a.req,a.res,access);await events.open(b.req,b.res,{...access,userId:2});
  assert.equal(a.res.headers['Content-Type'],'text/event-stream; charset=utf-8');assert.equal(a.res.headers['X-Accel-Buffering'],'no');
  assert.match(a.res.frames[0],/retry: 1500\nevent: resync\ndata: \{\}/);
  events.notify(1);await tick();assert.equal(a.res.frames.length,2);assert.equal(b.res.frames.length,1);
  assert.equal(a.res.frames[1],'event: resync\ndata: {}\n\n');
});

test('SSE rejects invalid, unauthorized and over-limit subscriptions without opening streams',async t=>{
  const events=createConnectEvents({enabled:true,authorize:async input=>input.sessionId===10,maxPerUser:1});t.after(events.close);
  for(const [input,status] of [[{...access,deviceId:'bad'},400],[{...access,sessionId:11},403]]){
    const c=connection();assert.equal((await events.open(c.req,c.res,input)).status,status);assert.equal(c.res.headers,null);
  }
  const first=connection();await events.open(first.req,first.res,access);
  const other=connection();assert.equal((await events.open(other.req,other.res,access)).status,429);assert.equal(events.size(),1);
  first.res.emit('close');assert.equal(events.size(),0);
});

test('SSE revalidates revoked access, closes slow consumers and coalesces bursts',async t=>{
  let allowed=true,checks=0;
  const events=createConnectEvents({enabled:true,authorize:async()=>{checks++;return allowed;}});t.after(events.close);
  const c=connection();await events.open(c.req,c.res,access);
  for(let i=0;i<100;i++)events.notify(1);
  await tick();assert.equal(checks,2);assert.equal(c.res.frames.length,2);
  allowed=false;events.notify(1);await tick();assert.equal(events.size(),0);assert.equal(c.res.writableEnded,true);assert.equal(c.res.frames.length,2);
  allowed=true;const slow=connection();await events.open(slow.req,slow.res,access);slow.res.write=()=>false;
  events.notify(1);await tick();assert.equal(slow.res.destroyed,true);assert.equal(events.size(),0);
});

test('SSE disconnect before queued authorization cannot write a late frame',async t=>{
  const events=createConnectEvents({enabled:true,authorize:async()=>true});t.after(events.close);
  const c=connection();await events.open(c.req,c.res,access);
  // A disconnected response is cleaned before queued notification work executes.
  events.notify(1);c.res.emit('close');await tick();assert.equal(c.res.frames.length,1);assert.equal(events.size(),0);
});

test('SSE periodically reconciles and rotates connections without leaking timers',async()=>{
  const events=createConnectEvents({enabled:true,authorize:async()=>true,heartbeatMs:5,lifetimeMs:35});
  const c=connection();await events.open(c.req,c.res,access);
  await new Promise(resolve=>setTimeout(resolve,60));assert.ok(c.res.frames.length>1);assert.equal(events.size(),0);assert.equal(c.res.writableEnded,true);
  events.close();
});

test('SSE frames arrive over actual HTTP before the response is ended',async t=>{
  const events=createConnectEvents({enabled:true,authorize:async()=>true});
  const server=createServer(async(req,res)=>{await events.open(req,res,access);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const abort=new AbortController();t.after(async()=>{abort.abort();events.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const response=await fetch(`http://127.0.0.1:${server.address().port}`,{signal:abort.signal});
  assert.equal(response.status,200);const reader=response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/event: resync/);
  events.notify(1);assert.match(new TextDecoder().decode((await reader.read()).value),/event: resync/);
});

test('Connect notifies only after commit, never after rollback or invalid commands',async()=>{
  let committed=false,fail=false;const hints=[];
  const tx={prepare(sql){return{async get(){if(sql.startsWith('SELECT id FROM connect_devices'))return{id:deviceId};if(sql.startsWith('SELECT active_device_id'))return{active_device_id:deviceId};if(sql.startsWith('INSERT INTO connect_commands'))return{id:1};}};}};
  const db={async transaction(fn){const value=await fn(tx);if(fail)throw new Error('rollback');committed=true;return value;}};
  const connect=createConnectService({db,enabled:true,onChange:id=>{assert.equal(committed,true);hints.push(id);}});
  assert.equal((await connect.sendCommand(1,deviceId,'next')).status,'ok');assert.deepEqual(hints,[1]);
  fail=true;await assert.rejects(connect.sendCommand(1,deviceId,'next'),/rollback/);assert.deepEqual(hints,[1]);
  assert.equal((await connect.sendCommand(1,deviceId,'unknown')).status,'invalid');assert.deepEqual(hints,[1]);
});

test('event authorization binds device, session, account, expiry and personal switch',async()=>{
  const calls=[];const db={prepare(sql){return{async get(...params){calls.push({sql,params});return{id:deviceId};}};}};
  const service=createConnectService({db,enabled:true});assert.equal(await service.authorizeEvents(access),true);
  assert.deepEqual(calls[0].params,[deviceId,1,10]);
  for(const pattern of [/s.user_id=d.user_id/,/d.user_id=\?/,/d.revoked_at IS NULL/,/s.id=\?/,/s.expires_at>CURRENT_TIMESTAMP/,/COALESCE\(p.enabled,TRUE\)=TRUE/])assert.match(calls[0].sql,pattern);
  assert.equal(await service.authorizeEvents({...access,sessionId:null}),false);
  assert.equal(await createConnectService({db,enabled:false}).authorizeEvents(access),false);assert.equal(calls.length,1);
});
