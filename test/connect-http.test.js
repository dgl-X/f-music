import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectHttpController } from '../src/connect-http.js';

function harness(connect, body = {}) {
  connect.getSettings??=async()=>({enabled:connect.enabled,server_enabled:connect.enabled,user_enabled:true});
  const responses = [];
  const controller = createConnectHttpController({
    connect,
    async readJson() { return body; },
    sendJson(_res, status, value) { responses.push({ status, value }); },
  });
  return { controller, responses };
}

test('settings remain accessible for a normal account while Connect is disabled',async()=>{
  const {controller,responses}=harness({enabled:false});
  await controller.handle({method:'GET'},{},new URL('https://music.test/api/connect/settings'),{id:7,is_admin:0});
  assert.equal(responses[0].status,200);assert.equal(responses[0].value.server_enabled,false);
});

test('settings mutation uses the authenticated account and ignores a supplied user id',async()=>{
  const {controller,responses}=harness({enabled:false,async setSettings(id,enabled){assert.equal(id,7);assert.equal(enabled,false);return{status:'ok',settings:{enabled:false,user_enabled:false,server_enabled:false}};}},{enabled:false,user_id:99});
  await controller.handle({method:'PUT'},{},new URL('https://music.test/api/connect/settings'),{id:7,is_admin:0});
  assert.equal(responses[0].status,200);
});

test('personally disabled users cannot register devices or issue commands',async()=>{
  const {controller,responses}=harness({enabled:true,async getSettings(){return{enabled:false,server_enabled:true,user_enabled:false};},async registerDevice(){assert.fail('Disabled account registered a device');},async sendCommand(){assert.fail('Disabled account sent a command');}});
  for(const pathname of ['/api/connect/devices','/api/connect/commands'])await controller.handle({method:'POST'},{},new URL(`https://music.test${pathname}`),{id:7});
  assert.ok(responses.every(response=>response.status===404&&response.value.error_code==='connect_disabled'));
});

test('Connect status remains available while the feature is disabled', async () => {
  const { controller, responses } = harness({ enabled:false });
  const handled = await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/connect/status'), { id:7 });
  assert.equal(handled, true);
  assert.deepEqual(responses, [{ status:200, value:{ enabled:false, server_enabled:false,user_enabled:true,transport:'polling', poll_interval_ms:1500 } }]);
});

test('disabled Connect rejects its other routes with a stable error code', async () => {
  const { controller, responses } = harness({ enabled:false });
  await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/connect/devices'), { id:7 });
  assert.deepEqual(responses, [{ status:404, value:{ error:'Family Music Connect выключен', error_code:'connect_disabled' } }]);
});

test('Connect HTTP controller preserves device registration validation errors', async () => {
  const connect = { enabled:true, async registerDevice(userId, body) {
    assert.equal(userId, 7);
    assert.equal(body.id, 'short');
    return { status:'invalid', error:'Некорректный ID устройства' };
  } };
  const { controller, responses } = harness(connect, { id:'short' });
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/connect/devices'), { id:7 });
  assert.deepEqual(responses, [{ status:400, value:{ error:'Некорректный ID устройства' } }]);
});

test('Connect command route maps an offline target to conflict', async () => {
  const connect = { enabled:true, async sendCommand() { return { status:'target_offline' }; } };
  const { controller, responses } = harness(connect, { source_device_id:'web_0123456789abcdef', action:'next' });
  await controller.handle({ method:'POST' }, {}, new URL('https://music.test/api/connect/commands'), { id:7 });
  assert.deepEqual(responses, [{ status:409, value:{ error:'Активное устройство недоступно' } }]);
});

test('Connect HTTP controller ignores unrelated and unknown enabled routes', async () => {
  const { controller, responses } = harness({ enabled:true });
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/tracks'), { id:7 }), false);
  assert.equal(await controller.handle({ method:'GET' }, {}, new URL('https://music.test/api/connect/unknown'), { id:7 }), false);
  assert.deepEqual(responses, []);
});

test('SSE is opt-in and forwards only authenticated account/session and requested device',async()=>{
  const responses=[];let opened;
  const connect={enabled:true,getSettings:async()=>({enabled:true})};
  const disabled=createConnectHttpController({connect,sendJson:(_res,status,value)=>responses.push({status,value})});
  await disabled.handle({method:'GET'},{},new URL('https://music.test/api/connect/events'),{id:7});
  assert.equal(responses[0].value.error_code,'connect_events_disabled');
  const controller=createConnectHttpController({connect,sendJson:(_res,status,value)=>responses.push({status,value}),events:{enabled:true,heartbeatMs:15000,async open(_req,_res,input){opened=input;return{status:200};}}});
  await controller.handle({method:'GET'},{},new URL('https://music.test/api/connect/events?device_id=web_0123456789abcdef&user_id=99&session_id=999'),{id:7,session_id:8});
  assert.deepEqual(opened,{userId:7,sessionId:8,deviceId:'web_0123456789abcdef'});
  await controller.handle({method:'GET'},{},new URL('https://music.test/api/connect/status'),{id:7});
  assert.equal(responses.at(-1).value.transport,'polling');assert.deepEqual(responses.at(-1).value.transports,['sse','polling']);
});
