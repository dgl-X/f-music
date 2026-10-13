const ROUTES = new Map([
  ['/api/federation/search', new Set(['GET'])],
  ['/api/federation/nodes', new Set(['GET'])],
  ['/api/federation/liked', new Set(['GET'])],
  ['/api/federation/track', new Set(['GET'])],
  ['/api/federation/like', new Set(['PUT', 'DELETE'])],
  ['/api/federation/replica', new Set(['GET', 'POST', 'DELETE'])],
  ['/api/federation/prepare', new Set(['POST'])],
  ['/api/federation/stream', new Set(['GET'])],
]);

export function createFederationUserHttpController({
  db,
  media,
  queueOnlineSql,
  encodeReference,
  decodeReference,
  sourceId,
  removeReplicaFiles,
  readJson,
  sendJson,
}) {
  function decode(res, value) {
    try { return decodeReference(value); }
    catch {
      sendJson(res, 400, { error:'Некорректная ссылка на удалённый трек' });
      return null;
    }
  }

  function availability(row) {
    return row.revoked_at || row.peer_status === 'revoked' || row.status === 'revoked'
      ? 'revoked'
      : row.sync_error || !row.last_synced_at || new Date(row.last_synced_at) < new Date(Date.now() - 10 * 60 * 1000)
        ? 'offline'
        : 'online';
  }

  function remoteTrack(row, apiPrefix, objectId = row.object_id) {
    const remoteRef = encodeReference(row.origin_node_id, objectId);
    return {
      ...row,
      id:`remote:${remoteRef}`,
      remote:true,
      remote_ref:remoteRef,
      stream_url:`${apiPrefix}/federation/stream?ref=${encodeURIComponent(remoteRef)}&quality=original`,
      source_label:row.label || row.endpoint,
    };
  }

  async function search(res, url, user, apiPrefix) {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    const nodeId = String(url.searchParams.get('node_id') || '');
    const queueRequest = url.searchParams.get('queue') === '1';
    const limit = Math.min(queueRequest ? 10000 : 100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    if (query.length < 2 && !nodeId) {
      sendJson(res, 200, { items:[], artists:[], albums:[], total:0, offset, limit, has_more:false });
      return;
    }
    const params = { query:`%${query}%`, node_id:nodeId, limit, offset, user_id:user.id };
    const queueOnline = queueRequest ? `AND ${queueOnlineSql}` : '';
    const filter = `${nodeId ? 'remote.origin_node_id=@node_id AND ' : ''}(remote.title ILIKE @query OR remote.artist ILIKE @query OR remote.album ILIKE @query OR remote.genre ILIKE @query)`;
    const total = Number((await db.prepare(`SELECT count(*) count FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ${queueOnline} AND ${filter}`).get(params)).count);
    const rows = await db.prepare(`SELECT remote.*,peer.endpoint,peer.label,peer.status,peer.last_synced_at,peer.sync_error,peer.stream_unavailable_until,
      (EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=@user_id AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) OR EXISTS(SELECT 1 FROM track_sources source JOIN track_likes local_like ON local_like.track_id=source.track_id WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\n'||remote.object_id AND local_like.user_id=@user_id)) AS liked,
      (peer.sync_error IS NOT NULL OR peer.last_synced_at<CURRENT_TIMESTAMP-INTERVAL '10 minutes' OR peer.stream_unavailable_until>CURRENT_TIMESTAMP) AS offline
      FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ${queueOnline} AND ${filter}
      ORDER BY remote.artist COLLATE NOCASE,remote.album COLLATE NOCASE,remote.disc_number,remote.track_number,remote.title COLLATE NOCASE LIMIT @limit OFFSET @offset`).all(params);
    const items = rows.map(row => ({ ...remoteTrack(row, apiPrefix), read_only:true, stream_available:!row.offline }));
    const artists = await db.prepare(`SELECT remote.origin_node_id,remote.artist AS name,peer.endpoint,peer.label,count(*) track_count FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ${nodeId ? 'AND remote.origin_node_id=@node_id' : ''} AND remote.artist ILIKE @query GROUP BY remote.origin_node_id,remote.artist,peer.endpoint,peer.label ORDER BY track_count DESC LIMIT 100`).all(params);
    const albums = await db.prepare(`SELECT remote.origin_node_id,remote.album AS name,remote.artist,peer.endpoint,peer.label,count(*) track_count,max(remote.year) AS "year" FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' ${nodeId ? 'AND remote.origin_node_id=@node_id' : ''} AND remote.album<>'' AND (remote.album ILIKE @query OR remote.artist ILIKE @query) GROUP BY remote.origin_node_id,remote.album,remote.artist,peer.endpoint,peer.label ORDER BY track_count DESC LIMIT 100`).all(params);
    sendJson(res, 200, { items, artists, albums, total, offset, limit, has_more:offset + items.length < total });
  }

  async function liked(res, url, user, apiPrefix) {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const total = Number((await db.prepare('SELECT count(*) count FROM federation_remote_likes WHERE user_id=?').get(user.id)).count);
    const rows = await db.prepare(`SELECT remote.*,peer.endpoint,peer.label,peer.status peer_status,peer.revoked_at,peer.last_synced_at,peer.sync_error,TRUE AS liked,
      replica.status AS replica_status,replica.received_bytes AS replica_received_bytes,replica.size_bytes AS replica_size_bytes,replica.error AS replica_error
      FROM federation_remote_likes likes JOIN federation_remote_tracks remote ON remote.origin_node_id=likes.origin_node_id AND remote.object_id=likes.object_id
      JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id
      WHERE likes.user_id=? ORDER BY likes.created_at DESC LIMIT ? OFFSET ?`).all(user.id, limit, offset);
    const items = rows.map(row => {
      const state = availability(row);
      return { ...remoteTrack(row, apiPrefix), availability:state, cover_url:null, stream_available:row.replica_status === 'ready' || state === 'online' };
    });
    sendJson(res, 200, { items, total, limit, offset, has_more:offset + items.length < total });
  }

  async function track(res, url, user, apiPrefix) {
    const decoded = decode(res, url.searchParams.get('ref'));
    if (!decoded) return;
    const item = await db.prepare(`SELECT remote.*,peer.endpoint,peer.label,peer.status,peer.last_synced_at,peer.sync_error,
      replica.status AS replica_status,replica.received_bytes AS replica_received_bytes,replica.size_bytes AS replica_size_bytes,replica.error AS replica_error,replica.local_track_id,
      (EXISTS(SELECT 1 FROM federation_remote_likes likes WHERE likes.user_id=@user_id AND likes.origin_node_id=remote.origin_node_id AND likes.object_id=remote.object_id) OR EXISTS(SELECT 1 FROM track_sources source JOIN track_likes local_like ON local_like.track_id=source.track_id WHERE source.source='federation' AND source.source_id=remote.origin_node_id||E'\n'||remote.object_id AND local_like.user_id=@user_id)) AS liked
      FROM federation_remote_tracks remote JOIN federation_peers peer ON peer.node_id=remote.origin_node_id
      LEFT JOIN federation_remote_replicas replica ON replica.origin_node_id=remote.origin_node_id AND replica.object_id=remote.object_id
      WHERE remote.origin_node_id=@node_id AND remote.object_id=@object_id`).get({ user_id:user.id, node_id:decoded.nodeId, object_id:decoded.objectId });
    if (!item) {
      sendJson(res, 404, { error:'Удалённый трек не найден' });
      return;
    }
    const related = await db.prepare(`SELECT object_id,title,artist,album,year,duration_seconds FROM federation_remote_tracks WHERE origin_node_id=? AND object_id<>? AND (artist=? OR (album<>'' AND album=?)) ORDER BY album,disc_number,track_number,title LIMIT 20`).all(item.origin_node_id, item.object_id, item.artist, item.album);
    const state = availability(item);
    sendJson(res, 200, {
      ...remoteTrack(item, apiPrefix), availability:state, read_only:true,
      stream_available:item.replica_status === 'ready' || state === 'online',
      related:related.map(value => ({ ...value, remote_ref:encodeReference(item.origin_node_id, value.object_id) })),
    });
  }

  async function like(req, res, url, user) {
    const decoded = decode(res, url.searchParams.get('ref'));
    if (!decoded) return;
    if (!await db.prepare('SELECT 1 FROM federation_remote_tracks WHERE origin_node_id=? AND object_id=?').get(decoded.nodeId, decoded.objectId)) {
      sendJson(res, 404, { error:'Удалённый трек не найден' });
      return;
    }
    const imported = await db.prepare("SELECT tracks.id FROM track_sources JOIN tracks ON tracks.id=track_sources.track_id WHERE source='federation' AND source_id=?").get(sourceId(decoded.nodeId, decoded.objectId));
    if (imported) {
      if (req.method === 'PUT') await db.prepare('INSERT INTO track_likes(user_id,track_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(user.id, imported.id);
      else await db.prepare('DELETE FROM track_likes WHERE user_id=? AND track_id=?').run(user.id, imported.id);
      sendJson(res, 200, { ok:true, liked:req.method === 'PUT', imported:true, local_track_id:imported.id });
      return;
    }
    if (req.method === 'PUT') await db.transaction(async tx => {
      await tx.prepare('INSERT INTO federation_remote_likes(user_id,origin_node_id,object_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(user.id, decoded.nodeId, decoded.objectId);
      await tx.prepare("INSERT INTO federation_remote_replicas(origin_node_id,object_id,status) VALUES(?,?,'queued') ON CONFLICT(origin_node_id,object_id) DO UPDATE SET status=CASE WHEN federation_remote_replicas.status='ready' THEN 'ready' ELSE 'queued' END,available_at=CURRENT_TIMESTAMP,error=CASE WHEN federation_remote_replicas.status='ready' THEN federation_remote_replicas.error ELSE NULL END,updated_at=CURRENT_TIMESTAMP").run(decoded.nodeId, decoded.objectId);
    });
    else await db.prepare('DELETE FROM federation_remote_likes WHERE user_id=? AND origin_node_id=? AND object_id=?').run(user.id, decoded.nodeId, decoded.objectId);
    sendJson(res, 200, { ok:true, liked:req.method === 'PUT' });
  }

  async function replica(req, res, url, user) {
    const decoded = decode(res, url.searchParams.get('ref'));
    if (!decoded) return;
    const item = await db.prepare('SELECT * FROM federation_remote_replicas WHERE origin_node_id=? AND object_id=?').get(decoded.nodeId, decoded.objectId);
    if (req.method === 'GET') {
      if (!item) sendJson(res, 404, { error:'Задания импорта нет' });
      else sendJson(res, 200, { status:item.status, received_bytes:Number(item.received_bytes || 0), size_bytes:item.size_bytes == null ? null : Number(item.size_bytes), local_track_id:item.local_track_id || null, error:item.error });
      return;
    }
    const ownsLike = async () => Boolean(await db.prepare('SELECT 1 FROM federation_remote_likes WHERE user_id=? AND origin_node_id=? AND object_id=?').get(user.id, decoded.nodeId, decoded.objectId));
    if (req.method === 'POST') {
      if (!await ownsLike()) sendJson(res, 403, { error:'Сначала добавьте трек в «Мне нравится»' });
      else {
        await db.prepare("INSERT INTO federation_remote_replicas(origin_node_id,object_id,status) VALUES(?,?,'queued') ON CONFLICT(origin_node_id,object_id) DO UPDATE SET status='queued',attempts=0,available_at=CURRENT_TIMESTAMP,error=NULL,updated_at=CURRENT_TIMESTAMP").run(decoded.nodeId, decoded.objectId);
        sendJson(res, 202, { ok:true, status:'queued' });
      }
      return;
    }
    if (!item) sendJson(res, 404, { error:'Локальной реплики нет' });
    else if (item.status === 'imported') sendJson(res, 409, { error:'Импорт уже стал обычным локальным треком', local_track_id:item.local_track_id });
    else if (!user.is_admin && !await ownsLike()) sendJson(res, 403, { error:'Удалять реплику может администратор или пользователь, добавивший трек в «Мне нравится»' });
    else if (item.status === 'downloading') sendJson(res, 409, { error:'Реплика сейчас загружается, повторите удаление позже' });
    else {
      removeReplicaFiles(decoded.nodeId, decoded.objectId, item.storage_key);
      await db.prepare("UPDATE federation_remote_replicas SET status='removed',storage_key=NULL,mime_type=NULL,size_bytes=NULL,received_bytes=0,sha256=NULL,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE origin_node_id=? AND object_id=?").run(decoded.nodeId, decoded.objectId);
      sendJson(res, 200, { ok:true });
    }
  }

  async function handle(req, res, url, user, apiPrefix = '/api') {
    if (!ROUTES.get(url.pathname)?.has(req.method)) return false;
    if (url.pathname === '/api/federation/search') await search(res, url, user, apiPrefix);
    else if (url.pathname === '/api/federation/nodes') {
      const items = await db.prepare(`SELECT peer.node_id,peer.label,peer.endpoint,peer.status,peer.last_synced_at,peer.sync_error,peer.stream_failures,peer.stream_unavailable_until,peer.last_stream_error,count(remote.object_id) track_count
        FROM federation_peers peer LEFT JOIN federation_remote_tracks remote ON remote.origin_node_id=peer.node_id
        WHERE peer.revoked_at IS NULL AND peer.status<>'revoked' GROUP BY peer.node_id ORDER BY peer.label,peer.endpoint`).all();
      sendJson(res, 200, { items });
    } else if (url.pathname === '/api/federation/liked') await liked(res, url, user, apiPrefix);
    else if (url.pathname === '/api/federation/track') await track(res, url, user, apiPrefix);
    else if (url.pathname === '/api/federation/like') await like(req, res, url, user);
    else if (url.pathname === '/api/federation/replica') await replica(req, res, url, user);
    else if (url.pathname === '/api/federation/prepare') {
      const body = await readJson(req), quality = ['aac_96', 'aac_192'].includes(body.quality) ? body.quality : 'aac_192';
      const decoded = decode(res, body.ref);
      if (decoded) await media.prepareRemote(req, res, { nodeId:decoded.nodeId, objectId:decoded.objectId, quality });
    } else {
      const decoded = decode(res, url.searchParams.get('ref'));
      const quality = ['original', 'aac_96', 'aac_192'].includes(url.searchParams.get('quality')) ? url.searchParams.get('quality') : 'original';
      if (decoded) await media.proxyRemote(req, res, { nodeId:decoded.nodeId, objectId:decoded.objectId, quality, range:String(req.headers.range || '') });
    }
    return true;
  }

  return { handle };
}
