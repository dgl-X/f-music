import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectClient } from '../public/connect-client.js';

// Native WHATWG EventSource + actual HTTP/API/PostgreSQL; not a browser/audio test.
export async function checkWebConnectEvents({origin,cookie}){
  assert.equal(typeof EventSource,'function','Run Node with --experimental-eventsource');
  const clients=[],responses=new Set(),executionTransports=[];let executions=0;
  async function api(url,options={}){
    const response=await fetch(origin+url,{...options,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},signal:AbortSignal.timeout(10000)});
    const value=await response.json();
    if(!response.ok)throw Object.assign(new Error(value.error||'HTTP error'),{status:response.status,code:value.error_code});
    return value;
  }
  async function wait(check,message){
    const until=Date.now()+10000;
    while(Date.now()<until){if(await check())return;await delay(20);}
    throw new Error(message);
  }
  // Node has no browser cookie jar. A loopback-only, test-owned relay supplies
  // the test account cookie to the SSE endpoint, never via URL parameters.
  const relay=createServer((req,res)=>{
    if(new URL(req.url,'http://localhost').pathname!=='/api/v1/connect/events'){res.writeHead(404);res.end();return;}
    const target=new URL(req.url,process.env.CONNECT_TEST_EVENTS_ORIGIN||origin);
    const upstream=httpRequest(target,{headers:{Cookie:cookie}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    responses.add(res);res.on('close',()=>{responses.delete(res);upstream.destroy();});
    upstream.on('error',()=>res.destroy());upstream.end();
  });
  relay.listen(0,'127.0.0.1');await once(relay,'listening');
  const eventOrigin=`http://127.0.0.1:${relay.address().port}`;
  function client(onCommand){
    const values=new Map();
    const instance=new ConnectClient({api,storage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},cryptoObject:crypto,
      eventSourceFactory:url=>new EventSource(eventOrigin+url),onCommand});
    clients.push(instance);return instance;
  }
  const receiver=client(async()=>{
    executions++;
    executionTransports.push(receiver.events.healthy?'sse':'polling');
    return{success:true,result:{state:{track_id:executions===1?'web-two':'web-one',queue:['web-one','web-two'],position_seconds:0,duration_seconds:180,playing:true}}};
  });
  const sender=client(async()=>assert.fail('Command was delivered to its sender'));
  try{
    await receiver.start();await sender.start();
    // Disable periodic ticks: the first command must arrive from SSE, not a
    // conveniently timed polling interval. The fallback is ticked explicitly.
    for(const instance of clients){clearInterval(instance.timer);instance.timer=null;}
    await receiver.updateState({track_id:'web-one',queue:['web-one','web-two'],playing:true,duration_seconds:180});
    await wait(()=>receiver.events.healthy&&sender.events.healthy&&sender.state?.active_device_id===receiver.deviceId,'Native EventSource did not synchronize Connect');
    await sender.command('next');
    await wait(()=>executions===1&&sender.state?.track_id==='web-two','SSE did not deliver and confirm next without polling timer');
    const acknowledged=receiver.lastCommandId;assert.ok(acknowledged>0);
    for(let i=0;i<20;i++)receiver.events.source.dispatchEvent(new MessageEvent('resync',{data:'{}'}));
    await delay(100);assert.equal(executions,1);assert.equal(receiver.lastCommandId,acknowledged);
    for(const response of responses)response.destroy();
    await wait(()=>!receiver.events.healthy,'EventSource loss was not detected');
    await sender.command('next');receiver.tick();sender.tick();
    await wait(()=>{receiver.tick();return executions===2;},'Polling fallback did not handle a command');
    assert.deepEqual(executionTransports,['sse','polling']);
    await wait(()=>{receiver.tick();return receiver.events.healthy;},'EventSource did not reconnect');
    await api('/api/v1/connect/settings',{method:'PUT',body:JSON.stringify({enabled:false})});
    receiver.tick();sender.tick();
    await wait(()=>clients.every(instance=>!instance.enabled&&instance.events.source===null),'Disabling Connect did not stop WEB SSE');
    console.log('WEB SSE: native EventSource, command without polling timer, duplicate hints, fallback, reconnect and disable OK');
  }finally{
    for(const instance of clients)instance.stop();
    await api('/api/v1/connect/settings',{method:'PUT',body:JSON.stringify({enabled:true})}).catch(()=>{});
    for(const instance of clients)await api(`/api/v1/connect/devices/${instance.deviceId}`,{method:'DELETE'}).catch(()=>{});
    for(const response of responses)response.destroy();relay.closeAllConnections();await new Promise(resolve=>relay.close(resolve));
  }
}
