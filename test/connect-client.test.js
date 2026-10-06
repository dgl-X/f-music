import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectClient, availableConnectDevices, remotePlaybackActive } from '../public/connect-client.js';

const storage=()=>{const values=new Map();return{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value))};};
const cryptoObject={randomUUID:()=> '01234567-89ab-cdef-0123-456789abcdef'};

test('WEB Connect switcher shows only online playback-ready devices', () => {
  const devices=availableConnectDevices([
    {id:'current',online:true,capabilities:{playback_ready:true}},
    {id:'old-tab',online:false,capabilities:{playback_ready:true}},
    {id:'not-ready',online:true,capabilities:{playback_ready:false}},
    {id:'legacy-ready',online:true,capabilities:{}},
  ]);
  assert.deepEqual(devices.map(device=>device.id),['current','legacy-ready']);
});

test('local media events yield the timeline while Connect plays remotely', () => {
  const client={enabled:true,deviceId:'web-here'};
  assert.equal(remotePlaybackActive(client,{active_device_id:'android-phone'}),true);
  assert.equal(remotePlaybackActive(client,{active_device_id:'web-here'}),false);
  assert.equal(remotePlaybackActive({...client,enabled:false},{active_device_id:'android-phone'}),false);
});

test('WEB Connect client keeps a stable per-tab opaque device id', () => {
  const memory=storage(),first=new ConnectClient({api:async()=>{},storage:memory,cryptoObject}),second=new ConnectClient({api:async()=>{},storage:memory,cryptoObject});
  assert.equal(first.deviceId,'web_0123456789abcdef0123456789abcdef');
  assert.equal(second.deviceId,first.deviceId);
});

test('WEB Connect client acknowledges handled commands and tracks revisions', async () => {
  const requests=[];
  const api=async(url,options={})=>{requests.push({url,options});if(url==='/api/v1/connect/status')return{enabled:true,poll_interval_ms:999999};if(url==='/api/v1/connect/devices')return{state:{revision:1}};if(url.startsWith('/api/v1/connect/commands?'))return{state:{revision:2},items:[{id:9,action:'pause',payload:{}}]};return{ok:true};};
  const states=[],client=new ConnectClient({api,storage:storage(),cryptoObject,onCommand:async command=>({success:command.action==='pause'}),onState:state=>states.push(state)});
  await client.start();client.stop();
  assert.equal(client.lastCommandId,9);
  assert.deepEqual(states,[{revision:1},{revision:2}]);
  assert.ok(requests.some(item=>item.url==='/api/v1/connect/commands/9/ack'&&JSON.parse(item.options.body).success));
});

test('WEB Connect client retries a command when its acknowledgement is lost', async () => {
  let acknowledgements=0,executions=0;
  const api=async url=>{
    if(url.startsWith('/api/v1/connect/commands?'))return{state:{revision:3},items:[{id:12,action:'play',payload:{}}]};
    if(url==='/api/v1/connect/commands/12/ack'){acknowledgements++;throw new Error('network lost');}
    return{};
  };
  const client=new ConnectClient({api,storage:storage(),cryptoObject,onCommand:async()=>{executions++;return{success:true};}});
  client.enabled=true;
  await client.poll();await client.poll();
  assert.equal(client.lastCommandId,0);
  assert.equal(acknowledgements,2);
  assert.equal(executions,1);
});

test('WEB Connect client ignores state responses older than the current revision', () => {
  const states=[],client=new ConnectClient({api:async()=>{},storage:storage(),cryptoObject,onState:state=>states.push(state.revision)});
  assert.equal(client.acceptState({revision:8,track_id:'new'}),true);
  assert.equal(client.acceptState({revision:8,track_id:'duplicate'}),false);
  assert.equal(client.acceptState({revision:7,track_id:'old'}),false);
  assert.equal(client.state.track_id,'new');
  assert.deepEqual(states,[8]);
});

test('WEB Connect client serializes state writes so responses cannot overtake each other', async () => {
  const order=[];
  const api=async(url,options)=>{
    const trackId=JSON.parse(options.body).track_id;order.push(`start:${trackId}`);
    if(trackId==='first')await new Promise(resolve=>setTimeout(resolve,10));
    order.push(`end:${trackId}`);return{revision:trackId==='first'?1:2,track_id:trackId};
  };
  const client=new ConnectClient({api,storage:storage(),cryptoObject});client.enabled=true;
  await Promise.all([client.updateState({track_id:'first'}),client.updateState({track_id:'second'})]);
  assert.deepEqual(order,['start:first','end:first','start:second','end:second']);
  assert.equal(client.state.track_id,'second');
});

test('WEB Connect client stops polling when the server disables the feature', async () => {
  const error=Object.assign(new Error('disabled'),{status:404,code:'connect_disabled'});
  const client=new ConnectClient({api:async()=>{throw error;},storage:storage(),cryptoObject});client.enabled=true;
  await client.poll();
  assert.equal(client.enabled,false);
});

test('WEB Connect state writes use the latest accepted playback epoch', async () => {
  let body;
  const client=new ConnectClient({api:async(url,options)=>{body=JSON.parse(options.body);return{revision:12,playback_epoch:4};},storage:storage(),cryptoObject});
  client.enabled=true;client.acceptState({revision:11,playback_epoch:4});
  await client.updateState({track_id:'track-4',playback_epoch:1});
  assert.equal(body.playback_epoch,4);
});

test('WEB Connect client acknowledges but does not execute a command from an old epoch', async () => {
  let executions=0,acknowledgement;
  const api=async(url,options={})=>{
    if(url.startsWith('/api/v1/connect/commands?'))return{state:{revision:15,playback_epoch:7},items:[{id:31,action:'next',payload:{playback_epoch:6}}]};
    if(url==='/api/v1/connect/commands/31/ack'){acknowledgement=JSON.parse(options.body);return{state:{revision:15,playback_epoch:7}};}
    return{};
  };
  const client=new ConnectClient({api,storage:storage(),cryptoObject,onCommand:async()=>{executions++;return{success:true};}});client.enabled=true;
  await client.poll();
  assert.equal(executions,0);
  assert.equal(acknowledgement.success,false);
  assert.match(acknowledgement.result.error,/эпоха/i);
});
