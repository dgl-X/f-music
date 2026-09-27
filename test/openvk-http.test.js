import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenVkHttpController } from '../src/openvk-http.js';

function setup({ provider = {}, imported = [], readableFromWeb } = {}) {
  const responses=[];
  const db={
    prepare(){ return { async all(){ return imported; } }; },
    async transaction(callback){ await callback({ prepare(){ return { async run(){} }; } }); },
  };
  const controller=createOpenVkHttpController({
    db,provider,async readJson(req){return req.body||{};},
    sendJson(res,status,value){responses.push({status,value});},readableFromWeb,
  });
  return { controller,responses };
}

test('OpenVK HTTP controller ignores unrelated routes', async () => {
  const {controller,responses}=setup();
  const handled=await controller.handle({method:'GET',headers:{}},{},new URL('http://local/api/tracks'),{id:1,is_admin:1});
  assert.equal(handled,false);
  assert.deepEqual(responses,[]);
});

test('OpenVK settings remain admin-only and never expose the token', async () => {
  const provider={async settings(){return {enabled:true,token:'private-token'};}};
  const denied=setup({provider});
  assert.equal(await denied.controller.handle({method:'GET',headers:{}},{},new URL('http://local/api/admin/openvk-settings'),{id:2,is_admin:0}),true);
  assert.equal(denied.responses[0].status,403);
  const allowed=setup({provider});
  await allowed.controller.handle({method:'GET',headers:{}},{},new URL('http://local/api/admin/openvk-settings'),{id:1,is_admin:1});
  assert.deepEqual(allowed.responses[0],{status:200,value:{enabled:true,token_configured:true}});
  assert.equal(JSON.stringify(allowed.responses).includes('private-token'),false);
});

test('OpenVK search decorates only previously imported tracks', async () => {
  const provider={async search(){return {items:[{source_id:'1_2',title:'One'},{source_id:'3_4',title:'Two'}],count:2,offset:0,limit:30};}};
  const {controller,responses}=setup({provider,imported:[{source_id:'3_4',track_id:'local-track'}]});
  await controller.handle({method:'GET',headers:{}},{},new URL('http://local/api/openvk/search?q=test'),{id:1,is_admin:0});
  assert.equal(responses[0].status,200);
  assert.equal(responses[0].value.items[0].local_track_id,null);
  assert.equal(responses[0].value.items[1].local_track_id,'local-track');
});

test('OpenVK import preserves queued and provider error statuses', async () => {
  const queued=setup({provider:{async importTrack(){return {status:'queued',upload_id:'upload'};}}});
  await queued.controller.handle({method:'POST',headers:{},body:{source_id:'1_2'}},{},new URL('http://local/api/openvk/import'),{id:9,is_admin:0});
  assert.equal(queued.responses[0].status,202);
  const oversized=setup({provider:{async importTrack(){throw Object.assign(new Error('large'),{code:'openvk_too_large'});}}});
  await oversized.controller.handle({method:'POST',headers:{},body:{source_id:'1_2'}},{},new URL('http://local/api/openvk/import'),{id:9,is_admin:0});
  assert.equal(oversized.responses[0].status,413);
});

test('OpenVK preview forwards range and only safe media headers', async () => {
  let receivedRange,pipeTarget;
  const headers=new Headers({'content-type':'audio/mpeg','content-length':'1024','content-range':'bytes 0-1023/9000','x-private-cdn':'hidden'});
  const body={on(){return body;},pipe(target){pipeTarget=target;return target;},destroy(){}};
  const provider={async preview(sourceId,range){assert.equal(sourceId,'1_2');receivedRange=range;return {status:206,headers,body:{web:true}};}};
  const {controller}=setup({provider,readableFromWeb(value){assert.deepEqual(value,{web:true});return body;}});
  const req={method:'GET',headers:{range:'bytes=0-1023'},once(){}};
  const res={destroyed:false,writeHead(status,responseHeaders){this.status=status;this.headers=responseHeaders;},destroy(){}};
  assert.equal(await controller.handle(req,res,new URL('http://local/api/openvk/stream?source_id=1_2'),{id:1,is_admin:0}),true);
  assert.equal(receivedRange,'bytes=0-1023');
  assert.equal(res.status,206);
  assert.equal(res.headers['content-range'],'bytes 0-1023/9000');
  assert.equal('x-private-cdn' in res.headers,false);
  assert.equal(pipeTarget,res);
});
