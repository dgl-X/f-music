import crypto from 'node:crypto';

const origin=String(process.env.CONNECT_TEST_ORIGIN||'http://127.0.0.1:8095').replace(/\/$/,'');
const username=process.env.CONNECT_TEST_USERNAME,password=process.env.CONNECT_TEST_PASSWORD;
if(!username||!password)throw new Error('Set CONNECT_TEST_USERNAME and CONNECT_TEST_PASSWORD');
let cookie='';

async function rawRequest(path,{method='GET',body}={}){
  const response=await fetch(`${origin}/api/v1${path}`,{method,headers:{Accept:'application/json',...(cookie?{Cookie:cookie}:{}),...(!['GET','HEAD'].includes(method)?{Origin:origin}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';',1)[0];
  const data=await response.json().catch(()=>({}));return{response,data};
}
async function request(path,options={}){
  const {response,data}=await rawRequest(path,options);if(!response.ok)throw new Error(`${options.method||'GET'} ${path}: ${response.status} ${data.error||''}`);return data;
}

const suffix=crypto.randomBytes(8).toString('hex'),first=`smoke_a_${suffix}`,second=`smoke_b_${suffix}`;
const device=id=>({id,name:`Connect smoke ${id===first?'A':'B'}`,client_type:'web',capabilities:{playback:true,playback_ready:true,seek:true}});

await request('/login',{method:'POST',body:{username,password,device_name:'Connect smoke',client_name:'Connect smoke'}});
const status=await request('/connect/status');if(!status.enabled)throw new Error('Family Music Connect is disabled');
try{
  await request('/connect/devices',{method:'POST',body:device(first)});
  await request('/connect/devices',{method:'POST',body:device(second)});
  const initial=await request('/connect/state',{method:'PUT',body:{device_id:first,track_id:null,position_seconds:0,duration_seconds:0,queue:[],playing:false,shuffle:false,repeat_mode:'off'}});
  if(!Number.isInteger(initial.playback_epoch)||initial.playback_epoch<1)throw new Error('Initial playback epoch was not assigned');
  await request('/connect/commands',{method:'POST',body:{source_device_id:second,action:'next',payload:{}}});
  await request('/connect/transfer',{method:'POST',body:{source_device_id:first,target_device_id:second,state:{track_id:'smoke-track',position_seconds:12,duration_seconds:180,queue:['smoke-track'],playing:true,shuffle:false,repeat_mode:'off'}}});
  const targetPoll=await request(`/connect/commands?device_id=${second}&after=0`),transfer=targetPoll.items.find(item=>item.action==='transfer');
  if(!transfer)throw new Error('Transfer command was not delivered');
  if(transfer.payload.playback_epoch!==initial.playback_epoch+1)throw new Error('Transfer did not advance playback epoch');
  const acknowledged=await request(`/connect/commands/${transfer.id}/ack`,{method:'POST',body:{device_id:second,success:true,result:{smoke:true}}});
  const duplicate=await request(`/connect/commands/${transfer.id}/ack`,{method:'POST',body:{device_id:second,success:true,result:{smoke:true}}});
  if(!duplicate.duplicate)throw new Error('Duplicate acknowledgement was not idempotent');
  const state=await request('/connect/state');if(state.active_device_id!==second||state.track_id!=='smoke-track'||state.playback_epoch!==initial.playback_epoch+1)throw new Error('Transfer state was not committed');
  if(acknowledged.state.playback_epoch!==state.playback_epoch)throw new Error('ACK returned an inconsistent epoch');
  const oldDevicePoll=await request(`/connect/commands?device_id=${first}&after=0`);
  if(oldDevicePoll.items.some(item=>item.action==='next'))throw new Error('Old pending command survived the transfer');
  for(const item of oldDevicePoll.items)if(item.action==='deactivate')await request(`/connect/commands/${item.id}/ack`,{method:'POST',body:{device_id:first,success:true,result:{}}});
  const stale=await rawRequest('/connect/state',{method:'PUT',body:{device_id:second,playback_epoch:initial.playback_epoch,track_id:'old-track',queue:['old-track'],playing:true}});
  if(stale.response.status!==409||stale.data.error_code!=='connect_stale_epoch')throw new Error('Stale playback epoch was accepted');
  await request('/connect/commands',{method:'POST',body:{source_device_id:first,action:'pause',payload:{}}});
  const commandPoll=await request(`/connect/commands?device_id=${second}&after=${transfer.id}`),pause=commandPoll.items.find(item=>item.action==='pause');
  if(!pause)throw new Error('Playback command was not delivered');
  if(pause.payload.playback_epoch!==state.playback_epoch)throw new Error('Playback command was not bound to the active epoch');
  const repeatedPoll=await request(`/connect/commands?device_id=${second}&after=${transfer.id}`);
  if(!repeatedPoll.items.some(item=>item.id===pause.id))throw new Error('Unacknowledged command was not redelivered');
  await request(`/connect/commands/${pause.id}/ack`,{method:'POST',body:{device_id:second,success:true,result:{smoke:true}}});
  await request('/connect/devices',{method:'POST',body:{...device(first),capabilities:{playback:true,playback_ready:true,transfer_prepare:true}}});
  await request('/connect/transfer',{method:'POST',body:{source_device_id:second,target_device_id:first,state:{track_id:'smoke-track',position_seconds:25,duration_seconds:180,queue:['smoke-track','next-track'],shuffle_order:['next-track','smoke-track'],playback_history:['next-track'],playing:true}}});
  const staged=(await request(`/connect/commands?device_id=${first}&after=0`)).items.find(item=>item.action==='transfer');
  if(!staged?.payload.transfer_prepare)throw new Error('Prepared transfer capability was ignored');
  const beforeReady=await request('/connect/state');
  if(beforeReady.active_device_id!==second)throw new Error('Ownership changed before target readiness');
  const readyBody={device_id:first,success:true,result:{state:{track_id:'smoke-track',position_seconds:26,duration_seconds:180,queue:['smoke-track','next-track'],playing:false}}};
  await request(`/connect/commands/${staged.id}/ack`,{method:'POST',body:readyBody});
  const lostAck=await request(`/connect/commands/${staged.id}/ack`,{method:'POST',body:readyBody});
  if(!lostAck.duplicate)throw new Error('Prepared ACK replay was not idempotent');
  const prepared=await request('/connect/state');
  if(prepared.playing||prepared.position_seconds!==26)throw new Error('Actual prepared state was not stored');
  if(JSON.stringify(prepared.shuffle_order)!==JSON.stringify(['next-track','smoke-track'])||prepared.playback_history[0]!=='next-track')throw new Error('Prepared navigation was not preserved');
  const waitingTarget=await request(`/connect/commands?device_id=${first}&after=${staged.id}`);
  if(waitingTarget.items.length)throw new Error('Target activation was issued before source stopped');
  const stopSource=(await request(`/connect/commands?device_id=${second}&after=${pause.id}`)).items.find(item=>item.action==='deactivate');
  if(!stopSource)throw new Error('Source stop was not requested');
  await request(`/connect/commands/${stopSource.id}/ack`,{method:'POST',body:{device_id:second,success:true,result:{state:{track_id:'smoke-track',position_seconds:30,playing:false}}}});
  const activation=(await request(`/connect/commands?device_id=${first}&after=${staged.id}`)).items.find(item=>item.action==='activate');
  if(!activation||activation.payload.position_seconds!==30)throw new Error('Activation did not preserve source stopped position');
  await request(`/connect/commands/${activation.id}/ack`,{method:'POST',body:{device_id:first,success:true,result:{state:{track_id:'smoke-track',position_seconds:30,duration_seconds:180,playing:true,shuffle:false,repeat_mode:'off'}}}});
  const activated=await request('/connect/state');
  if(!activated.playing||activated.position_seconds!==30)throw new Error('Actual activated state was not committed');
  for(const isPlaying of [false,true]){
    const snapshot={device_id:first,playback_epoch:activated.playback_epoch,track_id:'smoke-track',queue:['smoke-track'],position_seconds:30,duration_seconds:180,playing:true,is_playing:isPlaying,buffering:!isPlaying};
    await request('/connect/state',{method:'PUT',body:snapshot});
    const actual=await request('/connect/state');
    if(!actual.playing||actual.is_playing!==isPlaying||actual.buffering!==!isPlaying||actual.playback_status!==(isPlaying?'playing':'buffering'))throw new Error('Actual playback status did not survive database roundtrip');
  }
  console.log('Family Music Connect smoke: OK');
}finally{
  await request(`/connect/devices/${first}`,{method:'DELETE'}).catch(()=>{});
  await request(`/connect/devices/${second}`,{method:'DELETE'}).catch(()=>{});
  await request('/logout',{method:'POST',body:{}}).catch(()=>{});
}
