import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectService, validateConnectDevice, normalizeConnectNavigation } from '../src/connect-service.js';

test('Connect navigation keeps the exact permutation and history within the shared queue',()=>{
  assert.deepEqual(normalizeConnectNavigation({shuffle_order:['c','bad','a','c'],playback_history:['a','bad','c','a']},['a','b','c']),{shuffle_order:['c','a','b'],playback_history:['a','c','a']});
});

test('prepared transfer commits actual paused position and only requests source deactivation', async () => {
  const calls=[];
  const command={id:41,status:'pending',action:'transfer',expires_at:new Date(Date.now()+30000),payload_json:{transfer_prepare:true,track_id:'track',queue:['track'],position_seconds:10,playing:true,playback_epoch:2,previous_device_id:'source'}};
  const tx={prepare(sql){return{
    async get(){if(sql.startsWith('SELECT * FROM connect_commands'))return command;if(sql.startsWith('SELECT id FROM connect_devices'))return{id:'source'};if(sql.startsWith('SELECT * FROM connect_state'))return{active_device_id:'target',playback_epoch:2,queue_json:['track']};},
    async run(...params){calls.push({sql,params});return{changes:1};},
  };}};
  const service=createConnectService({db:{transaction:fn=>fn(tx)},enabled:true});
  await service.acknowledge(1,'target',41,{success:true,result:{state:{track_id:'track',queue:['track'],position_seconds:14,playing:false}}});
  const state=calls.find(c=>c.sql.startsWith('INSERT INTO connect_state'));
  assert.equal(state.params[4],14);
  assert.equal(state.params[7],0);
  assert.equal(calls.filter(c=>c.sql.includes("'activate'")).length,0);
  const deactivate=calls.find(c=>c.sql.includes("'deactivate'"));
  assert.equal(JSON.parse(deactivate.params[3]).activate_device_id,'target');
});

test('prepared transfer rejects an early ACK while target is still playing', async () => {
  let writes=0;
  const tx={prepare(sql){return{async get(){if(sql.startsWith('SELECT * FROM connect_commands'))return{status:'pending',action:'transfer',payload_json:{transfer_prepare:true,track_id:'track'},expires_at:new Date(Date.now()+30000)};},async run(){writes++;}};}};
  const result=await createConnectService({db:{transaction:fn=>fn(tx)}}).acknowledge(1,'target',41,{success:true,result:{state:{track_id:'track',playing:true}}});
  assert.equal(result.status,'invalid');assert.equal(writes,0);
});

test('source pause ACK schedules activation at the actual stopped position', async () => {
  const calls=[];
  const tx={prepare(sql){return{
    async get(){if(sql.startsWith('SELECT * FROM connect_commands'))return{status:'pending',action:'deactivate',payload_json:{activate_device_id:'target',playback_epoch:2,track_id:'track',playing:true},expires_at:new Date(Date.now()+30000)};if(sql.startsWith('SELECT * FROM connect_state'))return{active_device_id:'target',playback_epoch:2,position_seconds:10};},
    async run(...params){calls.push({sql,params});},
  };}};
  await createConnectService({db:{transaction:fn=>fn(tx)}}).acknowledge(1,'source',42,{success:true,result:{state:{track_id:'track',position_seconds:18,playing:false}}});
  const activate=calls.find(c=>c.sql.includes("'activate'"));
  assert.equal(JSON.parse(activate.params[3]).position_seconds,18);
});

test('Connect device validation accepts only stable opaque ids and known clients', () => {
  assert.deepEqual(validateConnectDevice({
    id:'web_0123456789abcdef',name:'Chrome на ПК',client_type:'web',capabilities:{ seek:true },
  }), { id:'web_0123456789abcdef',name:'Chrome на ПК',clientType:'web',capabilities:{ seek:true } });
  assert.match(validateConnectDevice({id:'short',name:'Телефон',client_type:'android'}).error,/ID/);
  assert.match(validateConnectDevice({id:'android_0123456789',name:'Телефон',client_type:'other'}).error,/тип/);
});

