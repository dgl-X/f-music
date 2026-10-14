import { ConnectEventsClient } from './connect-events-client.js';

const createDeviceId = cryptoObject => `web_${cryptoObject.randomUUID().replaceAll('-','')}`;

export const availableConnectDevices = devices => (Array.isArray(devices) ? devices : []).filter(device =>
  device?.online && device.capabilities?.playback_ready !== false
);

export const remotePlaybackActive = (client, state) => Boolean(
  client?.enabled && state?.active_device_id && state.active_device_id !== client.deviceId
);

export class ConnectClient {
  constructor({ api, storage = globalThis.sessionStorage, cryptoObject = globalThis.crypto, onCommand = async () => ({ success:false }), onState = () => {}, onAvailability = () => {}, onStatus = () => {}, pollIntervalMs = 1500, eventSourceFactory, now = () => performance.now() }) {
    this.api=api;this.storage=storage;this.cryptoObject=cryptoObject;this.onCommand=onCommand;this.onState=onState;this.pollIntervalMs=pollIntervalMs;
    this.deviceId=storage.getItem('family-music-connect-device')||createDeviceId(cryptoObject);
    storage.setItem('family-music-connect-device',this.deviceId);
    this.deviceName=storage.getItem('family-music-connect-name')||'WEB-браузер';
    this.enabled=false;this.ready=false;this.lastCommandId=0;this.timer=null;this.polling=false;this.state=null;this.stateRevision=-1;
    this.processedCommands=new Map();this.stateUpdateChain=Promise.resolve();
    this.onAvailability=onAvailability;this.running=false;this.generation=0;this.availabilityChecking=false;this.lastAvailabilityCheck=0;
    this.onStatus=onStatus;this.connection='connected';this.pending=0;
    this.now=now;this.pollRequested=false;this.pollQueued=false;this.pollToken=null;this.startSequence=0;
    this.events=new ConnectEventsClient({factory:eventSourceFactory,now,onHint:()=>this.requestPoll()});
  }

  notifyStatus() { this.onStatus({enabled:this.enabled,connection:this.connection,pending:this.pending,transport:this.events.healthy?'sse':'polling'}); }

  requestPoll(){
    if(!this.enabled)return;
    this.pollRequested=true;
    if(this.polling||this.pollQueued)return;
    this.pollQueued=true;const generation=this.generation;
    queueMicrotask(()=>{
      if(generation!==this.generation)return;
      this.pollQueued=false;
      if(this.enabled&&this.pollRequested)this.poll();
    });
  }

  tick(){
    if(!this.running)return;
    if(this.now()-this.lastAvailabilityCheck>=15000)this.refreshAvailability().catch(()=>{});
    if(this.enabled){this.events.tick();if(!this.events.healthy)this.poll();}
  }

  async sendControl(url, body) {
    const generation=this.generation;
    this.pending++;this.notifyStatus();
    try {
      const result=await this.api(url,{method:'POST',body:JSON.stringify(body)});
      if(generation===this.generation)this.connection='connected';
      return result;
    } catch(error) {
      if(generation===this.generation)this.connection='error';
      throw error;
    } finally {
      if(generation===this.generation){this.pending=Math.max(0,this.pending-1);this.notifyStatus();}
    }
  }

  acceptState(state) {
    if(!state||typeof state!=='object')return false;
    const revision=Number(state.revision);
    if(Number.isFinite(revision)&&revision<=this.stateRevision)return false;
    if(Number.isFinite(revision))this.stateRevision=revision;
    this.state=state;this.onState(state);return true;
  }

  async start() {
    const startup=++this.startSequence;
    if(this.timer){clearInterval(this.timer);this.timer=null;}
    this.running=true;
    try{await this.refreshAvailability();}catch{if(startup===this.startSequence&&this.running)this.suspend();}
    if(!this.running||startup!==this.startSequence)return this.enabled;
    this.timer=setInterval(()=>this.tick(),this.pollIntervalMs);
    this.timer?.unref?.();
    return this.enabled;
  }

  async refreshAvailability() {
    if(!this.running||this.availabilityChecking)return;
    this.availabilityChecking=true;this.lastAvailabilityCheck=this.now();
    const generation=this.generation;
    try{
      const status=await this.api('/api/v1/connect/status');
      if(!this.running||generation!==this.generation)return;
      this.pollIntervalMs=Number(status.poll_interval_ms)||this.pollIntervalMs;
      if(!status.enabled){this.suspend();return;}
      if(!this.enabled){this.enabled=true;await this.register();if(!this.running||generation!==this.generation)return;this.onAvailability(true);await this.poll();}
      if(this.enabled&&this.running&&generation===this.generation)this.events.configure(status,this.deviceId);
    }catch(error){if(this.running&&generation===this.generation){if(!this.enabled||error.status===401||error.code==='connect_disabled')this.suspend();else{this.connection='reconnecting';this.notifyStatus();}}throw error;}finally{this.availabilityChecking=false;}
  }

