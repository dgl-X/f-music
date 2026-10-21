const WINDOW=86400000,MAX_BYTES=131072,LEASE=60000;
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validScope=scope=>/^[0-9a-f]{64}$/.test(scope||'');

export function mergeListeningSnapshots(snapshots,{generation,wallNow,serverNow,serverOffset}){
  const entries=new Map(),conflicts=new Set();
  for(const data of snapshots){
    if(data?.enabled!==true||data.generation!==generation||!Number.isFinite(data.confirmed_at)||
      wallNow-data.confirmed_at<0||wallNow-data.confirmed_at>=WINDOW||!Array.isArray(data.entries)||data.entries.length>128)continue;
    for(const row of data.entries){
      if(!row||!UUID.test(row.playback_id||'')||!UUID.test(row.track_id||'')||
        !Number.isSafeInteger(row.started_at_ms)||row.started_at_ms>serverNow+1000||serverNow-row.started_at_ms>=WINDOW||
        !Number.isSafeInteger(row.elapsed_ms)||row.elapsed_ms<0||row.elapsed_ms>WINDOW||
        !Number.isSafeInteger(row.acknowledged)||row.acknowledged<0||row.acknowledged>row.elapsed_ms||
        row.device_id!==undefined&&!/^[a-zA-Z0-9_-]{16,96}$/.test(row.device_id)||conflicts.has(row.playback_id))continue;
      if(row.started===true&&row.elapsed_ms<=row.acknowledged)continue;
      const entry={playback_id:row.playback_id,track_id:row.track_id,device_id:row.device_id,started_at_ms:row.started_at_ms,
        elapsed_ms:row.elapsed_ms,acknowledged:row.acknowledged,started:row.started===true};
      const old=entries.get(entry.playback_id);
      if(old){
        if(old.track_id!==entry.track_id||old.device_id!==entry.device_id||old.started_at_ms!==entry.started_at_ms){
          entries.delete(entry.playback_id);conflicts.add(entry.playback_id);continue;
        }
        entry.elapsed_ms=Math.max(old.elapsed_ms,entry.elapsed_ms);entry.acknowledged=Math.max(old.acknowledged,entry.acknowledged);
        entry.started||=old.started;
      }
      entries.set(entry.playback_id,entry);
    }
  }
  return{enabled:true,generation,confirmed_at:wallNow,server_offset:serverOffset,
    entries:[...entries.values()].sort((a,b)=>b.started_at_ms-a.started_at_ms).slice(0,128)};
}

/** IndexedDB transactions serialize writers and privacy barriers across tabs. */
export class ListeningJournal {
  constructor({indexedDB=globalThis.indexedDB,now=()=>Date.now(),uuid=()=>crypto.randomUUID()}={}){
    Object.assign(this,{indexedDB,now});this.writer=uuid();this.database=null;
  }
  open(){
    if(!this.database)this.database=new Promise((resolve,reject)=>{
      if(!this.indexedDB){reject(new Error('IndexedDB unavailable'));return;}
      const request=this.indexedDB.open('fm-listening-journal',1);let failed=false;
      request.onupgradeneeded=()=>{
        request.result.createObjectStore('journals',{keyPath:'id'});
        request.result.createObjectStore('barriers',{keyPath:'scope'});
      };
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>{failed=true;reject(new Error('Journal blocked'));};
      request.onsuccess=()=>{
        if(failed){request.result.close();return;}
        request.result.onversionchange=()=>request.result.close();resolve(request.result);
      };
    });
    return this.database;
  }
  async transaction(scope,mutate){
    if(!validScope(scope))throw new Error('Invalid journal scope');
    const database=await this.open();
    return new Promise((resolve,reject)=>{
      const tx=database.transaction(['journals','barriers'],'readwrite');
      const store=tx.objectStore('journals'),barriers=tx.objectStore('barriers');
      const all=store.getAll(),permission=barriers.get(scope),allBarriers=barriers.getAll();let ready=0,result;
      const apply=()=>{if(++ready!==3)return;try{
        for(const row of allBarriers.result.filter(row=>row.scope!==scope).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(255))barriers.delete(row.scope);
        result=mutate({store,barriers,rows:all.result,barrier:permission.result});}
        catch(error){tx.abort();reject(error);}};
      all.onsuccess=apply;permission.onsuccess=apply;allBarriers.onsuccess=apply;
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||new Error('Journal transaction aborted'));
      tx.onerror=()=>{};
    });
  }
  load(scope,settings,{recover=false,snapshot=null}={}){
    return this.transaction(scope,({store,rows,barrier})=>{
      if(barrier?.revoked||settings.generation<(barrier?.generation||0))return null;
      const now=this.now(),claimed=[];
      for(const row of rows){
        if(row.scope!==scope||!Number.isFinite(row.updatedAt)||now-row.updatedAt>=WINDOW||row.updatedAt>now+1000){store.delete(row.id);continue;}
        if(row.writer===this.writer?!recover:row.released||row.leaseUntil<=now)claimed.push(row);
      }
      const context={generation:settings.generation,wallNow:now,serverNow:settings.server_time_ms,serverOffset:settings.server_time_ms-now};
      const data=mergeListeningSnapshots(claimed.map(row=>row.data),context);
      if(recover&&!claimed.length)return data;
      for(const row of claimed)if(row.writer!==this.writer)store.delete(row.id);
      const stored=recover?mergeListeningSnapshots([snapshot,data],context):data;
      store.put(this.record(scope,stored,false));this.trim(store,rows.filter(row=>!claimed.includes(row)));
      return data;
    });
  }
  save(scope,data,{released=false}={}){
    const text=JSON.stringify(data);
    if(text.length>MAX_BYTES)throw new Error('Journal limit exceeded');
    const snapshot=JSON.parse(text);
    return this.transaction(scope,({store,rows,barrier})=>{
      if(barrier?.revoked||snapshot.generation<(barrier?.generation||0))return false;
      store.put(this.record(scope,snapshot,released));this.trim(store,rows);return true;
    });
  }
  clear(scope,{generation=0,revoke=false}={}){
    return this.transaction(scope,({store,barriers,rows,barrier})=>{
      for(const row of rows)if(row.scope===scope)store.delete(row.id);
      if(!barrier&&!rows.some(row=>row.scope===scope)&&generation===0&&!revoke)return;
      barriers.put({scope,generation:Math.max(generation,barrier?.generation||0),revoked:revoke||barrier?.revoked===true,updatedAt:this.now()});
    });
  }
  record(scope,data,released){return{id:`${scope}:${this.writer}`,scope,writer:this.writer,data,
    updatedAt:this.now(),leaseUntil:this.now()+LEASE,released};}
  trim(store,rows){
    const others=rows.filter(row=>row.writer!==this.writer).sort((a,b)=>b.updatedAt-a.updatedAt);
    for(const row of others.slice(15))store.delete(row.id);
  }
}
