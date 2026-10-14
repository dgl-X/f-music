import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { checkWebConnectEvents } from './connect-web-sse-integration.mjs';

const databaseUrl=process.env.CONNECT_TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('CONNECT_TEST_DATABASE_URL is required');

const port=Number(process.env.CONNECT_TEST_PORT||18097),origin=`http://127.0.0.1:${port}`;
const storageDir=fs.mkdtempSync(path.join(os.tmpdir(),'family-music-connect-test-'));
const username='connect-integration',password=['connect','integration',String(process.pid)].join('-');
let server;

async function waitFor(check,message,timeoutMs=15000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){try{if(await check())return;}catch{}await delay(100);}
  throw new Error(message);
}

async function run(command,args,env={}){
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,...env},stdio:'inherit'});
    child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} exited with ${code??signal}`)));
  });
}

async function startApi(){
  server=spawn(process.execPath,['src/server.js'],{
    cwd:path.resolve(import.meta.dirname,'..'),
    env:{...process.env,DATABASE_URL:databaseUrl,MUSIC_HOST:'127.0.0.1',MUSIC_PORT:String(port),MUSIC_STORAGE_DIR:storageDir,MUSIC_CONNECT_ENABLED:'true',MUSIC_CONNECT_EVENTS_ENABLED:'true'},
    stdio:['ignore','pipe','pipe'],
  });
  server.stdout.pipe(process.stdout);server.stderr.pipe(process.stderr);
  await waitFor(async()=>{const response=await fetch(`${origin}/api/v1/health`);return response.ok;},'Connect test API did not start');
}

async function stopApi(){
  if(server&&!server.killed){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(3000)]);}
}

async function request(pathname,cookie,method='GET',body){
  const response=await fetch(`${origin}/api/v1${pathname}`,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';',1)[0]};
}

try{
  await startApi();
  const setup=await fetch(`${origin}/api/v1/setup`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username,display_name:'Connect Integration',password,library_name:'Connect Integration',recognition_enabled:false})});
  assert.equal(setup.status,201,await setup.text());
  await run(process.execPath,['scripts/connect-smoke.mjs'],{CONNECT_TEST_ORIGIN:origin,CONNECT_TEST_USERNAME:username,CONNECT_TEST_PASSWORD:password});
  const first=await request('/login',null,'POST',{username,password});assert.equal(first.status,200);
  const faults=new pg.Pool({connectionString:databaseUrl});
  const source='connect_fault_source',target='connect_fault_target';
  try{
    for(const id of [source,target])assert.equal((await request('/connect/devices',first.cookie,'POST',{id,name:'Fault test',client_type:'web',capabilities:{playback:true,playback_ready:true,transfer_prepare:true}})).status,200);
    const original=await request('/connect/state',first.cookie,'PUT',{device_id:source,track_id:'fault-track',queue:['fault-track'],playing:true});assert.equal(original.status,200);
    const transfer=await request('/connect/transfer',first.cookie,'POST',{source_device_id:source,target_device_id:target,state:{...original.data}});assert.equal(transfer.status,202);
    const delivered=await request(`/connect/commands?device_id=${target}&after=0`,first.cookie);
    const command=delivered.data.items.find(item=>item.action==='transfer');assert.ok(command);
    await faults.query('UPDATE connect_commands SET expires_at=CURRENT_TIMESTAMP-INTERVAL \'1 second\' WHERE id=$1',[command.id]);
    assert.equal((await request(`/connect/commands/${command.id}/ack`,first.cookie,'POST',{device_id:target,success:true,result:{state:{playing:false}}})).status,409);
    assert.equal((await request('/connect/state',first.cookie)).data.active_device_id,source);
    await faults.query('UPDATE connect_devices SET last_seen_at=CURRENT_TIMESTAMP-INTERVAL \'60 seconds\' WHERE id=$1',[source]);
    const released=await request(`/connect/commands?device_id=${target}&after=0`,first.cookie);
    assert.equal(released.data.state.active_device_id,null);assert.equal(released.data.state.playing,false);
    const resumed=await request('/connect/state',first.cookie,'PUT',{device_id:target,track_id:'fault-track',playing:false});
    assert.equal(resumed.status,200);assert.ok(resumed.data.playback_epoch>original.data.playback_epoch);
    console.log('Connect faults: expired transfer ACK, offline owner release and new epoch OK');
  }finally{
    for(const id of [source,target])await request(`/connect/devices/${id}`,first.cookie,'DELETE');
    await faults.end();
  }
  const secondaryName='connect-secondary';
  const created=await request('/users',first.cookie,'POST',{username:secondaryName,display_name:'Connect Secondary',password});assert.equal(created.status,201);
  const second=await request('/login',null,'POST',{username:secondaryName,password});assert.equal(second.status,200);
  await checkWebConnectEvents({origin,cookie:first.cookie});
  const streamDevices=['sse_primary_device','sse_secondary_device'],streams=[];
  async function subscribe(cookie,device){
    const abort=new AbortController();
    const response=await fetch(`${process.env.CONNECT_TEST_EVENTS_ORIGIN||origin}/api/v1/connect/events?device_id=${device}`,{headers:{Cookie:cookie,'Last-Event-ID':'untrusted-old-cursor'},signal:abort.signal});
    assert.equal(response.status,200);const reader=response.body.getReader();
    const stream={abort,frames:'',ended:false};streams.push(stream);
    stream.done=(async()=>{try{for(;;){const item=await reader.read();if(item.done)break;stream.frames+=new TextDecoder().decode(item.value);}}catch(error){if(!abort.signal.aborted)throw error;}finally{stream.ended=true;}})();
    await waitFor(()=>stream.frames.includes('event: resync'),'SSE initial resync missing');return stream;
  }
  try{
    for(const [index,cookie] of [first.cookie,second.cookie].entries())assert.equal((await request('/connect/devices',cookie,'POST',{id:streamDevices[index],name:'SSE integration',client_type:'web'})).status,200);
    assert.equal((await fetch(`${origin}/api/v1/connect/events?device_id=${streamDevices[0]}`)).status,401);
    assert.equal((await fetch(`${origin}/api/v1/connect/events?device_id=${streamDevices[0]}`,{headers:{Cookie:second.cookie}})).status,403);
    assert.deepEqual((await request('/connect/status',first.cookie)).data.transports,['sse','polling']);
    const a=await subscribe(first.cookie,streamDevices[0]),b=await subscribe(second.cookie,streamDevices[1]);
    const before=a.frames.length,otherBefore=b.frames.length;
    const claim=await request('/connect/state',first.cookie,'PUT',{device_id:streamDevices[0],track_id:'sse-track',queue:['sse-track'],playing:true});assert.equal(claim.status,200);
    await waitFor(()=>a.frames.length>before,'SSE state hint missing');
    const temporaryLogin=await request('/login',null,'POST',{username,password});assert.equal(temporaryLogin.status,200);
    const loggedOut=await subscribe(temporaryLogin.cookie,streamDevices[0]);
    assert.equal((await request('/logout',temporaryLogin.cookie,'POST')).status,200);
    const afterState=a.frames.length;
    const command=await request('/connect/commands',first.cookie,'POST',{source_device_id:streamDevices[0],action:'next'});assert.equal(command.status,202);
    await waitFor(()=>a.frames.length>afterState,'SSE committed command hint missing');
    await waitFor(()=>loggedOut.ended,'Revoked session still received SSE hints');
    const pending=await request(`/connect/commands?device_id=${streamDevices[0]}&after=0`,first.cookie);assert.equal(pending.data.items[0].id,command.data.command_id);
    a.abort.abort();await a.done;
    const reconnected=await subscribe(first.cookie,streamDevices[0]);
    assert.equal((await request(`/connect/commands?device_id=${streamDevices[0]}&after=0`,first.cookie)).data.items[0].id,command.data.command_id);
    await delay(150);assert.equal(b.frames.length,otherBefore,'SSE leaked another account event');
    assert.equal((await request('/connect/settings',first.cookie,'PUT',{enabled:false})).status,200);
    await waitFor(()=>reconnected.ended,'Personal switch did not close SSE');
    assert.equal((await request('/connect/settings',first.cookie,'PUT',{enabled:true})).status,200);
    console.log('SSE: authenticated HTTP, account isolation, committed hint, reconnect and durable pending command, personal disable OK');
  }finally{
    for(const stream of streams)stream.abort.abort();await Promise.all(streams.map(stream=>stream.done));
    for(const [index,cookie] of [first.cookie,second.cookie].entries())await request(`/connect/devices/${streamDevices[index]}`,cookie,'DELETE');
  }
  assert.equal((await request('/connect/settings',first.cookie)).data.enabled,true);
  const disabled=await request('/connect/settings',first.cookie,'PUT',{enabled:false,user_id:created.data.id});assert.equal(disabled.status,200);
  assert.equal(disabled.data.user_enabled,false);
  assert.equal((await request('/connect/devices',first.cookie)).status,404);
  assert.equal((await request('/connect/status',second.cookie)).data.enabled,true);
  assert.equal((await request('/me',first.cookie)).status,200);
  await stopApi();await startApi();
  assert.equal((await request('/connect/settings',first.cookie)).data.user_enabled,false);
  assert.equal((await request('/connect/status',second.cookie)).data.enabled,true);
  const restored=await request('/connect/settings',first.cookie,'PUT',{enabled:true});assert.equal(restored.status,200);
  const state=await request('/connect/state',first.cookie);assert.equal(state.data.active_device_id,null);assert.equal(state.data.playing,false);
  const secondaryOff=await request('/connect/settings',second.cookie,'PUT',{enabled:false});assert.equal(secondaryOff.status,200);
  assert.equal((await request('/connect/status',first.cookie)).data.enabled,true);
  assert.equal((await request('/connect/status',second.cookie)).data.enabled,false);
  console.log('Personal Connect settings: isolation, restart and reenable OK');
}finally{
  await stopApi();
  fs.rmSync(storageDir,{recursive:true,force:true});
}
