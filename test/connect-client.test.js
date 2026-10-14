import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectClient, availableConnectDevices, remotePlaybackActive } from '../public/connect-client.js';

const storage=()=>{const values=new Map();return{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value))};};
const cryptoObject={randomUUID:()=> '01234567-89ab-cdef-0123-456789abcdef'};

test('a disabled client notices reenabling without automatically playing music',async()=>{
  let available=false,executions=0;const changes=[];
  const client=new ConnectClient({storage:storage(),cryptoObject,onAvailability:value=>changes.push(value),onCommand:async()=>{executions++;},api:async url=>{
    if(url==='/api/v1/connect/status')return{enabled:available,poll_interval_ms:999999};
    if(url==='/api/v1/connect/devices')return{state:{revision:1,active_device_id:null}};
    return{state:{revision:1,active_device_id:null},items:[]};
  }});
  try{
    assert.equal(await client.start(),false);assert.equal(client.running,true);
    available=true;await client.refreshAvailability();
    assert.equal(client.enabled,true);assert.deepEqual(changes,[true]);assert.equal(executions,0);
  }finally{client.stop();}
});

test('late commands fetched before disabling are discarded',async()=>{
  let finish,executions=0;
  const client=new ConnectClient({storage:storage(),cryptoObject,onCommand:async()=>{executions++;},api:()=>new Promise(resolve=>{finish=resolve;})});
  client.enabled=true;client.running=true;
  const polling=client.poll();client.suspend();
  finish({state:{revision:9,active_device_id:'other'},items:[{id:1,action:'play',payload:{}}]});
  await polling;assert.equal(executions,0);assert.equal(client.state,null);assert.equal(client.enabled,false);client.stop();
});

test('reenabling does not let a paused device claim the active player',async()=>{
  const client=new ConnectClient({storage:storage(),cryptoObject,api:async()=>assert.fail('Paused device claimed playback')});
  client.enabled=true;client.acceptState({revision:1,active_device_id:null,playback_epoch:2});
  await client.updateState({track_id:'old-phone-track',playing:false});
  assert.equal(client.state.active_device_id,null);
});

test('Connect never relabels an old queued snapshot with a new ownership epoch', async () => {
  let finishFirst;const bodies=[];
  const client=new ConnectClient({api:async(url,options)=>{const body=JSON.parse(options.body);bodies.push(body);await new Promise(resolve=>{finishFirst=resolve;});return{revision:3,playback_epoch:2};},storage:storage(),cryptoObject});
  client.enabled=true;client.acceptState({revision:1,playback_epoch:1});
  const first=client.updateState({track_id:'first'});
  const queued=client.updateState({track_id:'obsolete'});
  await new Promise(resolve=>setTimeout(resolve,0));
  client.acceptState({revision:2,playback_epoch:2});finishFirst();
  await Promise.all([first,queued]);
  assert.equal(bodies.length,1);assert.equal(bodies[0].playback_epoch,1);
});

test('Connect does not ACK transfer while the target is still preparing', async () => {
  let finish;let acknowledgements=0;
  const client=new ConnectClient({storage:storage(),cryptoObject,api:async(url)=>{
    if(url.includes('commands?'))return{state:{revision:1,playback_epoch:1},items:[{id:1,action:'transfer',payload:{playback_epoch:2}}]};
    acknowledgements++;return{};
  },onCommand:()=>new Promise(resolve=>{finish=resolve;})});
  client.enabled=true;
  const polling=client.poll();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(acknowledgements,0);finish({success:true,result:{state:{playing:false}}});await polling;
  assert.equal(acknowledgements,1);
});

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

test('disabling Connect during command execution discards the late result and ACK', async () => {
  let complete,started,acks=0;
  const entered=new Promise(resolve=>{started=resolve;});
  const client=new ConnectClient({storage:storage(),cryptoObject,api:async url=>{
    if(url.includes('/commands?'))return{state:{revision:1},items:[{id:41,action:'play',payload:{}}]};
    acks++;return{};
  },onCommand:()=>{started();return new Promise(resolve=>{complete=resolve;});}});
  client.enabled=true;
  const pending=client.poll();await entered;
  client.suspend();complete({success:true});await pending;
  assert.equal(acks,0);
  assert.equal(client.processedCommands.size,0);
  assert.equal(client.state,null);
});

test('a snapshot from an earlier lifecycle cannot replace the new state', async () => {
  let complete;
  const client=new ConnectClient({storage:storage(),cryptoObject,api:()=>new Promise(resolve=>{complete=resolve;})});
  client.enabled=true;
  const pending=client.stateSnapshot();
  client.suspend();client.enabled=true;client.acceptState({revision:2,track_id:'current'});
  complete({revision:99,track_id:'old'});
  assert.equal((await pending).track_id,'current');
  assert.equal(client.state.track_id,'current');
});

test('a late disabled error cannot disable a newly enabled lifecycle', async () => {
  let reject;
  const client=new ConnectClient({storage:storage(),cryptoObject,api:()=>new Promise((resolve,fail)=>{reject=fail;})});
  client.enabled=true;
  const pending=client.poll();client.suspend();client.enabled=true;
  reject(Object.assign(new Error('disabled'),{status:404,code:'connect_disabled'}));
  await pending;
  assert.equal(client.enabled,true);
});

test('Connect exposes failed polling and recovery without changing the playback snapshot',async()=>{
  let offline=true;const changes=[];
  const client=new ConnectClient({storage:storage(),cryptoObject,onStatus:value=>changes.push(value.connection),api:async()=>{
    if(offline)throw new Error('network');
    return{state:{revision:1,track_id:'same'},items:[]};
  }});
  client.enabled=true;client.acceptState({revision:1,track_id:'same'});
  await client.poll();assert.equal(client.connection,'reconnecting');assert.equal(client.state.track_id,'same');
  offline=false;await client.poll();assert.equal(client.connection,'connected');
  assert.deepEqual(changes,['reconnecting','connected']);
});

test('outbound commands show pending and failure without leaking error text',async()=>{
  let fail;const statuses=[];
  const client=new ConnectClient({storage:storage(),cryptoObject,onStatus:value=>statuses.push(value),api:()=>new Promise((resolve,reject)=>{fail=reject;})});
  client.enabled=true;
  const sent=client.command('pause');assert.equal(client.pending,1);
  fail(new Error('sensitive server error'));await assert.rejects(sent);
  assert.equal(client.pending,0);assert.equal(client.connection,'error');
  assert.equal(JSON.stringify(statuses).includes('sensitive'),false);
});
