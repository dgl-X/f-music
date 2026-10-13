const LOCAL_TRACK_ID = /^[0-9a-f-]{36}$/;
const MAX_QUEUE_ITEMS = 10000;
const MAX_BODY_BYTES = 1024 * 1024;

export function createPlaybackHttpController({ db, decodeRemoteReference, savePlaybackState, readJson, sendJson }) {
  async function getState(res, user) {
    const state = await db.prepare(`SELECT track_id,remote_track_ref,position_seconds,queue_json,shuffle,
      repeat_mode,queue_source,updated_at FROM playback_state WHERE user_id=?`).get(user.id);
    if (!state) {
      sendJson(res, 200, { track_id:null, position_seconds:0, queue:[], shuffle:false, repeat_mode:'off', queue_source:'Очередь' });
      return;
    }
    let queue = [];
    try { queue = JSON.parse(state.queue_json); } catch {}
    sendJson(res, 200, {
      ...state,
      track_id:state.remote_track_ref ? `remote:${state.remote_track_ref}` : state.track_id,
      remote_track_ref:undefined,
      queue,
      queue_json:undefined,
      shuffle:Boolean(state.shuffle),
    });
  }

  async function putState(req, res, user) {
    const body = await readJson(req, MAX_BODY_BYTES);
    const requestedTrackId = body.track_id ? String(body.track_id) : null;
    const remoteTrackRef = requestedTrackId?.startsWith('remote:') ? requestedTrackId.slice(7) : null;
    const trackId = remoteTrackRef ? null : requestedTrackId;
    let decodedRemote = null;
    if (remoteTrackRef) {
      try {
        decodedRemote = decodeRemoteReference(remoteTrackRef);
      } catch {
        sendJson(res, 400, { error:'Некорректный удалённый текущий трек' });
        return;
      }
    }
    const queue = Array.isArray(body.queue)
      ? [...new Set(body.queue.map(String).filter(id => LOCAL_TRACK_ID.test(id) || id.startsWith('remote:')))].slice(0, MAX_QUEUE_ITEMS)
      : [];
    const repeatMode = ['off','all','one'].includes(body.repeat_mode) ? body.repeat_mode : 'off';
    const queueSource = String(body.queue_source || 'Очередь').trim().slice(0, 120) || 'Очередь';
    const position = Math.max(0, Number(body.position_seconds) || 0);
    const saved = await savePlaybackState({
      db,
      userId:user.id,
      trackId,
      remoteTrackRef,
      decodedRemote,
      position,
      queue,
      shuffle:Boolean(body.shuffle),
      repeatMode,
      queueSource,
    });
    if (!saved) {
      sendJson(res, 400, { error:remoteTrackRef ? 'Некорректный удалённый текущий трек' : 'Некорректный текущий трек' });
      return;
    }
    sendJson(res, 200, { ok:true });
  }

  async function handle(req, res, url, user) {
    if (url.pathname !== '/api/playback-state') return false;
    if (req.method === 'GET') {
      await getState(res, user);
      return true;
    }
    if (req.method === 'PUT') {
      await putState(req, res, user);
      return true;
    }
    return false;
  }

  return { handle };
}
