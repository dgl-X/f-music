import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectService } from '../src/connect-service.js';

test('personal Connect defaults on, is isolated by account, and respects the global gate',async()=>{
  const db={prepare(){return{async get(id){return id===1?{enabled:false}:undefined;}};}};
  const service=createConnectService({db,enabled:true});
  assert.deepEqual(await service.getSettings(1),{enabled:false,server_enabled:true,user_enabled:false});
  assert.equal((await service.getSettings(2)).enabled,true);
  assert.deepEqual(await createConnectService({db,enabled:false}).getSettings(2),{enabled:false,server_enabled:false,user_enabled:true});
});

test('turning off cancels only this account commands without sending pause or play',async()=>{
  const writes=[];
  const tx={prepare(sql){return{
    async get(){if(sql.startsWith('SELECT enabled'))return{enabled:true};},
    async run(...params){writes.push({sql,params});},
  };}};
  const result=await createConnectService({db:{transaction:fn=>fn(tx)},enabled:true}).setSettings(7,false);
  assert.equal(result.status,'ok');assert.equal(result.settings.user_enabled,false);
  assert.equal(writes.length,3);
  for(const write of writes)assert.equal(write.params[0],7);
  assert.ok(writes.some(write=>write.sql.includes('playback_epoch=playback_epoch+1')));
  assert.ok(writes.every(write=>!write.sql.includes('INSERT INTO connect_commands')));
});

test('preference changes wait for an active handoff instead of interrupting it',async()=>{
  const tx={prepare(sql){return{async get(){if(sql.startsWith('SELECT enabled'))return{enabled:true};if(sql.startsWith('SELECT id FROM connect_commands'))return{id:41};},async run(){assert.fail('Preference changed during handoff');}};}};
  assert.equal((await createConnectService({db:{transaction:fn=>fn(tx)}}).setSettings(7,false)).status,'transfer_pending');
});

test('unchanged preference does not reset ownership and non-boolean values are rejected',async()=>{
  const tx={prepare(){return{async get(){return{enabled:true};},async run(){assert.fail('An unchanged setting reset playback');}};}};
  const service=createConnectService({db:{transaction:fn=>fn(tx)},enabled:true});
  assert.equal((await service.setSettings(7,true)).status,'ok');
  assert.equal((await service.setSettings(7,'false')).status,'invalid');
});
