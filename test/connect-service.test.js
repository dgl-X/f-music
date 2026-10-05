import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectService, validateConnectDevice } from '../src/connect-service.js';

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
