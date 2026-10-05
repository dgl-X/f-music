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
  if (!row) return { active_device_id:null, playback_epoch:0, revision:0, track_id:null, position_seconds:0, duration_seconds:0, queue:[], playing:false, shuffle:false, repeat_mode:'off', volume:null };
  return {
    active_device_id:row.active_device_id,
    playback_epoch:Number(row.playback_epoch || 0),
    revision:Number(row.revision || 0),
    track_id:row.track_id,
    position_seconds:Number(row.position_seconds || 0),
    duration_seconds:Number(row.duration_seconds || 0),
    queue:parseJson(row.queue_json, []),
    playing:Boolean(row.playing),
    shuffle:Boolean(row.shuffle),
    repeat_mode:row.repeat_mode || 'off',
    volume:row.volume == null ? null : Number(row.volume),
    updated_at:row.updated_at,
  };
}

export function validateConnectDevice(input = {}) {
  const id=String(input.id || '').trim(),name=String(input.name || '').trim(),clientType=String(input.client_type || '').trim();
  if (!DEVICE_ID.test(id)) return { error:'Некорректный ID устройства' };
  if (!name || name.length > 80) return { error:'Имя устройства должно содержать от 1 до 80 символов' };
  if (!CLIENT_TYPES.has(clientType)) return { error:'Неизвестный тип Connect-клиента' };
  const capabilities=input.capabilities && typeof input.capabilities === 'object' && !Array.isArray(input.capabilities) ? input.capabilities : {};
  return { id,name,clientType,capabilities };
}

