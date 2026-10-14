const DEVICE_ID = /^[a-zA-Z0-9_-]{16,96}$/;
const CLIENT_TYPES = new Set(['web', 'android']);
const ACTIONS = new Set(['play', 'pause', 'seek', 'next', 'previous', 'set_queue', 'set_shuffle', 'set_repeat', 'set_volume']);
const REPEAT_MODES = new Set(['off', 'all', 'one']);

const parseJson = (value, fallback) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

function deviceDto(row) {
  return {
    id:row.id,
    name:row.name,
    client_type:row.client_type,
    capabilities:parseJson(row.capabilities_json, {}),
    online:Boolean(row.online),
    last_seen_at:row.last_seen_at,
  };
}

function stateDto(row) {
  if (!row) return { active_device_id:null, playback_epoch:0, revision:0, track_id:null, position_seconds:0, duration_seconds:0, queue:[], ...normalizeConnectPlayback({playing:false}), shuffle:false, repeat_mode:'off', volume:null };
  return {
    active_device_id:row.active_device_id,
    playback_epoch:Number(row.playback_epoch || 0),
    revision:Number(row.revision || 0),
    track_id:row.track_id,
    position_seconds:Number(row.position_seconds || 0),
    duration_seconds:Number(row.duration_seconds || 0),
    queue:parseJson(row.queue_json, []),
    ...normalizeConnectNavigation(parseJson(row.navigation_json,{}),parseJson(row.queue_json,[])),
    playing:Boolean(row.playing),
    ...normalizeConnectPlayback({...parseJson(row.playback_json,{}),playing:Boolean(row.playing),...(!row.active_device_id?{playback_status:'paused'}:{})}),
    shuffle:Boolean(row.shuffle),
    repeat_mode:row.repeat_mode || 'off',
    volume:row.volume == null ? null : Number(row.volume),
    updated_at:row.updated_at,
  };
}

export function normalizeConnectPlayback(input={}) {
  const playing=Boolean(input.playing);
  const isPlaying=playing&&(typeof input.is_playing==='boolean'?input.is_playing:!input.buffering);
  const buffering=playing&&!isPlaying&&Boolean(input.buffering);
  const status=input.playback_status==='preparing'&&!isPlaying?'preparing':isPlaying?'playing':buffering?'buffering':playing?'waiting':'paused';
  return{playing,is_playing:isPlaying,buffering,playback_status:status};
}

export function normalizeConnectNavigation(input={},queue=[]) {
  const allowed=new Set(queue),seen=new Set();
  const order=(Array.isArray(input.shuffle_order)?input.shuffle_order:[]).filter(id=>allowed.has(id)&&!seen.has(id)&&seen.add(id));
  for(const id of queue)if(!seen.has(id)){seen.add(id);order.push(id);}
  return{shuffle_order:order,playback_history:(Array.isArray(input.playback_history)?input.playback_history:[]).filter(id=>allowed.has(id)).slice(-10000),...(input.queue_source!=null?{queue_source:String(input.queue_source).slice(0,160)}:{})};
}

export function validateConnectDevice(input = {}) {
  const id=String(input.id || '').trim(),name=String(input.name || '').trim(),clientType=String(input.client_type || '').trim();
  if (!DEVICE_ID.test(id)) return { error:'Некорректный ID устройства' };
  if (!name || name.length > 80) return { error:'Имя устройства должно содержать от 1 до 80 символов' };
  if (!CLIENT_TYPES.has(clientType)) return { error:'Неизвестный тип Connect-клиента' };
  const capabilities=input.capabilities && typeof input.capabilities === 'object' && !Array.isArray(input.capabilities) ? input.capabilities : {};
  return { id,name,clientType,capabilities };
}

