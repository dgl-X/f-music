import {createHash} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateListeningCounter(value) {
  if(!value||!UUID.test(value.playback_id||'')||!UUID.test(value.track_id||'')||
    !['web','android'].includes(value.client_type)||!Number.isSafeInteger(value.elapsed_ms)||value.elapsed_ms<0||
    value.elapsed_ms>86400000||!Number.isSafeInteger(value.generation)||value.generation<0||
    (value.device_id!==undefined&&!/^[a-zA-Z0-9_-]{16,96}$/.test(value.device_id))||
    (value.started_at_ms!==undefined&&(!Number.isSafeInteger(value.started_at_ms)||value.started_at_ms<0))||
    (value.journal_scope!==undefined&&!/^[0-9a-f]{64}$/.test(value.journal_scope)))return false;
  return true;
}
export function qualifiedListeningThreshold(durationSeconds) {
  return Number.isFinite(Number(durationSeconds))&&Number(durationSeconds)>0?
    Math.max(1,Math.round(Math.min(30000,Number(durationSeconds)*500))):30000;
}
export const OFFLINE_LISTENING_WINDOW_MS=86400000;
export function validOfflineStart(startedAt,serverNow,consentAt,sessionAt) {
  return Number.isSafeInteger(startedAt)&&startedAt>=serverNow-OFFLINE_LISTENING_WINDOW_MS&&startedAt<=serverNow+1000
    &&startedAt>=Math.max(new Date(consentAt).getTime(),new Date(sessionAt).getTime())-1000;
}
const dto=row=>({enabled:Boolean(row?.enabled),generation:Number(row?.generation||0),started_at:row?.started_at||null,
  offline_window_ms:OFFLINE_LISTENING_WINDOW_MS,server_time_ms:Date.now()});

