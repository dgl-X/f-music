const LOCAL_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort client measurements, not an audio/DRM attestation mechanism. */
export class ListeningTracker {
  constructor({api,sample,journal=null,wallNow=()=>Date.now(),now=()=>performance.now(),uuid=()=>crypto.randomUUID(),schedule=callback=>setInterval(callback,1000),cancel=clearInterval}={}){
    Object.assign(this,{api,sample,journal,wallNow,now,uuid,schedule,cancel});
    this.running=false;this.enabled=false;this.generation=0;this.lifecycle=0;this.epoch=0;
    this.entries=new Map();this.current=null;this.previous=null;this.busy=false;this.timer=null;
    this.retryAt=0;this.failures=0;this.lastAttempt=-Infinity;this.lastSettings=-Infinity;this.settingsBusy=false;
    this.scope=null;this.offline=false;this.journalReady=!journal;this.loadingJournal=null;
    this.confirmedAt=0;this.serverOffset=0;this.lastCheckpoint=-Infinity;
    this.lastServerSettings=-Infinity;
  }
  start(){this.stop({preserve:true});this.running=true;this.refreshSettings();this.timer=this.schedule(()=>this.tick());}
  stop({preserve=false,revoke=false}={}){
    if(preserve)this.checkpoint(true,true);
    else if(this.scope)this.clearJournal(this.scope,{generation:this.generation+1,revoke});
    this.running=false;this.lifecycle++;this.epoch++;if(this.timer!==null)this.cancel(this.timer);this.timer=null;
    this.enabled=false;this.generation=0;this.entries.clear();this.current=null;this.previous=null;this.busy=false;this.settingsBusy=false;
    this.scope=null;this.offline=false;this.journalReady=!this.journal;this.loadingJournal=null;
    this.lastSettings=-Infinity;this.retryAt=0;this.failures=0;this.lastAttempt=-Infinity;
    this.lastServerSettings=-Infinity;
  }
  suspend(){
    this.checkpoint(true,true);this.running=false;this.lifecycle++;this.epoch++;
    if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.previous=null;this.busy=false;this.settingsBusy=false;
    // A transfer may commit after pagehide. Reload that durable record on resume;
    // its stale callback must not overwrite it with the pre-transfer RAM snapshot.
    if(this.loadingJournal){this.loadingJournal=null;this.journalReady=false;}
  }
  resume(){
    if(this.running)return;this.running=true;this.lastSettings=-Infinity;this.refreshSettings();
    this.timer=this.schedule(()=>this.tick());
  }
  clearJournal(scope,options){
    try{Promise.resolve(this.journal?.clear(scope,options)).catch(()=>{});}catch{}
  }
  configure(settings){
    if(Number.isSafeInteger(settings.server_time_ms)){
      if(settings.server_time_ms<this.lastServerSettings)return;
      this.lastServerSettings=settings.server_time_ms;
    }
    const enabled=settings.enabled===true,generation=Number(settings.generation)||0;
    const scope=/^[0-9a-f]{64}$/.test(settings.journal_scope||'')?settings.journal_scope:this.scope;
    const changedScope=scope!==this.scope;
    if(changedScope){
      if(this.scope)this.clearJournal(this.scope,{revoke:true});
      this.epoch++;this.entries.clear();this.current=null;this.previous=null;this.busy=false;this.generation=0;
      this.scope=scope;this.journalReady=!this.journal;this.loadingJournal=null;
    }
    if(generation<this.generation)return;
    if(enabled!==this.enabled||generation!==this.generation){
      this.epoch++;this.entries.clear();this.current=null;this.previous=null;this.busy=false;
      this.retryAt=0;this.failures=0;this.lastAttempt=-Infinity;
      if(this.journalReady&&this.scope)this.clearJournal(this.scope,{generation});
    }
    this.enabled=enabled;this.generation=generation;
    this.offline=settings.offline_window_ms===86400000&&this.scope!==null&&Number.isSafeInteger(settings.server_time_ms);
    this.confirmedAt=this.wallNow();this.serverOffset=this.offline?settings.server_time_ms-this.confirmedAt:0;
    if(!enabled||!this.offline){
      if(this.scope)this.clearJournal(this.scope,{generation});
      this.journalReady=true;
    }else if(this.journal&&this.running)this.restoreJournal(settings,{recover:this.journalReady});
    this.checkpoint(true);
  }
  async restoreJournal(settings,{recover=false}={}){
    if(this.loadingJournal)return;
    const token={lifecycle:this.lifecycle,epoch:this.epoch,scope:this.scope};this.loadingJournal=token;
    try{
      const data=await this.journal.load(this.scope,settings,{recover,snapshot:this.snapshot()});
      if(!this.running||token.lifecycle!==this.lifecycle||token.epoch!==this.epoch)return;
      for(const entry of data?.entries||[]){
        const existing=this.entries.get(entry.playback_id);
        if(existing){
          if(existing.track_id===entry.track_id&&existing.started_at_ms===entry.started_at_ms&&existing.device_id===entry.device_id){
            existing.elapsed_ms=Math.max(existing.elapsed_ms,entry.elapsed_ms);existing.acknowledged=Math.max(existing.acknowledged,entry.acknowledged);existing.started||=entry.started;
          }
        }else this.entries.set(entry.playback_id,{...entry,client_type:'web',generation:this.generation,remainder_ms:0,ended:true,endedAt:this.now()});
      }
      while(this.entries.size>128){const id=[...this.entries.keys()].find(id=>this.entries.get(id)!==this.current);if(!id)break;this.entries.delete(id);}
    }catch{}
    finally{
      if(this.loadingJournal===token){this.loadingJournal=null;this.journalReady=true;this.checkpoint(true);}
    }
  }
  checkpoint(force=false,released=false){
    if(!this.journal||!this.scope||!this.enabled||!this.offline||!this.journalReady||this.loadingJournal||!force&&this.now()-this.lastCheckpoint<10000)return;
    this.lastCheckpoint=this.now();
    try{Promise.resolve(this.journal.save(this.scope,this.snapshot(),{released})).catch(()=>{});}catch{}
  }
  snapshot(){
    return{enabled:true,generation:this.generation,confirmed_at:this.confirmedAt,server_offset:this.serverOffset,
      entries:[...this.entries.values()].map(entry=>({playback_id:entry.playback_id,track_id:entry.track_id,device_id:entry.device_id,
        started_at_ms:entry.started_at_ms,elapsed_ms:entry.elapsed_ms,acknowledged:entry.acknowledged,started:entry.started}))};
  }
  async refreshSettings(){
    if(!this.running||this.settingsBusy)return;
    this.settingsBusy=true;this.lastSettings=this.now();const token=this.lifecycle;
    try{const settings=await this.api('/api/v1/statistics/settings');if(this.running&&token===this.lifecycle)this.configure(settings);}
    catch(error){if(token===this.lifecycle&&error.status===401)this.stop({revoke:true});}
    finally{if(token===this.lifecycle)this.settingsBusy=false;}
  }
  interrupt(){this.previous=null;}
  finish(){
    if(this.current){this.current.endedAt=this.now();this.current.ended=true;}
    this.current=null;this.previous=null;this.checkpoint(true);this.pump();
  }
  tick(){
    if(!this.running)return;
    const now=this.now();if(now-this.lastSettings>=30000)this.refreshSettings();
    if(this.offline&&(this.wallNow()-this.confirmedAt>=86400000||this.wallNow()<this.confirmedAt)){
      this.clearJournal(this.scope,{generation:this.generation});this.enabled=false;this.entries.clear();this.current=null;this.previous=null;
    }
    if(!this.enabled||!this.journalReady)return;
    let sample;try{sample=this.sample();}catch{this.interrupt();return;}
    if(this.current&&sample?.trackId!==this.current.track_id)this.finish();
    const eligible=sample?.executing===true&&sample.playing===true&&LOCAL_ID.test(sample.trackId||'')&&Number.isFinite(sample.positionSeconds)&&sample.positionSeconds>=0;
    if(eligible&&!this.current){
      this.current={playback_id:this.uuid(),track_id:sample.trackId,device_id:sample.deviceId||undefined,
        client_type:'web',generation:this.generation,elapsed_ms:0,remainder_ms:0,acknowledged:0,started:false,ended:false,
        started_at_ms:this.wallNow()+this.serverOffset};
      this.entries.set(this.current.playback_id,this.current);
    }
    const previous=this.previous;
    if(eligible&&previous?.eligible&&previous.trackId===sample.trackId&&this.current){
      const wall=(now-previous.now)/1000,rate=Number(sample.rate)||1;
      const delta=sample.positionSeconds-previous.positionSeconds;
      // Large gaps, seeks, rate changes and stalled media do not become listening time.
      if(wall>0&&wall<=15&&rate>=0.25&&rate<=4&&rate===previous.rate&&delta>0&&Math.abs(delta-wall*rate)<=Math.max(0.25,wall*0.05)){
        const measured=wall*1000+this.current.remainder_ms,whole=Math.floor(measured);
        this.current.elapsed_ms+=whole;this.current.remainder_ms=measured-whole;
      }
    }
    this.previous=sample?{eligible,trackId:sample.trackId,positionSeconds:sample.positionSeconds,rate:Number(sample.rate)||1,now}:null;
    for(const [id,entry] of this.entries)if(this.offline?this.wallNow()+this.serverOffset-entry.started_at_ms>=86400000||entry.ended&&entry.started&&entry.acknowledged>=entry.elapsed_ms
      :entry.ended&&(now-entry.endedAt>600000||entry.started&&entry.acknowledged>=entry.elapsed_ms))this.entries.delete(id);
    if(this.current&&!this.entries.has(this.current.playback_id)){this.current=null;this.previous=null;}
    while(this.entries.size>(this.offline?128:16)){const id=[...this.entries].find(([,entry])=>entry!==this.current)?.[0];if(!id)break;this.entries.delete(id);}
    this.checkpoint();
    this.pump();
  }
  drop(entry){this.entries.delete(entry.playback_id);if(this.current===entry){this.current=null;this.previous=null;}}
  pump(){
    if(!this.running||!this.enabled||!this.journalReady||this.busy||this.now()<this.retryAt)return;
    const now=this.now();
    const entry=[...this.entries.values()].find(value=>!value.started||value.elapsed_ms>value.acknowledged&&(value.ended||now-this.lastAttempt>=10000));
    if(!entry)return;
    this.busy=true;this.lastAttempt=now;
    const epoch=this.epoch,elapsed=entry.started?Math.min(entry.elapsed_ms,entry.acknowledged+60000):0;
    const body={playback_id:entry.playback_id,track_id:entry.track_id,device_id:entry.device_id,client_type:'web',generation:entry.generation,elapsed_ms:elapsed};
    if(this.scope)body.journal_scope=this.scope;
    if(this.offline)body.started_at_ms=entry.started_at_ms;
    Promise.resolve().then(()=>epoch===this.epoch&&this.running?this.api('/api/v1/statistics/events',{method:'POST',body:JSON.stringify(body)}):null).then(result=>{
      if(epoch!==this.epoch||!this.running)return;
      if(result.status==='disabled'){this.configure({enabled:false,generation:this.generation});return;}
      if(result.status!=='ok'||!Number.isSafeInteger(result.elapsed_ms)||result.elapsed_ms<elapsed)throw new Error('Invalid listening acknowledgement');
      entry.started=true;entry.acknowledged=Math.max(entry.acknowledged,Number(result.elapsed_ms)||0);
      this.retryAt=this.offline?this.now()+250:0;this.failures=0;
      if(entry.ended&&entry.acknowledged>=entry.elapsed_ms)this.drop(entry);
      this.checkpoint(true);
    }).catch(error=>{
      if(epoch!==this.epoch||!this.running)return;
      if(error.status===401){this.stop({revoke:true});return;}
      if(error.code==='statistics_generation_changed'){this.retryAt=this.now()+1500;this.refreshSettings();return;}
      if(error.status===409){this.drop(entry);this.retryAt=this.now()+1500;this.refreshSettings();this.checkpoint(true);return;}
      if([400,403,404,409,410].includes(error.status)){this.drop(entry);this.checkpoint(true);return;}
      this.retryAt=this.now()+Math.min(30000,1500*2**Math.min(5,this.failures++));
    }).finally(()=>{if(epoch===this.epoch){this.busy=false;this.pump();}});
  }
}