test('Connect state can be claimed by the first registered active device', async () => {
  const calls=[];
  const db={prepare(sql){return{
    async get(...params){calls.push({sql,params});if(sql.startsWith('SELECT id FROM connect_devices'))return{id:'web_0123456789abcdef'};if(sql.startsWith('SELECT * FROM connect_state'))return undefined;if(sql.startsWith('INSERT INTO connect_state'))return{active_device_id:'web_0123456789abcdef',revision:1,track_id:'track-1',position_seconds:14,queue_json:['track-1'],playing:1,shuffle:0,repeat_mode:'off',volume:0.7,updated_at:'now'};},
  };}};
  const service=createConnectService({db,enabled:true});
  const result=await service.updateState(7,'web_0123456789abcdef',{track_id:'track-1',position_seconds:14,queue:['track-1'],playing:true,volume:0.7});
  assert.equal(result.status,'ok');
  assert.equal(result.state.active_device_id,'web_0123456789abcdef');
  assert.equal(result.state.playing,true);
  assert.deepEqual(result.state.queue,['track-1']);
  assert.match(calls.at(-1).sql,/revision=connect_state\.revision\+1/);
});

test('Connect commands target only the active online device', async () => {
  const calls=[];
  const tx={prepare(sql){return{
    async get(...params){calls.push({sql,params});if(sql.startsWith('SELECT id FROM connect_devices'))return{id:params[0]};if(sql.startsWith('SELECT active_device_id'))return{active_device_id:'android_0123456789'};if(sql.startsWith('INSERT INTO connect_commands'))return{id:41};},
  };}};
  const db={async transaction(callback){return callback(tx);}};
  const result=await createConnectService({db,enabled:true}).sendCommand(7,'web_0123456789abcdef','pause',{});
  assert.deepEqual(result,{status:'ok',command_id:41,target_device_id:'android_0123456789'});
  assert.equal(calls.filter(call=>call.sql.startsWith('SELECT id FROM connect_devices')).length,2);
});

test('unknown Connect commands are rejected before touching the database', async () => {
  const db={async transaction(){throw new Error('must not run');}};
  const result=await createConnectService({db,enabled:true}).sendCommand(1,'web_0123456789abcdef','format_disk',{});
  assert.equal(result.status,'invalid');
});

test('remote controls cannot start the target before transfer completes', async () => {
  const tx={prepare(sql){return{async get(){
    if(sql.startsWith('SELECT id FROM connect_devices'))return{id:'source'};
    if(sql.startsWith('SELECT id FROM connect_commands'))return{id:41};
    throw new Error('Playback command must not be enqueued during transfer');
  }};}};
  const result=await createConnectService({db:{transaction:fn=>fn(tx)}}).sendCommand(1,'source','play',{});
  assert.equal(result.status,'transfer_pending');
});

test('Connect registration cannot take over a device id during a concurrent conflict', async () => {
  const db={prepare(sql){return{
    async get(){if(sql.startsWith('SELECT user_id'))return undefined;if(sql.startsWith('INSERT INTO connect_devices'))return undefined;},
  };}};
  const result=await createConnectService({db,enabled:true}).registerDevice(7,{id:'web_0123456789abcdef',name:'Chrome',client_type:'web'});
  assert.equal(result.status,'conflict');
});

test('a controller may transfer playback back to itself when another device is active', async () => {
  const calls=[];
  const tx={prepare(sql){return{
    async get(...params){calls.push({sql,params});if(sql.startsWith('SELECT id FROM connect_devices'))return{id:params[0]};if(sql.startsWith('SELECT active_device_id'))return{active_device_id:'web_other0123456789'};if(sql.startsWith('INSERT INTO connect_commands'))return{id:52};},
    async run(...params){calls.push({sql,params});return{changes:1};},
  };}};
  const db={async transaction(callback){return callback(tx);}};
  const result=await createConnectService({db,enabled:true}).requestTransfer(7,'android_0123456789','android_0123456789',{track_id:'track-1',queue:['track-1']});
  assert.deepEqual(result,{status:'ok',command_id:52});
});

test('Connect state claim stays atomic when another device wins the race', async () => {
  let stateReads=0;
  const db={prepare(sql){return{
    async get(){
      if(sql.startsWith('SELECT id FROM connect_devices'))return{id:'web_0123456789abcdef'};
      if(sql.startsWith('SELECT * FROM connect_state')){stateReads++;return stateReads===1?undefined:{active_device_id:'android_0123456789',revision:4,queue_json:[]};}
      if(sql.startsWith('INSERT INTO connect_state'))return undefined;
    },
  };}};
  const result=await createConnectService({db,enabled:true}).updateState(7,'web_0123456789abcdef',{track_id:'track-1'});
  assert.equal(result.status,'not_active');
  assert.equal(result.state.active_device_id,'android_0123456789');
});

