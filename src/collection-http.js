const PLAYLIST_PATH = /^\/api\/playlists\/([0-9a-f-]+)$/;
const REMOTE_PLAYLIST_PATH = /^\/api\/playlists\/([0-9a-f-]+)\/remote$/;
const PLAYLIST_TRACK_PATH = /^\/api\/playlists\/([0-9a-f-]+)\/tracks(?:\/([0-9a-f-]+))?$/;

export function createCollectionHttpController({ catalog, db, encodeReference, decodeReference, readJson, sendJson }) {
  function availability(row) {
    if (row.revoked_at || row.peer_status === 'revoked') return 'revoked';
    if (row.sync_error || !row.last_synced_at || new Date(row.last_synced_at) < new Date(Date.now() - 10 * 60 * 1000)) return 'offline';
    return 'online';
  }

  function decode(res, value) {
    try { return decodeReference(value); }
    catch {
      sendJson(res, 400, { error:'Некорректная ссылка на удалённый трек' });
      return null;
    }
  }

  async function playlists(req, res, url, user, apiPrefix) {
    if (url.pathname === '/api/playlists' && req.method === 'GET') {
      sendJson(res, 200, await catalog.listPlaylists({ searchParams:url.searchParams, userId:user.id }));
      return true;
    }
    if (url.pathname === '/api/playlists' && req.method === 'POST') {
      const result = await catalog.createPlaylist({ userId:user.id, input:await readJson(req) });
      if (result.status === 'invalid') sendJson(res, 400, { error:'Введите название плейлиста' });
      else sendJson(res, 201, { id:result.id, title:result.title });
      return true;
    }
    const playlistMatch = PLAYLIST_PATH.exec(url.pathname);
    if (playlistMatch && req.method === 'PATCH') {
      const result = await catalog.updatePlaylist({ userId:user.id, playlistId:playlistMatch[1], input:await readJson(req) });
      if (result.status === 'not_found') sendJson(res, 404, { error:'Плейлист не найден' });
      else if (result.status === 'invalid') sendJson(res, 400, { error:'Введите название плейлиста' });
      else sendJson(res, 200, { ok:true });
      return true;
    }
    if (playlistMatch && req.method === 'DELETE') {
      const deleted = await catalog.deletePlaylist({ userId:user.id, playlistId:playlistMatch[1] });
      sendJson(res, deleted ? 200 : 404, deleted ? { ok:true } : { error:'Плейлист не найден' });
      return true;
    }
    const remoteMatch = REMOTE_PLAYLIST_PATH.exec(url.pathname);
    if (remoteMatch && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      const playlist = await catalog.getOwnedPlaylist({ playlistId:remoteMatch[1], userId:user.id });
      if (!playlist) {
        sendJson(res, 404, { error:'Плейлист не найден' });
        return true;
      }
      if (req.method === 'GET') {
        const rows = await db.prepare(`SELECT remote.*,peer.label,peer.endpoint,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error,replica.status replica_status,replica.received_bytes replica_received_bytes,replica.size_bytes replica_size_bytes,EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=? AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) liked
          FROM federation_playlist_tracks item JOIN federation_remote_tracks remote ON remote.origin_node_id=item.origin_node_id AND remote.object_id=item.object_id JOIN federation_peers peer ON peer.node_id=remote.origin_node_id LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id WHERE item.playlist_id=? ORDER BY item.position`).all(user.id, playlist.id);
        const items = rows.map(row => {
          const ref = encodeReference(row.origin_node_id, row.object_id), state = availability(row);
          return { ...row, id:`remote:${ref}`, remote:true, remote_ref:ref, availability:state, stream_available:row.replica_status === 'ready' || state === 'online', stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(ref)}&quality=original`, cover_url:null, source_label:row.label || row.endpoint };
        });
        sendJson(res, 200, { items });
        return true;
      }
      const decoded = decode(res, url.searchParams.get('ref'));
      if (!decoded) return true;
      if (req.method === 'POST') {
        if (!await db.prepare('SELECT 1 FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(decoded.nodeId, decoded.objectId)) {
          sendJson(res, 404, { error:'Удалённый трек не найден' });
          return true;
        }
        const position = (await db.prepare('SELECT GREATEST(COALESCE((SELECT max(position) FROM playlist_tracks WHERE playlist_id=?),0),COALESCE((SELECT max(position) FROM federation_playlist_tracks WHERE playlist_id=?),0))+1 position').get(playlist.id, playlist.id)).position;
        await db.prepare('INSERT INTO federation_playlist_tracks(playlist_id,origin_node_id,object_id,position) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(playlist.id, decoded.nodeId, decoded.objectId, position);
        await db.prepare('UPDATE playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(playlist.id);
      } else {
        await db.prepare('DELETE FROM federation_playlist_tracks WHERE playlist_id=? AND origin_node_id=? AND object_id=?').run(playlist.id, decoded.nodeId, decoded.objectId);
      }
      sendJson(res, 200, { ok:true });
      return true;
    }
    const tracksMatch = PLAYLIST_TRACK_PATH.exec(url.pathname);
    if (tracksMatch && req.method === 'POST') {
      const result = await catalog.addPlaylistTrack({ userId:user.id, playlistId:tracksMatch[1], trackId:String((await readJson(req)).track_id ?? '') });
      if (result.status === 'playlist_not_found') sendJson(res, 404, { error:'Плейлист не найден' });
      else if (result.status === 'track_not_found') sendJson(res, 404, { error:'Трек не найден' });
      else sendJson(res, 200, { ok:true });
      return true;
    }
    if (tracksMatch && req.method === 'DELETE' && tracksMatch[2]) {
      const result = await catalog.removePlaylistTrack({ userId:user.id, playlistId:tracksMatch[1], trackId:tracksMatch[2] });
      if (result.status === 'playlist_not_found') sendJson(res, 404, { error:'Плейлист не найден' });
      else sendJson(res, 200, { ok:true });
      return true;
    }
    return false;
  }

  async function handle(req, res, url, user, apiPrefix = '/api') {
    if (url.pathname === '/api/history' && req.method === 'POST') {
      const body = await readJson(req);
      const recorded = await catalog.recordHistory({ userId:user.id, trackId:String(body.track_id ?? '') });
      sendJson(res, recorded ? 200 : 404, recorded ? { ok:true } : { error:'Трек не найден' });
      return true;
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {
      sendJson(res, 200, await catalog.listHistory({ searchParams:url.searchParams, userId:user.id, responsePrefix:apiPrefix }));
      return true;
    }
    return playlists(req, res, url, user, apiPrefix);
  }

  return { handle };
}