  suspend() {
    const changed=this.enabled;this.enabled=false;this.generation++;this.state=null;this.stateRevision=-1;this.processedCommands.clear();
    this.events.close();this.pollRequested=false;this.pollQueued=false;this.polling=false;this.pollToken=null;
    this.pending=0;this.connection='connected';this.notifyStatus();
    if(changed)this.onAvailability(false);
  }

  async register(ready=this.ready) {
    const generation=this.generation;
    this.ready=Boolean(ready);
    const result=await this.api('/api/v1/connect/devices',{method:'POST',body:JSON.stringify({id:this.deviceId,name:this.deviceName,client_type:'web',capabilities:{playback:true,playback_ready:this.ready,transfer_prepare:true,seek:true,volume:true,shuffle:true,repeat:true}})});
    if(this.running&&generation===this.generation)this.acceptState(result.state);return result;
  }

  async setReady() { return this.register(true); }
  async devices() { return this.api('/api/v1/connect/devices'); }
  async stateSnapshot() {
    const generation=this.generation;
    const state=await this.api('/api/v1/connect/state');
    if(this.enabled&&generation===this.generation)this.acceptState(state);
    return generation===this.generation?state:this.state;
  }
  async transfer(targetDeviceId,state) { return this.sendControl('/api/v1/connect/transfer',{source_device_id:this.deviceId,target_device_id:targetDeviceId,state}); }
  async command(action,payload={}) { return this.sendControl('/api/v1/connect/commands',{source_device_id:this.deviceId,action,payload}); }
  updateState(state) {
    const generation=this.generation;
    const epoch=Number(this.state?.playback_epoch)||0;
    const snapshot={device_id:this.deviceId,...state,playback_epoch:epoch};
    const request=this.stateUpdateChain.catch(()=>{}).then(async()=>{
      if(!this.enabled||generation!==this.generation||epoch!==(Number(this.state?.playback_epoch)||0)||remotePlaybackActive(this,this.state))return this.state;
      if(!this.state?.active_device_id&&snapshot.playing===false)return this.state;
      const result=await this.api('/api/v1/connect/state',{method:'PUT',body:JSON.stringify(snapshot)});
      if(this.enabled&&generation===this.generation)this.acceptState(result);return result;
    });
    this.stateUpdateChain=request;return request;
  }

  async poll() {
    if(!this.enabled||this.polling)return;this.polling=true;
    this.pollRequested=false;const token={};this.pollToken=token;
    const generation=this.generation;
    try{
      const result=await this.api(`/api/v1/connect/commands?device_id=${encodeURIComponent(this.deviceId)}&after=${this.lastCommandId}`);
      if(!this.enabled||generation!==this.generation)return;
      this.connection='connected';this.notifyStatus();
      this.acceptState(result.state);
      for(const command of result.items){
        if(!this.enabled||generation!==this.generation)return;
        const commandId=Number(command.id)||0;
        if(commandId<=this.lastCommandId)continue;
        let outcome=this.processedCommands.get(commandId);
        if(!outcome){
          outcome={success:false,result:{error:'Команда не обработана'}};
          const commandEpoch=Number(command.payload?.playback_epoch);
          if(Number.isFinite(commandEpoch)&&((command.action==='deactivate'&&commandEpoch<Number(this.state?.playback_epoch||0))||(!['transfer','deactivate'].includes(command.action)&&commandEpoch!==Number(this.state?.playback_epoch||0))))outcome={success:false,result:{error:'Устаревшая эпоха команды'}};
          else try{const value=await this.onCommand(command);outcome=typeof value==='boolean'?{success:value,result:{}}:{success:Boolean(value?.success),result:value?.result||{}};}catch(error){outcome={success:false,result:{error:String(error?.message||error).slice(0,300)}};}
          if(!this.enabled||generation!==this.generation)return;
          this.processedCommands.set(commandId,outcome);
        }
        try{
          const acknowledged=await this.api(`/api/v1/connect/commands/${command.id}/ack`,{method:'POST',body:JSON.stringify({device_id:this.deviceId,...outcome})});
          if(this.enabled&&generation===this.generation){this.acceptState(acknowledged?.state);this.lastCommandId=Math.max(this.lastCommandId,commandId);this.processedCommands.delete(commandId);}
        }catch(error){if(generation===this.generation&&error?.status===404&&error?.code==='connect_disabled')this.suspend();}
      }
    }catch(error){if(generation===this.generation){if(error?.status===401||error?.status===404&&error?.code==='connect_disabled')this.suspend();else{if(this.events.healthy)this.events.failed();this.connection='reconnecting';this.notifyStatus();}}}
    finally{if(this.pollToken===token){this.polling=false;this.pollToken=null;if(this.pollRequested)this.requestPoll();}}
  }

  stop() { this.startSequence++;this.running=false;if(this.timer)clearInterval(this.timer);this.timer=null;this.suspend(); }
}