test('Connect acknowledgement is idempotent after a lost response', async () => {
  const tx={prepare(sql){return{
    async get(){
      if(sql.startsWith('SELECT * FROM connect_commands'))return{id:41,user_id:7,target_device_id:'android_0123456789',status:'complete'};
      if(sql.startsWith('SELECT * FROM connect_state'))return{active_device_id:'android_0123456789',revision:9,queue_json:[]};
    },
  };}};
  const db={async transaction(callback){return callback(tx);}};
  const result=await createConnectService({db,enabled:true}).acknowledge(7,'android_0123456789',41,{success:true});
  assert.equal(result.status,'ok');
  assert.equal(result.duplicate,true);
  assert.equal(result.state.revision,9);
});

test('Connect rejects a delayed state snapshot from an older playback epoch', async () => {
  let writes=0;
  const db={prepare(sql){return{
    async get(){
      if(sql.startsWith('SELECT id FROM connect_devices'))return{id:'android_0123456789'};
      if(sql.startsWith('SELECT * FROM connect_state'))return{active_device_id:'android_0123456789',playback_epoch:6,revision:20,queue_json:['new-track']};
      if(sql.startsWith('INSERT INTO connect_state')){writes++;return{};}
    },
  };}};
  const result=await createConnectService({db,enabled:true}).updateState(7,'android_0123456789',{playback_epoch:5,track_id:'old-track'});
  assert.equal(result.status,'stale_epoch');
  assert.equal(result.state.track_id,undefined);
  assert.equal(writes,0);
});

test('Connect transfer advances the playback epoch', async () => {
  let transferPayload;
  const tx={prepare(sql){return{
    async get(...params){
      if(sql.startsWith('SELECT id FROM connect_devices'))return{id:params[0]};
      if(sql.startsWith('SELECT active_device_id'))return{active_device_id:'web_0123456789abcdef',playback_epoch:11};
      if(sql.startsWith('INSERT INTO connect_commands')){transferPayload=JSON.parse(params[3]);return{id:73};}
    },
    async run(){return{changes:1};},
  };}};
  const db={async transaction(callback){return callback(tx);}};
  const result=await createConnectService({db,enabled:true}).requestTransfer(7,'web_0123456789abcdef','android_0123456789',{track_id:'track-2',queue:['track-2']});
  assert.equal(result.command_id,73);
  assert.equal(transferPayload.playback_epoch,12);
});

test('Connect command is bound to the active playback epoch', async () => {
  let commandPayload;
  const tx={prepare(sql){return{
    async get(...params){
      if(sql.startsWith('SELECT id FROM connect_devices'))return{id:params[0]};
      if(sql.startsWith('SELECT active_device_id'))return{active_device_id:'android_0123456789',playback_epoch:14};
      if(sql.startsWith('INSERT INTO connect_commands')){commandPayload=JSON.parse(params[4]);return{id:81};}
    },
  };}};
  const db={async transaction(callback){return callback(tx);}};
  await createConnectService({db,enabled:true}).sendCommand(7,'web_0123456789abcdef','next',{});
  assert.equal(commandPayload.playback_epoch,14);
});

test('offline active Connect device releases ownership and pending commands', async () => {
  const calls=[];
  const tx={prepare(sql){return{
    async get(...params){calls.push({sql,params});if(sql.startsWith('SELECT state.active_device_id'))return{active_device_id:'android_0123456789',online:false};},
    async run(...params){calls.push({sql,params});return{changes:1};},
  };}};
  const db={async transaction(callback){return callback(tx);}};
  const released=await createConnectService({db,enabled:true,onlineSeconds:35}).releaseOfflineActiveDevice(7);
  assert.equal(released,true);
  assert.match(calls[1].sql,/active_device_id=NULL,playing=0,revision=revision\+1/);
  assert.deepEqual(calls[0].params,[35,7]);
  assert.match(calls[2].sql,/status='cancelled'/);
  assert.deepEqual(calls[2].params,[7,'android_0123456789']);
});

test('online active Connect device keeps ownership', async () => {
  let cancelled=false;
  const tx={prepare(sql){return{
    async get(){if(sql.startsWith('SELECT state.active_device_id'))return{active_device_id:'android_0123456789',online:true};},
    async run(){cancelled=true;return{changes:1};},
  };}};
  const db={async transaction(callback){return callback(tx);}};
  assert.equal(await createConnectService({db,enabled:true}).releaseOfflineActiveDevice(7),false);
  assert.equal(cancelled,false);
});