export function createConnectService({ db, enabled = false, commandTtlSeconds = 30, onlineSeconds = 35 }) {
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
    const row=await db.prepare(`INSERT INTO connect_state(user_id,active_device_id,playback_epoch,revision,track_id,position_seconds,duration_seconds,queue_json,playing,shuffle,repeat_mode,volume)
      VALUES(?,?,?,1,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET active_device_id=excluded.active_device_id,playback_epoch=excluded.playback_epoch,revision=connect_state.revision+1,
      track_id=excluded.track_id,position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,queue_json=excluded.queue_json,playing=excluded.playing,shuffle=excluded.shuffle,
      repeat_mode=excluded.repeat_mode,volume=excluded.volume,updated_at=CURRENT_TIMESTAMP
      WHERE (connect_state.active_device_id IS NULL OR connect_state.active_device_id=excluded.active_device_id)
        AND (connect_state.active_device_id IS NULL OR connect_state.playback_epoch=excluded.playback_epoch) RETURNING *`).get(userId,deviceId,playbackEpoch,input.track_id?String(input.track_id):null,position,duration,JSON.stringify(queue),input.playing?1:0,input.shuffle?1:0,repeatMode,volume);
    if(!row)return { status:'not_active',state:await getState(userId) };
    return { status:'ok',state:stateDto(row) };
  }

  async function requestTransfer(userId, sourceDeviceId, targetDeviceId, snapshot = {}) {
    return db.transaction(async tx => {
      if(!await ownDevice(tx,userId,sourceDeviceId)||!await ownDevice(tx,userId,targetDeviceId,{online:true}))return { status:'missing_device' };
      const previous=await tx.prepare('SELECT active_device_id,playback_epoch FROM connect_state WHERE user_id=? FOR UPDATE').get(userId);
      await tx.prepare(`UPDATE connect_commands SET status='superseded',acknowledged_at=CURRENT_TIMESTAMP WHERE user_id=? AND action='transfer' AND status='pending'`).run(userId);
      const command=await tx.prepare(`INSERT INTO connect_commands(user_id,source_device_id,target_device_id,action,payload_json,expires_at)
        VALUES(?,?,?,'transfer',?::jsonb,CURRENT_TIMESTAMP+(? * INTERVAL '1 second')) RETURNING id`).get(userId,sourceDeviceId,targetDeviceId,JSON.stringify({...snapshot,previous_device_id:previous?.active_device_id||sourceDeviceId,playback_epoch:Number(previous?.playback_epoch||0)+1}),commandTtlSeconds);
      return { status:'ok',command_id:Number(command.id) };
    });
  }

  async function sendCommand(userId, sourceDeviceId, action, payload = {}) {
    if(!ACTIONS.has(action))return { status:'invalid',error:'Неизвестная Connect-команда' };
    return db.transaction(async tx => {
      if(!await ownDevice(tx,userId,sourceDeviceId))return { status:'missing_device' };
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
    const rows=await db.prepare(`SELECT id,source_device_id,action,payload_json,created_at FROM connect_commands
      WHERE user_id=? AND target_device_id=? AND status='pending' AND expires_at>CURRENT_TIMESTAMP AND id>? ORDER BY id LIMIT 1`).all(userId,deviceId,Math.max(0,Number(after)||0));
    return rows.map(row=>({id:Number(row.id),source_device_id:row.source_device_id,action:row.action,payload:parseJson(row.payload_json,{}),created_at:row.created_at}));
  }

  async function acknowledge(userId, deviceId, commandId, input = {}) {
    return db.transaction(async tx => {
      const command=await tx.prepare(`SELECT * FROM connect_commands WHERE id=? AND user_id=? AND target_device_id=? FOR UPDATE`).get(commandId,userId,deviceId);
      if(!command)return { status:'missing' };
      if(command.status!=='pending')return { status:'ok',duplicate:true,state:await stateFrom(tx,userId) };
      const success=Boolean(input.success);
      await tx.prepare(`UPDATE connect_commands SET status=?,result_json=?::jsonb,acknowledged_at=CURRENT_TIMESTAMP WHERE id=?`).run(success?'complete':'failed',JSON.stringify(input.result||{}),commandId);
      if(command.action==='transfer'&&success){
        const payload=parseJson(command.payload_json,{}),queue=Array.isArray(payload.queue)?payload.queue.map(String).slice(0,10000):[];
        const repeatMode=REPEAT_MODES.has(payload.repeat_mode)?payload.repeat_mode:'off';
        await tx.prepare(`INSERT INTO connect_state(user_id,active_device_id,playback_epoch,revision,track_id,position_seconds,duration_seconds,queue_json,playing,shuffle,repeat_mode,volume)
          VALUES(?,?,?,1,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET active_device_id=excluded.active_device_id,playback_epoch=excluded.playback_epoch,revision=connect_state.revision+1,
          track_id=excluded.track_id,position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,queue_json=excluded.queue_json,playing=excluded.playing,shuffle=excluded.shuffle,
          repeat_mode=excluded.repeat_mode,volume=excluded.volume,updated_at=CURRENT_TIMESTAMP`).run(userId,deviceId,Math.max(1,Number(payload.playback_epoch)||1),payload.track_id?String(payload.track_id):null,Math.max(0,Number(payload.position_seconds)||0),Math.max(0,Number(payload.duration_seconds)||0),JSON.stringify(queue),payload.playing?1:0,payload.shuffle?1:0,repeatMode,payload.volume==null?null:Math.min(1,Math.max(0,Number(payload.volume)||0)));
        const previous=payload.previous_device_id;
        if(previous&&previous!==deviceId&&await ownDevice(tx,userId,previous)){
          await tx.prepare(`UPDATE connect_commands SET status='superseded',acknowledged_at=CURRENT_TIMESTAMP
            WHERE user_id=? AND target_device_id=? AND status='pending'`).run(userId,previous);
          await tx.prepare(`INSERT INTO connect_commands(user_id,source_device_id,target_device_id,action,payload_json,expires_at)
            VALUES(?,?,?,'deactivate',?::jsonb,CURRENT_TIMESTAMP+(? * INTERVAL '1 second'))`).run(userId,deviceId,previous,JSON.stringify({playback_epoch:Math.max(1,Number(payload.playback_epoch)||1)}),commandTtlSeconds);
        }
      }
      return { status:'ok',state:await stateFrom(tx,userId) };
    });
  }

  return { enabled:Boolean(enabled),registerDevice,listDevices,revokeDevice,getState,updateState,requestTransfer,sendCommand,pollCommands,acknowledge };
}