export function createConnectService({ db, enabled = false, commandTtlSeconds = 30, onlineSeconds = 35, onChange=()=>{} }) {
  function changed(userId){try{Promise.resolve(onChange(userId)).catch(()=>{});}catch{/* Hints must not fail a committed command. */}}
  const notifying=method=>async(userId,...args)=>{
    const result=await method(userId,...args);
    if(result===true||result?.status==='ok'&&!result.duplicate)changed(userId);
    return result;
  };
  async function authorizeEvents({userId,sessionId,deviceId}){
    if(!enabled||!DEVICE_ID.test(deviceId||'')||!sessionId)return false;
    return Boolean(await db.prepare(`SELECT d.id FROM connect_devices d JOIN sessions s ON s.user_id=d.user_id
      LEFT JOIN connect_preferences p ON p.user_id=d.user_id
      WHERE d.id=? AND d.user_id=? AND d.revoked_at IS NULL AND s.id=?
      AND s.expires_at>CURRENT_TIMESTAMP AND COALESCE(p.enabled,TRUE)=TRUE`).get(deviceId,userId,sessionId));
  }
  const settingsDto = userEnabled => ({ enabled:Boolean(enabled && userEnabled), server_enabled:Boolean(enabled), user_enabled:userEnabled });

  async function getSettings(userId) {
    const row=await db.prepare('SELECT enabled FROM connect_preferences WHERE user_id=?').get(userId);
    return settingsDto(row?.enabled !== false);
  }

  async function setSettings(userId, userEnabled) {
    if(typeof userEnabled !== 'boolean')return { status:'invalid' };
    return db.transaction(async tx => {
      await tx.prepare('SELECT user_id FROM connect_state WHERE user_id=? FOR UPDATE').get(userId);
      const previous=await tx.prepare('SELECT enabled FROM connect_preferences WHERE user_id=?').get(userId);
      if((previous?.enabled !== false) === userEnabled)return { status:'ok', settings:settingsDto(userEnabled) };
      const pending=await tx.prepare(`SELECT id FROM connect_commands WHERE user_id=? AND status='pending' AND expires_at>CURRENT_TIMESTAMP
        AND (action='transfer' OR action='activate' OR (action='deactivate' AND payload_json->>'activate_device_id' IS NOT NULL)) LIMIT 1`).get(userId);
      if(pending)return { status:'transfer_pending' };
      await tx.prepare(`INSERT INTO connect_preferences(user_id,enabled) VALUES(?,?)
        ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP`).run(userId,userEnabled);
      await tx.prepare(`UPDATE connect_state SET active_device_id=NULL,playing=0,playback_epoch=playback_epoch+1,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(userId);
      await tx.prepare(`UPDATE connect_commands SET status='cancelled',acknowledged_at=CURRENT_TIMESTAMP WHERE user_id=? AND status='pending'`).run(userId);
      return { status:'ok', settings:settingsDto(userEnabled) };
    });
  }
  async function registerDevice(userId, input) {
    const value=validateConnectDevice(input);if(value.error)return { status:'invalid',error:value.error };
    const owner=await db.prepare('SELECT user_id FROM connect_devices WHERE id=?').get(value.id);
    if(owner&&Number(owner.user_id)!==Number(userId))return { status:'conflict',error:'Этот ID устройства уже используется' };
    const row=await db.prepare(`INSERT INTO connect_devices(id,user_id,name,client_type,capabilities_json,last_seen_at,revoked_at)
      VALUES(?,?,?,?,?::jsonb,CURRENT_TIMESTAMP,NULL)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,client_type=excluded.client_type,capabilities_json=excluded.capabilities_json,last_seen_at=CURRENT_TIMESTAMP,revoked_at=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE connect_devices.user_id=excluded.user_id
      RETURNING id,name,client_type,capabilities_json,last_seen_at,true AS online`).get(value.id,userId,value.name,value.clientType,JSON.stringify(value.capabilities));
    if(!row)return { status:'conflict',error:'Этот ID устройства уже используется' };
    return { status:'ok',device:deviceDto(row),state:await getState(userId) };
  }

  async function listDevices(userId) {
    const rows=await db.prepare(`SELECT id,name,client_type,capabilities_json,last_seen_at,
      (revoked_at IS NULL AND last_seen_at>CURRENT_TIMESTAMP-(? * INTERVAL '1 second')) AS online
      FROM connect_devices WHERE user_id=? AND revoked_at IS NULL ORDER BY online DESC,last_seen_at DESC,id`).all(onlineSeconds,userId);
    return rows.map(deviceDto);
  }

  async function revokeDevice(userId, deviceId) {
    return db.transaction(async tx => {
      const result=await tx.prepare('UPDATE connect_devices SET revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND revoked_at IS NULL').run(deviceId,userId);
      if(!result.changes)return false;
      await tx.prepare(`UPDATE connect_state SET active_device_id=NULL,revision=revision+1,playing=0,updated_at=CURRENT_TIMESTAMP
        WHERE user_id=? AND active_device_id=?`).run(userId,deviceId);
      await tx.prepare(`UPDATE connect_commands SET status='cancelled',acknowledged_at=CURRENT_TIMESTAMP
        WHERE user_id=? AND target_device_id=? AND status='pending'`).run(userId,deviceId);
      return true;
    });
  }

  async function ownDevice(dbLike, userId, deviceId, { online = false } = {}) {
    return dbLike.prepare(`SELECT id FROM connect_devices WHERE id=? AND user_id=? AND revoked_at IS NULL${online?` AND last_seen_at>CURRENT_TIMESTAMP-(${Number(onlineSeconds)} * INTERVAL '1 second')`:''}`).get(deviceId,userId);
  }

  async function getState(userId) {
    return stateDto(await db.prepare('SELECT * FROM connect_state WHERE user_id=?').get(userId));
  }

  async function stateFrom(dbLike, userId) {
    return stateDto(await dbLike.prepare('SELECT * FROM connect_state WHERE user_id=?').get(userId));
  }

  async function releaseOfflineActiveDevice(userId) {
    return db.transaction(async tx => {
      const active=await tx.prepare(`SELECT state.active_device_id,
          (device.id IS NOT NULL AND device.revoked_at IS NULL AND device.last_seen_at>CURRENT_TIMESTAMP-(? * INTERVAL '1 second')) AS online
        FROM connect_state state LEFT JOIN connect_devices device ON device.id=state.active_device_id AND device.user_id=state.user_id
        WHERE state.user_id=? FOR UPDATE OF state`).get(onlineSeconds,userId);
      if(!active?.active_device_id||active.online)return false;
      await tx.prepare(`UPDATE connect_state SET active_device_id=NULL,playing=0,revision=revision+1,updated_at=CURRENT_TIMESTAMP
        WHERE user_id=? AND active_device_id=?`).run(userId,active.active_device_id);
      await tx.prepare(`UPDATE connect_commands SET status='cancelled',acknowledged_at=CURRENT_TIMESTAMP
        WHERE user_id=? AND target_device_id=? AND status='pending'`).run(userId,active.active_device_id);
      return true;
    });
  }

  async function updateState(userId, deviceId, input = {}) {
    if(!await ownDevice(db,userId,deviceId))return { status:'missing_device' };
    const current=await getState(userId);
    if(current.active_device_id&&current.active_device_id!==deviceId)return { status:'not_active',state:current };
    const requestedEpoch=Math.max(0,Number(input.playback_epoch)||0);
    if(current.active_device_id===deviceId&&requestedEpoch!==current.playback_epoch)return { status:'stale_epoch',state:current };
    const playbackEpoch=current.active_device_id?current.playback_epoch:current.playback_epoch+1;
    const queue=Array.isArray(input.queue)?input.queue.map(String).slice(0,10000):current.queue;
    const repeatMode=REPEAT_MODES.has(input.repeat_mode)?input.repeat_mode:current.repeat_mode;
    const position=Math.max(0,Number(input.position_seconds)||0),duration=Math.max(0,Number(input.duration_seconds)||0),volume=input.volume==null?current.volume:Math.min(1,Math.max(0,Number(input.volume)||0));
    const row=await db.prepare(`INSERT INTO connect_state(user_id,active_device_id,playback_epoch,revision,track_id,position_seconds,duration_seconds,queue_json,playing,shuffle,repeat_mode,volume,navigation_json,playback_json)
      VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET active_device_id=excluded.active_device_id,playback_epoch=excluded.playback_epoch,revision=connect_state.revision+1,
      track_id=excluded.track_id,position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,queue_json=excluded.queue_json,playing=excluded.playing,shuffle=excluded.shuffle,
      repeat_mode=excluded.repeat_mode,volume=excluded.volume,navigation_json=excluded.navigation_json,playback_json=excluded.playback_json,updated_at=CURRENT_TIMESTAMP
      WHERE (connect_state.active_device_id IS NULL OR connect_state.active_device_id=excluded.active_device_id)
        AND (connect_state.active_device_id IS NULL OR connect_state.playback_epoch=excluded.playback_epoch) RETURNING *`).get(userId,deviceId,playbackEpoch,input.track_id?String(input.track_id):null,position,duration,JSON.stringify(queue),input.playing?1:0,input.shuffle?1:0,repeatMode,volume,JSON.stringify(normalizeConnectNavigation({...current,...input},queue)),JSON.stringify(normalizeConnectPlayback(input)));
    if(!row)return { status:'not_active',state:await getState(userId) };
    return { status:'ok',state:stateDto(row) };
  }

  async function requestTransfer(userId, sourceDeviceId, targetDeviceId, snapshot = {}) {
    return db.transaction(async tx => {
      if(!await ownDevice(tx,userId,sourceDeviceId)||!await ownDevice(tx,userId,targetDeviceId,{online:true}))return { status:'missing_device' };
      const previous=await tx.prepare('SELECT active_device_id,playback_epoch FROM connect_state WHERE user_id=? FOR UPDATE').get(userId);
      await tx.prepare(`UPDATE connect_commands SET status='superseded',acknowledged_at=CURRENT_TIMESTAMP WHERE user_id=? AND action='transfer' AND status='pending'`).run(userId);
      const target=await tx.prepare('SELECT capabilities_json FROM connect_devices WHERE id=? AND user_id=?').get(targetDeviceId,userId);
      const staged=Boolean(parseJson(target?.capabilities_json,{}).transfer_prepare);
      const command=await tx.prepare(`INSERT INTO connect_commands(user_id,source_device_id,target_device_id,action,payload_json,expires_at)
        VALUES(?,?,?,'transfer',?::jsonb,CURRENT_TIMESTAMP+(? * INTERVAL '1 second')) RETURNING id`).get(userId,sourceDeviceId,targetDeviceId,JSON.stringify({...snapshot,transfer_prepare:staged,previous_device_id:previous?.active_device_id||sourceDeviceId,playback_epoch:Number(previous?.playback_epoch||0)+1}),commandTtlSeconds);
      return { status:'ok',command_id:Number(command.id) };
    });
  }

  async function sendCommand(userId, sourceDeviceId, action, payload = {}) {
    if(!ACTIONS.has(action))return { status:'invalid',error:'Неизвестная Connect-команда' };
    return db.transaction(async tx => {
      if(!await ownDevice(tx,userId,sourceDeviceId))return { status:'missing_device' };
      const transfer=await tx.prepare(`SELECT id FROM connect_commands WHERE user_id=? AND status='pending' AND expires_at>CURRENT_TIMESTAMP
        AND (action='transfer' OR action='activate' OR (action='deactivate' AND payload_json->>'activate_device_id' IS NOT NULL)) LIMIT 1`).get(userId);
      if(transfer)return {status:'transfer_pending'};
      const state=await tx.prepare('SELECT active_device_id,playback_epoch FROM connect_state WHERE user_id=?').get(userId);
      if(!state?.active_device_id)return { status:'no_active_device' };
      if(!await ownDevice(tx,userId,state.active_device_id,{online:true}))return { status:'target_offline' };
      const row=await tx.prepare(`INSERT INTO connect_commands(user_id,source_device_id,target_device_id,action,payload_json,expires_at)
        VALUES(?,?,?,?,?::jsonb,CURRENT_TIMESTAMP+(? * INTERVAL '1 second')) RETURNING id`).get(userId,sourceDeviceId,state.active_device_id,action,JSON.stringify({...payload,playback_epoch:Number(state.playback_epoch||0)}),commandTtlSeconds);
      return { status:'ok',command_id:Number(row.id),target_device_id:state.active_device_id };
    });
  }

  async function pollCommands(userId, deviceId, after = 0) {
    if(!await ownDevice(db,userId,deviceId))return null;
    await db.prepare('UPDATE connect_devices SET last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(deviceId,userId);
    if(await releaseOfflineActiveDevice(userId))changed(userId);
    const rows=await db.prepare(`SELECT id,source_device_id,action,payload_json,created_at FROM connect_commands
      WHERE user_id=? AND target_device_id=? AND status='pending' AND expires_at>CURRENT_TIMESTAMP AND id>? ORDER BY id LIMIT 1`).all(userId,deviceId,Math.max(0,Number(after)||0));
    return rows.map(row=>({id:Number(row.id),source_device_id:row.source_device_id,action:row.action,payload:parseJson(row.payload_json,{}),created_at:row.created_at}));
  }

  async function acknowledge(userId, deviceId, commandId, input = {}) {
    return db.transaction(async tx => {
      // Match transfer's lock order so an ACK cannot deadlock with replacement.
      await tx.prepare('SELECT user_id FROM connect_state WHERE user_id=? FOR UPDATE').get(userId);
      const command=await tx.prepare(`SELECT * FROM connect_commands WHERE id=? AND user_id=? AND target_device_id=? FOR UPDATE`).get(commandId,userId,deviceId);
      if(!command)return { status:'missing' };
      if(command.status!=='pending')return { status:'ok',duplicate:true,state:await stateFrom(tx,userId) };
      if(new Date(command.expires_at).getTime()<=Date.now())return { status:'expired',state:await stateFrom(tx,userId) };
      const success=Boolean(input.success);
      const originalPayload=parseJson(command.payload_json,{});
      if(command.action==='transfer'&&success&&originalPayload.transfer_prepare&&(!input.result?.state||input.result.state.track_id!==originalPayload.track_id||input.result.state.playing))return {status:'invalid',state:await stateFrom(tx,userId)};
      if(command.action==='deactivate'&&success&&originalPayload.activate_device_id&&input.result?.state?.playing)return {status:'invalid',state:await stateFrom(tx,userId)};
      await tx.prepare(`UPDATE connect_commands SET status=?,result_json=?::jsonb,acknowledged_at=CURRENT_TIMESTAMP WHERE id=?`).run(success?'complete':'failed',JSON.stringify(input.result||{}),commandId);
      if(command.action==='transfer'&&success){
        const original=parseJson(command.payload_json,{});
        const actual=input.result?.state;
        const payload={...original,...(actual||{}),playback_epoch:original.playback_epoch};
        const queue=Array.isArray(payload.queue)?payload.queue.map(String).slice(0,10000):[];
        const repeatMode=REPEAT_MODES.has(payload.repeat_mode)?payload.repeat_mode:'off';
        await tx.prepare(`INSERT INTO connect_state(user_id,active_device_id,playback_epoch,revision,track_id,position_seconds,duration_seconds,queue_json,playing,shuffle,repeat_mode,volume,navigation_json,playback_json)
          VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET active_device_id=excluded.active_device_id,playback_epoch=excluded.playback_epoch,revision=connect_state.revision+1,
          track_id=excluded.track_id,position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,queue_json=excluded.queue_json,playing=excluded.playing,shuffle=excluded.shuffle,
          repeat_mode=excluded.repeat_mode,volume=excluded.volume,navigation_json=excluded.navigation_json,playback_json=excluded.playback_json,updated_at=CURRENT_TIMESTAMP`).run(userId,deviceId,Math.max(1,Number(payload.playback_epoch)||1),payload.track_id?String(payload.track_id):null,Math.max(0,Number(payload.position_seconds)||0),Math.max(0,Number(payload.duration_seconds)||0),JSON.stringify(queue),payload.playing?1:0,payload.shuffle?1:0,repeatMode,payload.volume==null?null:Math.min(1,Math.max(0,Number(payload.volume)||0)),JSON.stringify(normalizeConnectNavigation(payload,queue)),JSON.stringify(normalizeConnectPlayback(payload)));
        const previous=original.previous_device_id;
        if(previous&&previous!==deviceId&&await ownDevice(tx,userId,previous)){
          await tx.prepare(`UPDATE connect_commands SET status='superseded',acknowledged_at=CURRENT_TIMESTAMP
            WHERE user_id=? AND target_device_id=? AND status='pending'`).run(userId,previous);
          await tx.prepare(`INSERT INTO connect_commands(user_id,source_device_id,target_device_id,action,payload_json,expires_at)
            VALUES(?,?,?,'deactivate',?::jsonb,CURRENT_TIMESTAMP+(? * INTERVAL '1 second'))`).run(userId,deviceId,previous,JSON.stringify({playback_epoch:Math.max(1,Number(payload.playback_epoch)||1),activate_device_id:original.transfer_prepare?deviceId:null,track_id:payload.track_id,playing:Boolean(original.playing)}),commandTtlSeconds);
        }else if(original.transfer_prepare){
          await tx.prepare(`INSERT INTO connect_commands(user_id,source_device_id,target_device_id,action,payload_json,expires_at)
            VALUES(?,?,?,'activate',?::jsonb,CURRENT_TIMESTAMP+(? * INTERVAL '1 second'))`).run(userId,deviceId,deviceId,JSON.stringify({playback_epoch:payload.playback_epoch,playing:Boolean(original.playing)}),commandTtlSeconds);
        }
      }
      if(command.action==='deactivate'&&success){
        const payload=parseJson(command.payload_json,{}),state=await stateFrom(tx,userId);
        if(payload.activate_device_id===state.active_device_id&&Number(payload.playback_epoch)===state.playback_epoch){
          await tx.prepare(`INSERT INTO connect_commands(user_id,source_device_id,target_device_id,action,payload_json,expires_at)
            VALUES(?,?,?,'activate',?::jsonb,CURRENT_TIMESTAMP+(? * INTERVAL '1 second'))`).run(userId,deviceId,payload.activate_device_id,JSON.stringify({playback_epoch:state.playback_epoch,playing:Boolean(payload.playing),position_seconds:input.result?.state?.track_id===payload.track_id?Number(input.result.state.position_seconds)||0:state.position_seconds}),commandTtlSeconds);
        }
      }
      if(success&&command.action!=='transfer'&&command.action!=='deactivate'&&input.result?.state){
        const actual=input.result.state;
        const current=await stateFrom(tx,userId);
        const navigation=normalizeConnectNavigation({...current,...actual},Array.isArray(actual.queue)?actual.queue.map(String).slice(0,10000):current.queue);
        await tx.prepare(`UPDATE connect_state SET track_id=?,position_seconds=?,duration_seconds=?,playing=?,shuffle=?,repeat_mode=?,navigation_json=?,playback_json=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP
          WHERE user_id=? AND active_device_id=? AND playback_epoch=?`).run(actual.track_id||null,Math.max(0,Number(actual.position_seconds)||0),Math.max(0,Number(actual.duration_seconds)||0),actual.playing?1:0,actual.shuffle?1:0,REPEAT_MODES.has(actual.repeat_mode)?actual.repeat_mode:'off',JSON.stringify(navigation),JSON.stringify(normalizeConnectPlayback(actual)),userId,deviceId,Number(originalPayload.playback_epoch)||0);
      }
      return { status:'ok',state:await stateFrom(tx,userId) };
    });
  }

  return { enabled:Boolean(enabled),getSettings,authorizeEvents,setSettings:notifying(setSettings),registerDevice:notifying(registerDevice),listDevices,revokeDevice:notifying(revokeDevice),getState,updateState:notifying(updateState),requestTransfer:notifying(requestTransfer),sendCommand:notifying(sendCommand),pollCommands,acknowledge:notifying(acknowledge),releaseOfflineActiveDevice:notifying(releaseOfflineActiveDevice) };
}