export function createListeningEvents({db,connectEnabled=false,now=()=>Date.now()}) {
  async function journalScope(user){
    const session=await db.prepare('SELECT token_hash FROM sessions WHERE id=? AND user_id=?').get(user.session_id,user.id);
    return session?createHash('sha256').update('family-music/listening-journal/v1\0'+session.token_hash).digest('hex'):null;
  }
  async function settings(userId){return dto(await db.prepare('SELECT enabled,generation,started_at FROM listening_preferences WHERE user_id=?').get(userId));}
  async function lock(tx,userId){
    await tx.prepare('INSERT INTO listening_preferences(user_id) VALUES(?) ON CONFLICT(user_id) DO NOTHING').run(userId);
    return tx.prepare('SELECT enabled,generation,started_at FROM listening_preferences WHERE user_id=? FOR UPDATE').get(userId);
  }
  async function configure(userId,enabled){
    if(typeof enabled!=='boolean')return{status:'invalid'};
    return db.transaction(async tx=>{
      const previous=await lock(tx,userId);
      if(previous.enabled!==enabled)await tx.prepare(`UPDATE listening_preferences SET enabled=?,generation=generation+1,
        started_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE started_at END WHERE user_id=?`).run(enabled,enabled,userId);
      return{status:'ok',settings:dto(await tx.prepare('SELECT enabled,generation,started_at FROM listening_preferences WHERE user_id=?').get(userId))};
    });
  }
  async function clear(userId){
    return db.transaction(async tx=>{
      await lock(tx,userId);
      await tx.prepare('DELETE FROM listening_sessions WHERE user_id=?').run(userId);
      await tx.prepare('DELETE FROM listening_daily WHERE user_id=?').run(userId);
      await tx.prepare(`UPDATE listening_preferences SET generation=generation+1,
        started_at=CASE WHEN enabled THEN CURRENT_TIMESTAMP ELSE NULL END WHERE user_id=?`).run(userId);
      return settingsFrom(tx,userId);
    });
  }
  async function settingsFrom(tx,userId){return dto(await tx.prepare('SELECT enabled,generation,started_at FROM listening_preferences WHERE user_id=?').get(userId));}

  async function record(user,value){
    if(!validateListeningCounter(value))return{status:'invalid'};
    if(value.journal_scope!==undefined&&value.journal_scope!==await journalScope(user))return{status:'conflict'};
    return db.transaction(async tx=>{
      const pref=await lock(tx,user.id);
      if(!pref.enabled)return{status:'disabled'};
      if(value.generation!==pref.generation)return{status:'generation_changed'};
      // Connect controllers must never report time for someone else's executor.
      if(connectEnabled){
        const owner=await tx.prepare(`SELECT s.active_device_id FROM connect_state s
          LEFT JOIN connect_preferences p ON p.user_id=s.user_id
          WHERE s.user_id=? AND COALESCE(p.enabled,TRUE)=TRUE`).get(user.id);
        if(owner?.active_device_id&&owner.active_device_id!==value.device_id)return{status:'not_executor'};
      }
      const existing=await tx.prepare('SELECT * FROM listening_sessions WHERE user_id=? AND playback_id=? FOR UPDATE').get(user.id,value.playback_id);
      if(!existing){
        if(value.elapsed_ms!==0)return{status:'start_required'};
        let startedAt=null;
        if(value.started_at_ms!==undefined){
          const session=await tx.prepare('SELECT created_at FROM sessions WHERE id=? AND user_id=?').get(user.session_id,user.id);
          if(!session||!pref.started_at||!validOfflineStart(value.started_at_ms,now(),pref.started_at,session.created_at))return{status:'invalid_time'};
          startedAt=new Date(Math.min(value.started_at_ms,now())).toISOString();
        }
        const track=await tx.prepare('SELECT duration_seconds FROM tracks WHERE id=? FOR KEY SHARE').get(value.track_id);
        if(!track)return{status:'not_found'};
        const active=await tx.prepare(`SELECT count(*) AS count FROM listening_sessions
          WHERE user_id=? AND received_at>CURRENT_TIMESTAMP-INTERVAL '1 hour'`).get(user.id);
        if(Number(active.count)>=240)return{status:'limit'};
        await tx.prepare(`INSERT INTO listening_sessions(user_id,playback_id,auth_session_id,generation,track_id,client_type,threshold_ms,started_at)
          VALUES(?,?,?,?,?,?,?,COALESCE(?::timestamptz,CURRENT_TIMESTAMP))`).run(user.id,value.playback_id,user.session_id,value.generation,value.track_id,value.client_type,qualifiedListeningThreshold(track.duration_seconds),startedAt);
        return{status:'ok',elapsed_ms:0,qualified:false};
      }
      if(String(existing.auth_session_id)!==String(user.session_id)||existing.track_id!==value.track_id||existing.client_type!==value.client_type||existing.generation!==pref.generation)return{status:'conflict'};
      const age=now()-new Date(existing.started_at).getTime();
      if(age>86400000)return{status:'expired'};
      // Cumulative counters make duplicate, reordered and parallel delivery harmless.
      const delta=value.elapsed_ms-Number(existing.elapsed_ms);
      if(delta<=0)return{status:'ok',elapsed_ms:Number(existing.elapsed_ms),qualified:existing.qualified};
      if(delta>60000||value.elapsed_ms>Math.max(0,age)+1000)return{status:'invalid_time'};
      const qualified=existing.qualified||value.elapsed_ms>=existing.threshold_ms;
      const plays=!existing.qualified&&qualified?1:0;
      await tx.prepare(`UPDATE listening_sessions SET elapsed_ms=?,qualified=?,updated_at=CURRENT_TIMESTAMP
        WHERE user_id=? AND playback_id=?`).run(value.elapsed_ms,qualified,user.id,value.playback_id);
      await tx.prepare(`INSERT INTO listening_daily(user_id,track_id,day,client_type,elapsed_ms,plays)
        VALUES(?,?,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,?,?,?)
        ON CONFLICT(user_id,track_id,day,client_type) DO UPDATE
        SET elapsed_ms=listening_daily.elapsed_ms+excluded.elapsed_ms,plays=listening_daily.plays+excluded.plays`)
        .run(user.id,value.track_id,value.client_type,delta,plays);
      return{status:'ok',elapsed_ms:value.elapsed_ms,qualified};
    });
  }
  async function cleanup(){return db.prepare("DELETE FROM listening_sessions WHERE updated_at<CURRENT_TIMESTAMP-INTERVAL '30 days'").run();}
  return{settings,configure,clear,record,cleanup,journalScope};
}
