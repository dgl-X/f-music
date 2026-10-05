const createDeviceId = cryptoObject => `web_${cryptoObject.randomUUID().replaceAll('-','')}`;

export const availableConnectDevices = devices => (Array.isArray(devices) ? devices : []).filter(device =>
  device?.online && device.capabilities?.playback_ready !== false
);

export class ConnectClient {
  constructor({ api, storage = globalThis.sessionStorage, cryptoObject = globalThis.crypto, onCommand = async () => ({ success:false }), onState = () => {}, pollIntervalMs = 1500 }) {
    this.api=api;this.storage=storage;this.cryptoObject=cryptoObject;this.onCommand=onCommand;this.onState=onState;this.pollIntervalMs=pollIntervalMs;
    this.deviceId=storage.getItem('family-music-connect-device')||createDeviceId(cryptoObject);
    storage.setItem('family-music-connect-device',this.deviceId);
    this.deviceName=storage.getItem('family-music-connect-name')||'WEB-браузер';
    this.enabled=false;this.ready=false;this.lastCommandId=0;this.timer=null;this.polling=false;this.state=null;this.stateRevision=-1;
    this.processedCommands=new Map();this.stateUpdateChain=Promise.resolve();
  }

  acceptState(state) {
    if(!state||typeof state!=='object')return false;
    const revision=Number(state.revision);
    if(Number.isFinite(revision)&&revision<=this.stateRevision)return false;
    if(Number.isFinite(revision))this.stateRevision=revision;
    this.state=state;this.onState(state);return true;
  }

  async start() {
    const status=await this.api('/api/v1/connect/status');
    this.enabled=Boolean(status.enabled);if(!this.enabled)return false;
    this.pollIntervalMs=Number(status.poll_interval_ms)||this.pollIntervalMs;
    await this.register(false);await this.poll();this.timer=setInterval(()=>this.poll(),this.pollIntervalMs);return true;
  }

  async register(ready=this.ready) {
    this.ready=Boolean(ready);
    const result=await this.api('/api/v1/connect/devices',{method:'POST',body:JSON.stringify({id:this.deviceId,name:this.deviceName,client_type:'web',capabilities:{playback:true,playback_ready:this.ready,seek:true,volume:true,shuffle:true,repeat:true}})});
    this.acceptState(result.state);return result;
  }

  async setReady() { return this.register(true); }
  async devices() { return this.api('/api/v1/connect/devices'); }
  async stateSnapshot() { const state=await this.api('/api/v1/connect/state');this.acceptState(state);return state; }
  async transfer(targetDeviceId,state) { return this.api('/api/v1/connect/transfer',{method:'POST',body:JSON.stringify({source_device_id:this.deviceId,target_device_id:targetDeviceId,state})}); }
  async command(action,payload={}) { return this.api('/api/v1/connect/commands',{method:'POST',body:JSON.stringify({source_device_id:this.deviceId,action,payload})}); }
  updateState(state) {
    const snapshot={device_id:this.deviceId,...state};
    const request=this.stateUpdateChain.catch(()=>{}).then(async()=>{
      if(!this.enabled)return this.state;
      const result=await this.api('/api/v1/connect/state',{method:'PUT',body:JSON.stringify({...snapshot,playback_epoch:Number(this.state?.playback_epoch)||0})});
      this.acceptState(result);return result;
    });
    this.stateUpdateChain=request;return request;
  }

  async poll() {
    if(!this.enabled||this.polling)return;this.polling=true;
    try{
      const result=await this.api(`/api/v1/connect/commands?device_id=${encodeURIComponent(this.deviceId)}&after=${this.lastCommandId}`);
      this.acceptState(result.state);
      for(const command of result.items){
        const commandId=Number(command.id)||0;
        let outcome=this.processedCommands.get(commandId);
        if(!outcome){
          outcome={success:false,result:{error:'Команда не обработана'}};
          const commandEpoch=Number(command.payload?.playback_epoch);
          if(!['transfer','deactivate'].includes(command.action)&&Number.isFinite(commandEpoch)&&commandEpoch!==Number(this.state?.playback_epoch||0))outcome={success:false,result:{error:'Устаревшая эпоха команды'}};
          else try{const value=await this.onCommand(command);outcome=typeof value==='boolean'?{success:value,result:{}}:{success:Boolean(value?.success),result:value?.result||{}};}catch(error){outcome={success:false,result:{error:String(error?.message||error).slice(0,300)}};}
          this.processedCommands.set(commandId,outcome);
        }
        try{
          const acknowledged=await this.api(`/api/v1/connect/commands/${command.id}/ack`,{method:'POST',body:JSON.stringify({device_id:this.deviceId,...outcome})});
          this.acceptState(acknowledged?.state);this.lastCommandId=Math.max(this.lastCommandId,commandId);this.processedCommands.delete(commandId);
        }catch{}
      }
    }catch(error){if(error?.status===404&&error?.code==='connect_disabled')this.stop();}
    finally{this.polling=false;}
  }

  stop() { if(this.timer)clearInterval(this.timer);this.timer=null;this.enabled=false; }
}
